// Everything the engine and the routes read from and write to LB-06's schema, in one place.
//
// Three rules hold throughout. A visitor reads only their own incidents, and says so in the query
// itself (`session_key`), so another visitor's incident is simply not found. An incident that has
// expired is not found either, even before the sweep deletes it. And every change to an incident
// happens in a transaction that first locks its row and checks its state, so a late job, a replayed
// approval or two tabs cannot move it twice: the event log it leaves is numbered without gaps.
import { LB06_LIMITS, LB06_STATES } from '@lb/contracts'
import type { Lb06EndReason, Lb06Event, Lb06EventInput, Lb06FaultParams, Lb06IncidentView, Lb06PendingProposal, Lb06Scenario, Lb06State } from '@lb/contracts'
import { and, asc, desc, eq, gt, inArray, lt, lte, notInArray, sql } from 'drizzle-orm'

import { AppError } from '../../../core/errors.ts'
import { healthyStreak } from '../detect/slo.ts'
import { sloViewAt, tickData } from '../detect/tick.ts'
import type { Executor, Lb06Db, Lb06Tx } from '../db/connection.ts'
import { incidentEvents, incidents } from '../db/schema.ts'
import type { StoredInvestigation } from '../db/schema.ts'
import { faultService } from '../sim/deploys.ts'
import type { Remediation } from '../sim/faults.ts'
import { buildWorld } from '../sim/world.ts'
import type { Lb06Deps } from './deps.ts'
import { dailyLimit, release, reserve } from './usage.ts'

/** The states in which an incident is still running. */
export const OPEN_STATES: readonly Lb06State[] = ['baseline', 'detecting', 'investigating', 'awaiting_approval', 'remediating', 'verifying', 'writing_postmortem']
/** The states in which an incident has ended. */
export const ENDED_STATES: readonly Lb06State[] = ['closed', 'aborted', 'failed']

/** The error for an incident that isn't there for this visitor: never made, someone else's, or deleted. */
export function incidentNotFound(): AppError {
  return new AppError(404, 'incident_not_found', 'There is no such incident, or it has been deleted.')
}

/** An incident as it is stored. */
export interface IncidentRow {
  id: string
  sessionKey: string
  origin: 'sample' | 'custom'
  sampleId: string | null
  seed: number
  fault: Lb06Scenario['fault']
  params: Lb06FaultParams
  guard: Lb06IncidentView['guard']
  state: Lb06State
  endReason: Lb06EndReason | null
  minute: number
  nextTickAt: Date
  modelCalls: number
  cached: boolean
  proposalsMade: number
  pendingProposal: Lb06PendingProposal | null
  rerank: boolean
  remediations: Remediation[]
  remediatedAt: number | null
  investigation: StoredInvestigation | null
  alertMinute: number | null
  recoveredMinute: number | null
  attempts: number
  createdAt: Date
  updatedAt: Date
  deadlineAt: Date
  expiresAt: Date
}

/** Narrows the text columns the database stores to the closed lists the code uses. */
function typed(row: typeof incidents.$inferSelect): IncidentRow {
  return {
    ...row,
    origin: row.origin === 'sample' ? 'sample' : 'custom',
    fault: row.fault as Lb06Scenario['fault'],
    guard: row.guard as Lb06IncidentView['guard'],
    state: LB06_STATES.includes(row.state as Lb06State) ? (row.state as Lb06State) : 'failed',
    endReason: row.endReason as Lb06EndReason | null,
    cached: row.cached === 1,
    rerank: row.rerank === 1,
    pendingProposal: row.pendingProposal ?? null,
    investigation: row.investigation ?? null,
  }
}

/** The scenario of a stored incident. */
export function scenarioOf(row: IncidentRow): Lb06Scenario {
  return { seed: row.seed, fault: row.fault, params: row.params, baselineMinutes: LB06_LIMITS.baselineMinutes }
}

/** Selects one incident by id, and by owner when a session is given, unless it has expired. */
export async function readIncident(db: Executor, id: string, moment: Date, sessionKey?: string): Promise<IncidentRow | undefined> {
  const owner = sessionKey === undefined ? undefined : eq(incidents.sessionKey, sessionKey)
  const rows = await db.select().from(incidents).where(and(eq(incidents.id, id), gt(incidents.expiresAt, moment), owner)).limit(1)
  return rows[0] === undefined ? undefined : typed(rows[0])
}

/** Locks one incident's row for the rest of the transaction and returns it, or undefined when there is none. */
export async function lockIncident(tx: Lb06Tx, id: string): Promise<IncidentRow | undefined> {
  const rows = await tx.select().from(incidents).where(eq(incidents.id, id)).for('update').limit(1)
  return rows[0] === undefined ? undefined : typed(rows[0])
}

/** How many incidents are running right now, across every visitor. */
export async function countRunning(db: Executor, moment: Date): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(incidents).where(and(inArray(incidents.state, [...OPEN_STATES]), gt(incidents.expiresAt, moment)))
  return rows[0]?.count ?? 0
}

