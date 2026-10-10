// Everything the engine and the routes read from and write to LB-07's schema, in one place. Three rules
// hold throughout. A visitor reads only their own runs, and says so in the query itself, so another
// visitor's run is simply not found. A run that has expired is not found either, even before the sweep
// deletes it. And the worker's writes refuse to touch a run that has ended, so a retry or a late job can
// never undo a finished run or fail it twice.
import { LB07_FAILURE_MESSAGES, lb07BugListSchema } from '@lb/contracts'
import type { Lb07BugId, Lb07EvidenceView, Lb07FailureCode, Lb07Finding, Lb07Report, Lb07RunView, Lb07State, Lb07Step, Lb07StepView, Lb07TestView, Lb07Verdict } from '@lb/contracts'
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, sql } from 'drizzle-orm'

import { AppError } from '../../../core/errors.ts'
import type { EvidenceRecord, MachineResult } from '../agent/machine.ts'
import { testFilename } from '../agent/testgen.ts'
import { workingSchema } from '../agent/working.ts'
import type { Working } from '../agent/working.ts'
import type { Executor, Lb07Db } from '../db/connection.ts'
import { evidence, findings, reports, runs, runSteps } from '../db/schema.ts'
import type { Lb07Deps } from './deps.ts'
import { REFUNDED } from './failures.ts'
import { dailyLimit, release, reserve } from './usage.ts'

/** The states in which a run is still being worked on. */
export const OPEN_STATES: readonly Lb07State[] = ['queued', 'planning', 'running', 'replanning', 'cross_checking', 'reporting', 'verifying']

// The name of the advisory lock every start of a run takes, hashed by Postgres into the lock's key.
const START_LOCK = 'lb07.start-run'

/** The error for a run that is not there for this visitor: never made, someone else's, deleted or past its hour. */
export function runNotFound(): AppError {
  return new AppError(404, 'run_not_found', 'There is no such run, or it has been deleted.')
}

/** The error for a run that has not finished yet. */
export function notReady(): AppError {
  return new AppError(409, 'not_ready', 'This run is not finished yet.')
}

/** The error for a run that failed: there is no report and no test to show. */
export function runFailed(): AppError {
  return new AppError(409, 'run_failed', 'This run failed, so there is no report to show.')
}

/** The error for a system whose browser is spoken for: too many runs are queued already. */
export function busy(): AppError {
  return new AppError(503, 'busy', 'The browser is busy with other visitors\' runs right now. Try again in a minute.', { retryAfterSeconds: 60 })
}

/** A run as it is stored, with what a route or the worker needs of it. */
export interface RunRow {
  id: string
  sessionKey: string
  origin: 'sample' | 'custom'
  sampleId: string | null
  goal: string
  bugs: Lb07BugId[]
  state: Lb07State
  failureCode: Lb07FailureCode | null
  reading: string | null
  modelCalls: number
  replans: number
  findingsCount: number
  createdAt: Date
  startedAt: Date | null
  endedAt: Date | null
  expiresAt: Date
}

const RUN_COLUMNS = {
  id: runs.id,
  sessionKey: runs.sessionKey,
  origin: runs.origin,
  sampleId: runs.sampleId,
  goal: runs.goal,
  bugs: runs.bugs,
  state: runs.state,
  failureCode: runs.failureCode,
  reading: runs.reading,
  modelCalls: runs.modelCalls,
  replans: runs.replans,
  findingsCount: runs.findingsCount,
  createdAt: runs.createdAt,
  startedAt: runs.startedAt,
  endedAt: runs.endedAt,
  expiresAt: runs.expiresAt,
} as const

/** Narrows the text columns the database stores to the closed lists the code uses. */
function typed(row: Awaited<ReturnType<typeof selectRun>>[number]): RunRow {
  const bugs = lb07BugListSchema.safeParse(row.bugs)
  return { ...row, origin: row.origin === 'sample' ? 'sample' : 'custom', state: row.state as Lb07State, failureCode: row.failureCode as Lb07FailureCode | null, bugs: bugs.success ? bugs.data : [] }
}

