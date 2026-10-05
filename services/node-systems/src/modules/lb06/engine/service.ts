// What a visitor's requests do, above the store: start an incident (after the injection screen on
// the visitor's own words), answer the pending proposal, and abort. The routes are thin; the rules
// are here. Nothing here changes the shop except through the visitor's approval, which is a
// server-side transition checked against the pending proposal's id: a replayed or forged approval
// matches nothing and does nothing.
import { randomUUID } from 'node:crypto'

import { gatewayErrorOf, runScope } from '@lb/common'
import { LB06_LIMITS } from '@lb/contracts'
import type { Lb06Event, Lb06EventInput, Lb06FaultParams, Lb06IncidentView, Lb06Scenario, Lb06StartIncidentRequest } from '@lb/contracts'

import { AppError } from '../../../core/errors.ts'
import { gaussian } from '../sim/random.ts'
import type { Lb06Deps } from './deps.ts'
import { ENDED_STATES, appendEvents, createIncident, incidentNotFound, lockIncident, patchIncident, readIncident, readIncidentView, viewOf, withdrawIncident } from './store.ts'
import type { IncidentRow } from './store.ts'
import { recordIncidentEnd, runOf } from './trace.ts'

// What replaces a visitor's parameter the injection screen flagged: a label that fits the pattern and says what happened.
const SCREENED_LABEL = 'screened-by-guard'

/** The error for a service that has no way to reach the model gateway. */
function noGateway(): AppError {
  return new AppError(503, 'agents_unavailable', 'This service has no connection to the model gateway.')
}

/** A seed drawn for a visitor who gave none: from the clock, so two incidents differ, and bounded. */
function drawSeed(moment: Date): number {
  return Math.floor(gaussian(moment.getTime() % 2_147_483_647, 'seed') * 1_000_000 + 1_000_000) % 2_147_483_647
}

/** The scenario a request asks for: a sample's, or the visitor's own fault with its seed and parameters. */
function scenarioOf(deps: Lb06Deps, request: Lb06StartIncidentRequest, moment: Date): { scenario: Lb06Scenario, origin: 'sample' | 'custom', sampleId: string | null } {
  if (request.from === 'sample') {
    const scenario = deps.samples.scenarioOf(request.sampleId)
    if (!scenario) throw new AppError(404, 'unknown_sample', 'There is no sample with that id.')
    return { scenario, origin: 'sample', sampleId: request.sampleId }
  }
  const scenario: Lb06Scenario = { seed: request.seed ?? drawSeed(moment), fault: request.fault, params: request.params ?? {}, baselineMinutes: LB06_LIMITS.baselineMinutes }
  return { scenario, origin: 'custom', sampleId: null }
}

/** What the injection screen said, and the parameters as they stand after it. */
interface Screened {
  guard: Lb06IncidentView['guard']
  params: Lb06FaultParams
  calls: number
}

/**
 * Runs the injection screen over the visitor's parameters, when there are any: one guard call for
 * both strings. A flagged string is replaced by a label; a guard that cannot be reached leaves the
 * strings as they are, marked unchecked, since the agents read them as data in any case.
 */
async function screen(deps: Lb06Deps, params: Lb06FaultParams, run: ReturnType<typeof runOf>): Promise<Screened> {
  const texts = [params.version, params.flag].filter((text): text is string => text !== undefined)
  if (texts.length === 0 || !deps.agents) return { guard: 'not_needed', params, calls: 0 }
  const guard = deps.agents.guard
  if (!guard) return { guard: 'unchecked', params, calls: 0 }
  try {
    const verdict = await runScope(run, () => deps.tracer.span('injection screen', async (span) => {
      const answer = await guard.check(texts.join('\n'))
      span.set('flagged', answer.flagged)
      return answer
    }))
    if (!verdict.flagged) return { guard: 'clean', params, calls: 1 }
    return { guard: 'flagged', params: { ...(params.version === undefined ? {} : { version: SCREENED_LABEL }), ...(params.flag === undefined ? {} : { flag: SCREENED_LABEL }) }, calls: 1 }
  }
  catch (error) {
    if (!gatewayErrorOf(error)) throw error
    deps.log.warn({ gatewayCode: gatewayErrorOf(error)?.code }, 'the injection screen could not be reached')
    return { guard: 'unchecked', params, calls: 0 }
  }
}

/**
 * Starts an incident for a visitor and returns it as it stands after its first minute. Answers 404
 * for a sample that doesn't exist, 429 when the visitor has had today's incident, 503 when the
 * service is full or can't reach the gateway or the queue.
 */
export async function startIncident(deps: Lb06Deps, sessionKey: string, request: Lb06StartIncidentRequest): Promise<Lb06IncidentView> {
  if (!deps.agents) throw noGateway()
  const moment = deps.now()
  const asked = scenarioOf(deps, request, moment)
  // The screen runs before the incident exists, so its run is named after a draft id the incident then takes: a run id is any id, so the incident's own is drawn first.
  const draftId = randomUUID()
  const screened = await screen(deps, asked.scenario.params, runOf(draftId, sessionKey, asked.origin))
  const scenario = { ...asked.scenario, params: screened.params }
  const { id, events } = await createIncident(deps, { id: draftId, sessionKey, origin: asked.origin, sampleId: asked.sampleId, scenario, guard: screened.guard, modelCalls: screened.calls })
  await publish(deps, id, events)
  try {
    await deps.scheduler.enqueue(id)
  }
  catch (error) {
    deps.log.error({ err: error, incidentId: id }, 'an incident could not be queued')
    await withdrawIncident(deps, id)
    throw new AppError(503, 'queue_unavailable', 'The incident could not be queued. Try again in a moment.')
  }
  const view = await readIncidentView(deps.db, sessionKey, id, deps.now())
  if (!view) throw incidentNotFound()
  return view
}