/** The number of the last event of an incident, or 0. */
export async function lastSeq(db: Executor, incidentId: string): Promise<number> {
  const rows = await db.select({ seq: sql<number>`coalesce(max(${incidentEvents.seq}), 0)::int` }).from(incidentEvents).where(eq(incidentEvents.incidentId, incidentId))
  return rows[0]?.seq ?? 0
}

/** Appends events to an incident's log, numbered after its last one. The caller holds the row's lock, and publishes the events after the commit. */
export async function appendEvents(tx: Lb06Tx, incidentId: string, inputs: readonly Lb06EventInput[], at: Date): Promise<Lb06Event[]> {
  if (inputs.length === 0) return []
  const from = await lastSeq(tx, incidentId)
  if (from + inputs.length > LB06_LIMITS.maxEvents) throw new AppError(409, 'log_full', 'The incident\'s log is full.')
  const events = inputs.map((input, index) => ({ ...input, seq: from + index + 1, at: at.toISOString() }) as Lb06Event)
  await tx.insert(incidentEvents).values(events.map(event => ({ incidentId, seq: event.seq, kind: event.kind, minute: event.minute, at: new Date(event.at), data: event.data })))
  return events
}

/** Reads the events of an incident after a number, oldest first, at most `limit`. */
export async function readEvents(db: Executor, incidentId: string, after: number, limit: number): Promise<Lb06Event[]> {
  const rows = await db.select().from(incidentEvents).where(and(eq(incidentEvents.incidentId, incidentId), gt(incidentEvents.seq, after))).orderBy(asc(incidentEvents.seq)).limit(limit)
  return rows.map(row => ({ seq: row.seq, kind: row.kind, minute: row.minute, at: row.at.toISOString(), data: row.data }) as Lb06Event)
}

/** The kinds of event an incident's log holds, for the evidence index. */
export async function eventKinds(db: Executor, incidentId: string): Promise<string[]> {
  const rows = await db.select({ kind: incidentEvents.kind }).from(incidentEvents).where(eq(incidentEvents.incidentId, incidentId)).groupBy(incidentEvents.kind)
  return rows.map(row => row.kind)
}

/** Turns a stored incident into what the API shows of it, with the SLO as code measures it at its minute. */
export function viewOf(row: IncidentRow, last: number): Lb06IncidentView {
  const scenario = scenarioOf(row)
  const world = buildWorld(scenario, row.remediations, row.minute + 1)
  return {
    id: row.id,
    runId: row.id,
    origin: row.origin,
    sampleId: row.sampleId,
    scenario,
    state: row.state,
    endReason: row.endReason,
    minute: row.minute,
    faultMinute: scenario.baselineMinutes,
    guard: row.guard,
    modelCalls: row.modelCalls,
    cached: row.cached,
    proposalsMade: row.proposalsMade,
    pendingProposal: row.pendingProposal,
    remediations: row.remediations,
    slo: row.minute >= scenario.baselineMinutes ? sloViewAt(world, row.minute) : sloViewAt(world, row.minute),
    healthyStreak: healthyStreak(world, row.minute),
    alertMinute: row.alertMinute,
    recoveredMinute: row.recoveredMinute,
    lastSeq: last,
    createdAt: row.createdAt.toISOString(),
    deadlineAt: row.deadlineAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }
}

/** Reads one incident of a visitor as the API shows it. */
export async function readIncidentView(db: Executor, sessionKey: string, id: string, moment: Date): Promise<Lb06IncidentView | undefined> {
  const row = await readIncident(db, id, moment, sessionKey)
  if (!row) return undefined
  return viewOf(row, await lastSeq(db, id))
}

/** The visitor's incidents, newest first. */
export async function listIncidentViews(db: Executor, sessionKey: string, moment: Date): Promise<Lb06IncidentView[]> {
  const rows = await db.select().from(incidents).where(and(eq(incidents.sessionKey, sessionKey), gt(incidents.expiresAt, moment))).orderBy(desc(incidents.createdAt)).limit(10)
  const views: Lb06IncidentView[] = []
  for (const row of rows) views.push(viewOf(typed(row), await lastSeq(db, row.id)))
  return views
}

/** What a new incident is made from. */
export interface NewIncident {
  // The incident's id, drawn by the service before the injection screen runs, so the screen's call belongs to the incident's run.
  id: string
  sessionKey: string
  origin: 'sample' | 'custom'
  sampleId: string | null
  scenario: Lb06Scenario
  guard: Lb06IncidentView['guard']
  // Model calls spent before the incident starts: the guard's.
  modelCalls: number
}

/** The error for a service that runs as many incidents as it can. */
export function tooManyIncidents(): AppError {
  return new AppError(503, 'too_many_incidents', `${LB06_LIMITS.maxConcurrentIncidents} incidents are running already, which is as many as this demo runs at once. Try again in a few minutes.`, { retryAfterSeconds: 60 })
}