/** Selects one run by id, and by owner when a session is given, unless it has expired. */
function selectRun(db: Executor, id: string, moment: Date, sessionKey?: string) {
  const owner = sessionKey === undefined ? undefined : eq(runs.sessionKey, sessionKey)
  return db.select(RUN_COLUMNS).from(runs).where(and(eq(runs.id, id), gt(runs.expiresAt, moment), owner)).limit(1)
}

/** Reads a run's steps as the API shows them. */
async function stepViews(db: Executor, id: string): Promise<Lb07StepView[]> {
  const rows = await db.select({ index: runSteps.index, plan: runSteps.plan, step: runSteps.step, status: runSteps.status, outcome: runSteps.outcome, durationMs: runSteps.durationMs }).from(runSteps).where(eq(runSteps.runId, id)).orderBy(asc(runSteps.index))
  return rows.map(row => ({ index: row.index, plan: row.plan, step: row.step, status: row.status as Lb07StepView['status'], outcome: row.outcome as Lb07StepView['outcome'], durationMs: row.durationMs }))
}

/** How many runs are ahead of a queued run: the runs still open that were made before it. */
async function queuePositionOf(db: Executor, row: RunRow, moment: Date): Promise<number | null> {
  if (row.state !== 'queued') return null
  const [count] = await db.select({ count: sql<number>`count(*)::int` }).from(runs).where(and(inArray(runs.state, [...OPEN_STATES]), lt(runs.createdAt, row.createdAt), gt(runs.expiresAt, moment)))
  return Math.min(count?.count ?? 0, 4)
}

/** Turns a stored run into what the API shows of it. */
async function viewOf(db: Executor, row: RunRow, moment: Date): Promise<Lb07RunView> {
  return {
    id: row.id,
    runId: row.id,
    origin: row.origin,
    sampleId: row.sampleId,
    goal: row.goal,
    bugs: row.bugs,
    state: row.state,
    failure: row.failureCode === null ? null : { code: row.failureCode, message: LB07_FAILURE_MESSAGES[row.failureCode] },
    queuePosition: await queuePositionOf(db, row, moment),
    reading: row.reading,
    steps: await stepViews(db, row.id),
    replans: row.replans,
    modelCalls: Math.min(row.modelCalls, 8),
    findings: Math.min(row.findingsCount, 40),
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  }
}

/** What a new run is made from. */
export interface NewRun {
  sessionKey: string
  origin: 'sample' | 'custom'
  sampleId: string | null
  goal: string
  bugs: readonly Lb07BugId[]
}

/** Counts the runs that are queued or running, for the busy check. */
export async function countOpenRuns(db: Executor, moment: Date): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(runs).where(and(inArray(runs.state, [...OPEN_STATES]), gt(runs.expiresAt, moment)))
  return row?.count ?? 0
}

/**
 * Takes the visitor's place for the day and stores the run, in one transaction: a visitor with no place left gets 429 and
 * nothing is stored; a system with its queue full gets 503 and no place is taken. The transaction first takes a lock that
 * every start takes (a Postgres advisory lock, released when it commits), so starts that arrive together count the open
 * runs one after another: without it, twenty at once each counted the same empty queue and ten got in where four may.
 */