/** Publishes events to the feed; a failure is logged and goes no further, since Postgres holds the log. */
export async function publish(deps: Lb06Deps, incidentId: string, events: readonly Lb06Event[]): Promise<void> {
  try {
    await deps.feed.publish(incidentId, events)
  }
  catch (error) {
    deps.log.warn({ err: error, incidentId }, 'the feed could not be written')
  }
}

/** The error for a decision that matches no pending proposal: the proposal was settled, or never existed. */
function proposalSettled(): AppError {
  return new AppError(409, 'proposal_settled', 'This proposal is not waiting for a decision.')
}

/** Ends a locked incident in a state, appending its last event. The caller publishes and records the end. */
export async function endIncident(deps: Lb06Deps, tx: Parameters<typeof lockIncident>[0], row: IncidentRow, state: 'aborted' | 'failed', reason: NonNullable<IncidentRow['endReason']>, moment: Date): Promise<Lb06Event[]> {
  const events = await appendEvents(tx, row.id, [{ kind: state === 'aborted' ? 'incident.aborted' : 'incident.failed', minute: row.minute, data: { reason } }], moment)
  await patchIncident(tx, row.id, { state, endReason: reason, pendingProposal: null, rerank: 0 }, moment)
  return events
}

/** Writes the root span of an incident that has just ended, from the row as it was ended. */
export async function recordEnd(deps: Lb06Deps, row: IncidentRow, state: IncidentRow['state'], reason: IncidentRow['endReason'], moment: Date, modelCalls = row.modelCalls): Promise<void> {
  await recordIncidentEnd(deps, { incidentId: row.id, sessionKey: row.sessionKey, origin: row.origin, startMs: row.createdAt.getTime(), endMs: moment.getTime(), state, endReason: reason, minute: row.minute, modelCalls, proposals: row.proposalsMade, cached: row.cached })
}

/**
 * Answers the pending proposal: approving applies the action to the shop at the current minute and
 * sets the incident to verify; rejecting sends the agents back to rank again, or ends the incident
 * when the proposals are spent. A decision on anything but the one pending proposal is refused.
 */
export async function decide(deps: Lb06Deps, sessionKey: string, incidentId: string, proposalId: string, decision: 'approve' | 'reject'): Promise<Lb06IncidentView> {
  const moment = deps.now()
  const outcome = await deps.db.transaction(async (tx) => {
    const row = await lockIncident(tx, incidentId)
    if (!row || row.sessionKey !== sessionKey || row.expiresAt <= moment) throw incidentNotFound()
    if (row.state !== 'awaiting_approval' || !row.pendingProposal || row.pendingProposal.id !== proposalId) throw proposalSettled()
    const pending = row.pendingProposal
    const inputs: Lb06EventInput[] = []
    let ended: { state: 'aborted', reason: 'proposals_spent' } | undefined
    if (decision === 'approve') {
      inputs.push({ kind: 'proposal.approved', minute: row.minute, data: { proposalId } })
      inputs.push({ kind: 'remediation.applied', minute: row.minute, data: { proposalId, action: pending.action } })
      const events = await appendEvents(tx, row.id, inputs, moment)
      await patchIncident(tx, row.id, { state: 'remediating', pendingProposal: null, remediations: [...row.remediations, { minute: row.minute, action: pending.action }], remediatedAt: row.minute, rerank: 0 }, moment)
      return { events, ended, row }
    }
    inputs.push({ kind: 'proposal.rejected', minute: row.minute, data: { proposalId } })
    let events = await appendEvents(tx, row.id, inputs, moment)
    if (row.proposalsMade >= LB06_LIMITS.maxProposals) {
      ended = { state: 'aborted', reason: 'proposals_spent' }
      events = [...events, ...(await endIncident(deps, tx, row, 'aborted', 'proposals_spent', moment))]
    }
    else {
      await patchIncident(tx, row.id, { state: 'investigating', pendingProposal: null, rerank: 1 }, moment)
    }
    return { events, ended, row }
  })
  await publish(deps, incidentId, outcome.events)
  if (outcome.ended) await recordEnd(deps, outcome.row, outcome.ended.state, outcome.ended.reason, moment)
  const view = await readIncidentView(deps.db, sessionKey, incidentId, deps.now())
  if (!view) throw incidentNotFound()
  return view
}

/** Ends a visitor's incident now. An incident that has ended already is refused with 409. */
export async function abortIncident(deps: Lb06Deps, sessionKey: string, incidentId: string): Promise<Lb06IncidentView> {
  const moment = deps.now()
  const outcome = await deps.db.transaction(async (tx) => {
    const row = await lockIncident(tx, incidentId)
    if (!row || row.sessionKey !== sessionKey || row.expiresAt <= moment) throw incidentNotFound()
    if (ENDED_STATES.includes(row.state)) throw new AppError(409, 'incident_ended', 'This incident has ended already.')
    const events = await endIncident(deps, tx, row, 'aborted', 'visitor', moment)
    return { events, row }
  })
  await publish(deps, incidentId, outcome.events)
  await recordEnd(deps, outcome.row, 'aborted', 'visitor', moment)
  const row = await readIncident(deps.db, incidentId, deps.now(), sessionKey)
  if (!row) throw incidentNotFound()
  return viewOf(row, outcome.events.at(-1)?.seq ?? 0)
}