/**
 * Takes the visitor's place for the day, checks the room for one more incident, and stores the
 * incident with its log's opening: the start, the calm baseline's ticks, the fault, and the first
 * minute of the fault. All in one transaction, so a visitor with no place left gets 429 and nothing
 * is stored, and a full service gives the place back.
 */
export async function createIncident(deps: Lb06Deps, input: NewIncident): Promise<{ id: string, events: Lb06Event[] }> {
  const moment = deps.now()
  return deps.db.transaction(async (tx) => {
    if (!(await reserve(tx, input.sessionKey, moment))) throw dailyLimit(moment)
    // The count is taken under the serialising lock of the counter's row of this visitor only; a race across visitors for the last place is bounded by one.
    if ((await countRunning(tx, moment)) >= LB06_LIMITS.maxConcurrentIncidents) throw tooManyIncidents()
    const scenario = input.scenario
    const faultMinute = scenario.baselineMinutes
    const inserted = await tx.insert(incidents).values({
      id: input.id,
      sessionKey: input.sessionKey,
      origin: input.origin,
      sampleId: input.sampleId,
      seed: scenario.seed,
      fault: scenario.fault,
      params: scenario.params,
      guard: input.guard,
      state: 'detecting',
      minute: faultMinute,
      nextTickAt: new Date(moment.getTime() + deps.config.tickMs),
      modelCalls: input.modelCalls,
      createdAt: moment,
      updatedAt: moment,
      deadlineAt: new Date(moment.getTime() + deps.config.maxWallMs),
      expiresAt: new Date(moment.getTime() + deps.config.keptMs),
    }).returning({ id: incidents.id })
    const id = inserted[0]?.id
    if (!id) throw new Error('The incident was not stored.')
    const world = buildWorld(scenario, [], faultMinute + 1)
    const opening: Lb06EventInput[] = [{ kind: 'incident.started', minute: 0, data: scenario }]
    for (let minute = 0; minute < faultMinute; minute += 1) opening.push({ kind: 'tick', minute, data: tickData(world, minute) })
    opening.push({ kind: 'fault.injected', minute: faultMinute, data: { fault: scenario.fault, service: faultService(scenario.fault) } })
    opening.push({ kind: 'tick', minute: faultMinute, data: tickData(world, faultMinute) })
    const events = await appendEvents(tx, id, opening, moment)
    return { id, events }
  })
}

/** Removes an incident that could not be queued, and gives the visitor's place back. */
export async function withdrawIncident(deps: Lb06Deps, id: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const row = await lockIncident(tx, id)
    if (!row) return
    await tx.delete(incidents).where(eq(incidents.id, id))
    await release(tx, row.sessionKey, row.createdAt)
  })
}

/** The columns a change to an incident may set. */
export type IncidentPatch = Partial<Pick<typeof incidents.$inferInsert, 'state' | 'endReason' | 'minute' | 'nextTickAt' | 'modelCalls' | 'cached' | 'proposalsMade' | 'pendingProposal' | 'rerank' | 'remediations' | 'remediatedAt' | 'investigation' | 'alertMinute' | 'recoveredMinute' | 'attempts'>>

/** Applies a change to a locked incident, stamping it. */
export async function patchIncident(tx: Lb06Tx, id: string, patch: IncidentPatch, moment: Date): Promise<void> {
  await tx.update(incidents).set({ ...patch, updatedAt: moment }).where(eq(incidents.id, id))
}

/** Counts a start of the incident's job, and returns the count. */
export async function countAttempt(db: Lb06Db, id: string): Promise<number> {
  const rows = await db.update(incidents).set({ attempts: sql`${incidents.attempts} + 1` }).where(eq(incidents.id, id)).returning({ attempts: incidents.attempts })
  return rows[0]?.attempts ?? 0
}

/** Deletes the incidents whose day is up, with their logs. Returns how many. */
export async function deleteExpired(db: Executor, moment: Date): Promise<number> {
  const removed = await db.delete(incidents).where(lte(incidents.expiresAt, moment)).returning({ id: incidents.id })
  return removed.length
}

/** The running incidents that have shown no sign of life for `staleAfterMs`: their job is gone. */
export async function listStaleIncidents(db: Executor, moment: Date, staleAfterMs: number): Promise<string[]> {
  const cutoff = new Date(moment.getTime() - staleAfterMs)
  const rows = await db.select({ id: incidents.id }).from(incidents).where(and(inArray(incidents.state, [...OPEN_STATES]), lt(incidents.updatedAt, cutoff), gt(incidents.expiresAt, moment))).limit(50)
  return rows.map(row => row.id)
}

/** The ended incidents, for a test or the owner's tools. */
export async function listEnded(db: Executor, moment: Date): Promise<string[]> {
  const rows = await db.select({ id: incidents.id }).from(incidents).where(and(notInArray(incidents.state, [...OPEN_STATES]), gt(incidents.expiresAt, moment))).limit(50)
  return rows.map(row => row.id)
}