export async function createRun(deps: Lb07Deps, input: NewRun): Promise<string> {
  const moment = deps.now()
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${START_LOCK}))`)
    if (await countOpenRuns(tx, moment) >= deps.config.maxQueued) throw busy()
    if (!(await reserve(tx, input.sessionKey, moment))) throw dailyLimit(moment)
    const [created] = await tx.insert(runs).values({
      sessionKey: input.sessionKey,
      origin: input.origin,
      sampleId: input.sampleId,
      goal: input.goal,
      bugs: [...input.bugs],
      createdAt: moment,
      updatedAt: moment,
      expiresAt: new Date(moment.getTime() + deps.config.keptMs),
    }).returning({ id: runs.id })
    if (!created) throw new Error('A run was not created.')
    return created.id
  })
}

/** Removes a run that was stored but could not be queued, and gives its place back. */
export async function withdrawRun(deps: Lb07Deps, id: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [gone] = await tx.delete(runs).where(eq(runs.id, id)).returning({ sessionKey: runs.sessionKey, createdAt: runs.createdAt })
    if (gone) await release(tx, gone.sessionKey, gone.createdAt)
  })
}

/** Reads a visitor's run as the API shows it, or undefined when it is not theirs, not there or expired. */
export async function readRunView(db: Executor, sessionKey: string, id: string, moment: Date): Promise<Lb07RunView | undefined> {
  const [row] = await selectRun(db, id, moment, sessionKey)
  return row === undefined ? undefined : viewOf(db, typed(row), moment)
}

/** Lists a visitor's runs, newest first, that have not expired (at most ten). */
export async function listRunViews(db: Executor, sessionKey: string, moment: Date): Promise<Lb07RunView[]> {
  const rows = await db.select(RUN_COLUMNS).from(runs).where(and(eq(runs.sessionKey, sessionKey), gt(runs.expiresAt, moment))).orderBy(desc(runs.createdAt)).limit(10)
  return Promise.all(rows.map(row => viewOf(db, typed(row), moment)))
}

/** Reads a worker's view of a run (no session scoping). */
export async function readRunForWork(db: Executor, id: string, moment: Date): Promise<RunRow | undefined> {
  const [row] = await selectRun(db, id, moment)
  return row === undefined ? undefined : typed(row)
}

/** Reads what an earlier attempt saved of the agent, or a fresh start. */
export async function readWorking(db: Executor, id: string): Promise<Working> {
  const [row] = await db.select({ working: runs.working }).from(runs).where(eq(runs.id, id)).limit(1)
  const parsed = workingSchema.safeParse(row?.working)
  return parsed.success ? parsed.data : { calls: 0 }
}

/** Counts one more start of a run that is still open, and returns how many it has had: 0 when it has ended or is gone, so the job does nothing. */
export async function countAttempt(db: Executor, id: string, moment: Date): Promise<number> {
  const [row] = await db.update(runs).set({ attempts: sql`${runs.attempts} + 1`, startedAt: sql`coalesce(${runs.startedAt}, ${moment})` }).where(and(eq(runs.id, id), inArray(runs.state, [...OPEN_STATES]))).returning({ attempts: runs.attempts })
  return row?.attempts ?? 0
}

/** Lists the runs that have waited longer than `maxWaitMs` in the queue without a worker ever starting them, for the sweep to end. */
export async function listOverdueQueued(db: Executor, moment: Date, maxWaitMs: number): Promise<string[]> {
  const cutoff = new Date(moment.getTime() - maxWaitMs)
  const rows = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.state, 'queued'), isNull(runs.startedAt), lt(runs.createdAt, cutoff), gt(runs.expiresAt, moment))).limit(100)
  return rows.map(row => row.id)
}

/**
 * Ends a run that waited too long in the queue as `runner_unavailable` and gives the visitor's place back, once, in one
 * transaction. The update holds only while no worker has started the run: a worker's start and this ending are each one
 * statement on the run's row, so exactly one of them wins. Returns whether this call ended it.
 */
export async function abandonQueuedRun(db: Lb07Db, id: string, moment: Date, maxWaitMs: number): Promise<boolean> {
  const cutoff = new Date(moment.getTime() - maxWaitMs)
  return db.transaction(async (tx) => {
    const [row] = await tx.update(runs).set({ state: 'failed', failureCode: 'runner_unavailable', updatedAt: moment, endedAt: moment, working: null }).where(and(eq(runs.id, id), eq(runs.state, 'queued'), isNull(runs.startedAt), lt(runs.createdAt, cutoff))).returning({ sessionKey: runs.sessionKey, createdAt: runs.createdAt })
    if (!row) return false
    await release(tx, row.sessionKey, row.createdAt)
    return true
  })
}

/** Moves an open run to a state the visitor sees. Returns false when it has ended or is gone. */
export async function setState(db: Executor, id: string, state: Exclude<Lb07State, 'queued' | 'done' | 'failed'>, moment: Date): Promise<boolean> {
  const moved = await db.update(runs).set({ state, updatedAt: moment }).where(and(eq(runs.id, id), inArray(runs.state, [...OPEN_STATES]), gt(runs.expiresAt, moment))).returning({ id: runs.id })
  return moved.length > 0
}

/** Saves what the agent has worked out and paid for, and the counts the visitor sees. */
export async function saveWorking(db: Executor, id: string, working: Working, moment: Date): Promise<void> {
  await db.update(runs).set({ working, modelCalls: working.calls, reading: working.reading ?? null, updatedAt: moment }).where(and(eq(runs.id, id), inArray(runs.state, [...OPEN_STATES])))
}

/** Replaces the run's step list with the agent's current one, in one transaction. A retry's new pass starts the list over. */
export async function replaceSteps(db: Lb07Db, id: string, views: readonly Lb07StepView[], moment: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(runSteps).where(eq(runSteps.runId, id))
    if (views.length > 0) await tx.insert(runSteps).values(views.map(view => ({ runId: id, index: view.index, plan: view.plan, step: view.step, status: view.status, outcome: view.outcome, durationMs: view.durationMs })))
    await tx.update(runs).set({ updatedAt: moment }).where(eq(runs.id, id))
  })
}

/** Forgets the findings and evidence of an earlier attempt, so a pass run again starts clean. */
export async function clearFindings(db: Lb07Db, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(findings).where(eq(findings.runId, id))
    await tx.delete(evidence).where(eq(evidence.runId, id))
    await tx.update(runs).set({ findingsCount: 0 }).where(eq(runs.id, id))
  })
}

/** Stores one finding and counts it. */
export async function addFinding(db: Lb07Db, id: string, finding: Lb07Finding, moment: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(findings).values({ runId: id, id: finding.id, kind: finding.kind, engine: finding.engine, stepIndex: finding.stepIndex, title: finding.title, detail: finding.detail, rule: finding.rule, path: finding.path, evidenceIds: finding.evidenceIds }).onConflictDoNothing()
    await tx.update(runs).set({ findingsCount: sql`${runs.findingsCount} + 1`, updatedAt: moment }).where(eq(runs.id, id))
  })
}

/** Stores one piece of evidence. */
export async function addEvidence(db: Executor, id: string, record: EvidenceRecord, moment: Date): Promise<void> {
  await db.insert(evidence).values({ runId: id, id: record.id, kind: record.kind, engine: record.engine, stepIndex: record.stepIndex, image: record.image ?? null, text: record.text ?? null, createdAt: moment }).onConflictDoNothing()
}

/** Builds the report the API shows from what the agent came to. */
export function reportOf(row: RunRow, result: MachineResult): Lb07Report {
  return {
    runId: row.id,
    goal: row.goal,
    bugs: row.bugs,
    reading: result.reading ?? null,
    findings: result.findings,
    findingsDropped: result.findingsDropped,
    reports: result.reports,
    reportsDropped: result.reportsDropped,
    verification: result.verification,
    engines: result.engines,
    modelCalls: Math.min(result.modelCalls, 8),
    replans: result.replans,
    durationMs: result.durationMs,
  }
}

/** Stores the report, the test and the final plan, and ends the run as done, once. Returns false when it had already ended. */
export async function completeRun(db: Lb07Db, row: RunRow, result: MachineResult, moment: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const ended = await tx.update(runs).set({ state: 'done', updatedAt: moment, endedAt: moment, working: null, modelCalls: result.modelCalls, replans: result.replans, reading: result.reading ?? null, finalPlan: result.finalPlan, findingsCount: result.findings.length }).where(and(eq(runs.id, row.id), inArray(runs.state, [...OPEN_STATES]))).returning({ id: runs.id })
    if (ended.length === 0) return false
    await tx.insert(reports).values({ runId: row.id, report: reportOf(row, result), testSource: result.testSource, verdict: result.verification.verdict, createdAt: moment }).onConflictDoNothing()
    return true
  })
}

/** Ends a run as failed, once, and gives the visitor's place back when the failure was the system's. Returns false when it had already ended or is gone. */
export async function failRun(db: Lb07Db, id: string, code: Lb07FailureCode, moment: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.update(runs).set({ state: 'failed', failureCode: code, updatedAt: moment, endedAt: moment, working: null }).where(and(eq(runs.id, id), inArray(runs.state, [...OPEN_STATES]))).returning({ sessionKey: runs.sessionKey, createdAt: runs.createdAt })
    if (!row) return false
    if (REFUNDED.has(code)) await release(tx, row.sessionKey, row.createdAt)
    return true
  })
}

/** Picks the error for a run that has nothing to show yet. */
function nothingToShow(state: Lb07State): AppError {
  return state === 'failed' ? runFailed() : notReady()
}

/** Reads the finished report of a visitor's run. */
export async function readReportView(db: Executor, sessionKey: string, id: string, moment: Date): Promise<Lb07Report> {
  const [owned] = await selectRun(db, id, moment, sessionKey)
  if (!owned) throw runNotFound()
  const [stored] = await db.select({ report: reports.report }).from(reports).where(eq(reports.runId, id)).limit(1)
  if (!stored) throw nothingToShow(typed(owned).state)
  return stored.report
}

/** Reads the generated test of a visitor's finished run. */
export async function readTestView(db: Executor, sessionKey: string, id: string, moment: Date): Promise<Lb07TestView> {
  const [owned] = await selectRun(db, id, moment, sessionKey)
  if (!owned) throw runNotFound()
  const [stored] = await db.select({ source: reports.testSource, verdict: reports.verdict }).from(reports).where(eq(reports.runId, id)).limit(1)
  if (!stored) throw nothingToShow(typed(owned).state)
  return { filename: testFilename(typed(owned).goal), language: 'typescript', source: stored.source, verdict: stored.verdict as Lb07Verdict }
}

/** Reads one piece of evidence of a visitor's run. */
export async function readEvidenceView(db: Executor, sessionKey: string, id: string, evidenceId: string, moment: Date): Promise<Lb07EvidenceView> {
  const [owned] = await selectRun(db, id, moment, sessionKey)
  if (!owned) throw runNotFound()
  const [row] = await db.select({ kind: evidence.kind, engine: evidence.engine, stepIndex: evidence.stepIndex, image: evidence.image, text: evidence.text }).from(evidence).where(and(eq(evidence.runId, id), eq(evidence.id, evidenceId))).limit(1)
  if (!row) throw new AppError(404, 'evidence_not_found', 'This run has no such evidence.')
  const engine = row.engine === 'firefox-ua' ? 'firefox-ua' : 'chromium'
  if (row.kind === 'screenshot') return { id: evidenceId, kind: 'screenshot', contentType: 'image/png', base64: (row.image ?? Buffer.alloc(0)).toString('base64'), stepIndex: row.stepIndex, engine }
  return { id: evidenceId, kind: 'snapshot', text: row.text ?? '', stepIndex: row.stepIndex, engine }
}

/** Deletes a visitor's own run now, with everything that belongs to it. It does not give the place back. */
export async function deleteRunOf(db: Executor, sessionKey: string, id: string): Promise<boolean> {
  const gone = await db.delete(runs).where(and(eq(runs.id, id), eq(runs.sessionKey, sessionKey))).returning({ id: runs.id })
  return gone.length > 0
}

/** Deletes every run whose hour is up, with everything that belongs to it. Returns how many. */
export async function deleteExpired(db: Executor, moment: Date): Promise<number> {
  const gone = await db.delete(runs).where(lte(runs.expiresAt, moment)).returning({ id: runs.id })
  return gone.length
}

/** Lists the runs still open that have shown no sign of life for `staleAfterMs`, for the sweep to queue again. */
export async function listStaleRuns(db: Executor, moment: Date, staleAfterMs: number): Promise<string[]> {
  const cutoff = new Date(moment.getTime() - staleAfterMs)
  const rows = await db.select({ id: runs.id }).from(runs).where(and(inArray(runs.state, [...OPEN_STATES]), lt(runs.updatedAt, cutoff), gt(runs.expiresAt, moment))).limit(100)
  return rows.map(row => row.id)
}

/** The final plan of a finished run, for tests and the eval. */
export async function readFinalPlan(db: Executor, id: string): Promise<Lb07Step[]> {
  const [row] = await db.select({ finalPlan: runs.finalPlan }).from(runs).where(eq(runs.id, id)).limit(1)
  return row?.finalPlan ?? []
}
