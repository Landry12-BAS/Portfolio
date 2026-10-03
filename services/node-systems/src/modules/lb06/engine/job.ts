// The job that runs one incident: the clock that ticks the shop every few seconds of wall time, the
// detector that fires the alert and measures the recovery, and the agents' work, which runs beside
// the clock on a snapshot so the dashboards never stop. Every change is a transaction that locks
// the incident's row and checks its state, so the job can be started again after a crash and
// resume where the log stopped, and so a decision the visitor made meanwhile is never undone.
//
// The job ends when the incident does: closed after the postmortem, aborted by the visitor, by the
// wall-clock cap, by the step cap or by spent proposals, or failed when the agents cannot be reached.
import { runScope, spanScope } from '@lb/common'
import { LB06_LIMITS } from '@lb/contracts'
import type { Lb06Event, Lb06EventInput, Lb06PendingProposal } from '@lb/contracts'

import { gatewayErrorOf } from '@lb/common'

import { contextOf, investigate, ModelOutputInvalid, proposeAgain, StepCapReached, writePostmortem } from '../agents/orchestrator.ts'
import type { Budget, Investigation, Reranking } from '../agents/orchestrator.ts'
import { timelineOf } from '../agents/postmortem.ts'
import { healthyStreak, sloAt } from '../detect/slo.ts'
import { evidenceIndex } from '../detect/summary.ts'
import { tickData } from '../detect/tick.ts'
import { buildWorld } from '../sim/world.ts'
import { cacheInvestigation, cachePostmortem, readCachedInvestigation, readCachedPostmortem, scenarioKey } from './cache.ts'
import type { CachedInvestigation } from './cache.ts'
import type { Lb06Deps } from './deps.ts'
import { endIncident, publish, recordEnd } from './service.ts'
import { ENDED_STATES, appendEvents, countAttempt, eventKinds, lockIncident, patchIncident, readEvents, readIncident, scenarioOf } from './store.ts'
import type { IncidentRow } from './store.ts'
import { rootSpanIdOf, runOf } from './trace.ts'

/** The most starts an incident's job may have before it is ended rather than tried for ever. */
const MAX_STARTS = 6

/** Which attempt a job is on. */
export interface Attempt {
  number: number
}

/** What one tick decided: the events it appended, whether the incident ended, and the agents' work it calls for. */
interface TickOutcome {
  events: Lb06Event[]
  row: IncidentRow
  ended: boolean
  work: 'investigate' | 'rerank' | 'postmortem' | undefined
}

/** Waits for a number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

/** Appends one event to a running incident's log in a transaction of its own, and publishes it: how the agents' steps reach the feed as they happen. */
async function appendLive(deps: Lb06Deps, incidentId: string, input: Lb06EventInput): Promise<void> {
  const events = await deps.db.transaction(async (tx) => {
    const row = await lockIncident(tx, incidentId)
    if (!row || ENDED_STATES.includes(row.state)) return []
    return appendEvents(tx, incidentId, [input], deps.now())
  })
  await publish(deps, incidentId, events)
}

/**
 * One tick of the clock: the next minute's metrics and SLO, and what the state machine does with
 * them. Everything happens under the row's lock; the events are published after the commit.
 */
async function tick(deps: Lb06Deps, incidentId: string, working: boolean): Promise<TickOutcome | undefined> {
  const moment = deps.now()
  const outcome = await deps.db.transaction(async (tx): Promise<TickOutcome | undefined> => {
    const row = await lockIncident(tx, incidentId)
    if (!row) return undefined
    if (ENDED_STATES.includes(row.state)) return { events: [], row, ended: true, work: undefined }
    const minute = row.minute + 1
    if (moment >= row.deadlineAt || minute >= LB06_LIMITS.maxSimulatedMinutes) {
      const events = await endIncident(deps, tx, row, 'aborted', 'timed_out', moment)
      return { events, row: { ...row, state: 'aborted', endReason: 'timed_out' }, ended: true, work: undefined }
    }
    const scenario = scenarioOf(row)
    const world = buildWorld(scenario, row.remediations, minute + 1)
    const inputs: Lb06EventInput[] = [{ kind: 'tick', minute, data: tickData(world, minute) }]
    const patch: Parameters<typeof patchIncident>[2] = { minute, nextTickAt: new Date(moment.getTime() + deps.config.tickMs) }
    let work: TickOutcome['work']
    let ended = false

    if (row.state === 'detecting') {
      const slo = sloAt(world, minute)
      if (row.alertMinute === null && slo.alerting) {
        inputs.push({ kind: 'alert.fired', minute, data: { burn: slo.burns[0] as NonNullable<(typeof slo.burns)[0]> } })
        patch.alertMinute = minute
      }
      const alertMinute = patch.alertMinute ?? row.alertMinute
      if (alertMinute !== null && minute >= alertMinute + deps.config.investigationDelayMinutes) {
        inputs.push({ kind: 'investigation.started', minute, data: { snapshotMinute: minute } })
        patch.state = 'investigating'
        work = 'investigate'
      }
    }
    else if (row.state === 'investigating' && !working) {
      // A job that resumed after a crash finds the state and no work in flight: it starts the work again.
      work = row.rerank ? 'rerank' : 'investigate'
    }
    else if (row.state === 'remediating') {
      patch.state = 'verifying'
    }
    else if (row.state === 'verifying') {
      const streak = healthyStreak(world, minute)
      if (streak >= LB06_LIMITS.recoveryMinutes) {
        inputs.push({ kind: 'slo.recovered', minute, data: { healthyMinutes: streak } })
        patch.recoveredMinute = minute
        patch.state = 'writing_postmortem'
        work = 'postmortem'
      }
      else if (row.remediatedAt !== null && minute - row.remediatedAt >= deps.config.verifyMinutes) {
        if (row.proposalsMade >= LB06_LIMITS.maxProposals) {
          const events = await appendEvents(tx, row.id, inputs, moment)
          const end = await endIncident(deps, tx, { ...row, minute }, 'aborted', 'proposals_spent', moment)
          await patchIncident(tx, row.id, { minute }, moment)
          return { events: [...events, ...end], row: { ...row, minute, state: 'aborted', endReason: 'proposals_spent' }, ended: true, work: undefined }
        }
        patch.state = 'investigating'
        patch.rerank = 1
        work = 'rerank'
      }
    }
    else if (row.state === 'writing_postmortem' && !working) {
      work = 'postmortem'
    }
    const events = await appendEvents(tx, row.id, inputs, moment)
    await patchIncident(tx, row.id, patch, moment)
    const after: IncidentRow = {
      ...row,
      minute,
      state: (patch.state ?? row.state) as IncidentRow['state'],
      rerank: patch.rerank === 1 || (patch.rerank === undefined && row.rerank),
      alertMinute: patch.alertMinute ?? row.alertMinute,
      recoveredMinute: patch.recoveredMinute ?? row.recoveredMinute,
    }
    return { events, row: after, ended, work }
  })
  if (outcome) await publish(deps, incidentId, outcome.events)
  return outcome
}

/** Replays a cached investigation's steps into the log, as the agents' work at no model call. */
async function replayCached(deps: Lb06Deps, row: IncidentRow, minute: number, cached: CachedInvestigation): Promise<void> {
  await appendLive(deps, row.id, { kind: 'agent.step', minute, data: { step: 1, agent: 'commander', kind: 'plan', plan: cached.plan, modelCall: false } })
  for (const report of cached.reports) {
    for (const call of report.toolCalls) await appendLive(deps, row.id, { kind: 'agent.step', minute, data: { step: 1, agent: report.agent, kind: 'tool_call', toolCall: call, modelCall: false } })
    await appendLive(deps, row.id, { kind: 'agent.step', minute, data: { step: 1, agent: report.agent, kind: 'report', report, modelCall: false } })
  }
  await appendLive(deps, row.id, { kind: 'agent.step', minute, data: { step: 1, agent: 'commander', kind: 'ranking', modelCall: false } })
  await appendLive(deps, row.id, { kind: 'hypotheses.ranked', minute, data: { hypotheses: cached.hypotheses } })
}

/** Stores the proposal of an investigation or a ranking as the pending one, in a transaction that checks the incident still waits for it. */
async function proposeToVisitor(deps: Lb06Deps, incidentId: string, result: Investigation | Reranking, budget: Budget, cached: boolean, reports: Investigation['reports'] | undefined): Promise<void> {
  const moment = deps.now()
  const events = await deps.db.transaction(async (tx) => {
    const row = await lockIncident(tx, incidentId)
    if (!row || row.state !== 'investigating') return []
    const id = `p${row.proposalsMade + 1}` as Lb06PendingProposal['id']
    const pending: Lb06PendingProposal = { id, hypothesisId: result.proposal.hypothesisId, action: result.proposal.action, rationale: result.proposal.rationale }
    const events = await appendEvents(tx, row.id, [{ kind: 'proposal.made', minute: row.minute, data: { proposalId: id, hypothesisId: pending.hypothesisId, action: pending.action, rationale: pending.rationale } }], moment)
    await patchIncident(tx, row.id, {
      state: 'awaiting_approval',
      pendingProposal: pending,
      proposalsMade: row.proposalsMade + 1,
      modelCalls: Math.min(LB06_LIMITS.stepCap, budget.used),
      cached: cached || row.cached ? 1 : 0,
      rerank: 0,
      ...(reports === undefined ? {} : { investigation: { reports } }),
    }, moment)
    return events
  })
  await publish(deps, incidentId, events)
}

/** The agents' investigation on the snapshot of the moment the work was called for, from the cache when the scenario was run before. */
async function doInvestigate(deps: Lb06Deps, row: IncidentRow, budget: Budget): Promise<void> {
  if (!deps.agents) throw new Error('no agents')
  const scenario = scenarioOf(row)
  const key = scenarioKey(scenario)
  const cached = await readCachedInvestigation(deps.db, key)
  if (cached) {
    await replayCached(deps, row, row.minute, cached)
    await proposeToVisitor(deps, row.id, { hypotheses: cached.hypotheses, proposal: cached.proposal, discarded: 0 }, budget, true, cached.reports)
    return
  }
  const world = buildWorld(scenario, row.remediations, row.minute + 1)
  const context = contextOf(world, evidenceIndex(world, await eventKinds(deps.db, row.id)))
  const orchestrator = { models: deps.agents.models, tracer: deps.tracer, emit: (event: Lb06EventInput) => appendLive(deps, row.id, event) }
  const before = budget.used
  const result = await investigate(orchestrator, context, budget)
  await cacheInvestigation(deps.db, key, { plan: result.plan, reports: result.reports, hypotheses: result.hypotheses, proposal: result.proposal, modelCalls: budget.used - before })
  await proposeToVisitor(deps, row.id, result, budget, false, result.reports)
}

/** A second ranking, after a rejection or a remediation that did not bring the SLO back. */
async function doRerank(deps: Lb06Deps, row: IncidentRow, budget: Budget): Promise<void> {
  if (!deps.agents) throw new Error('no agents')
  const scenario = scenarioOf(row)
  const world = buildWorld(scenario, row.remediations, row.minute + 1)
  const context = contextOf(world, evidenceIndex(world, await eventKinds(deps.db, row.id)))
  const orchestrator = { models: deps.agents.models, tracer: deps.tracer, emit: (event: Lb06EventInput) => appendLive(deps, row.id, event) }
  const tried = (await readEvents(deps.db, row.id, 0, LB06_LIMITS.maxEvents)).filter(event => event.kind === 'proposal.made').map(event => JSON.stringify(event.data.action))
  const result = await proposeAgain(orchestrator, context, budget, row.investigation?.reports ?? [], tried)
  await proposeToVisitor(deps, row.id, result, budget, false, undefined)
}

/** The postmortem: the timeline from the log, the prose from the cache or the model, then the close. */
async function doPostmortem(deps: Lb06Deps, row: IncidentRow, budget: Budget): Promise<void> {
  if (!deps.agents) throw new Error('no agents')
  const key = scenarioKey(scenarioOf(row))
  const actions = row.remediations.map(remediation => remediation.action)
  const cached = await readCachedPostmortem(deps.db, key, actions)
  let prose = cached?.prose ?? null
  let fromCache = cached !== undefined
  if (!cached) {
    const timeline = timelineOf(await readEvents(deps.db, row.id, 0, LB06_LIMITS.maxEvents))
    const orchestrator = { models: deps.agents.models, tracer: deps.tracer, emit: (event: Lb06EventInput) => appendLive(deps, row.id, event) }
    const before = budget.used
    prose = await writePostmortem(orchestrator, timeline, budget, row.minute)
    await cachePostmortem(deps.db, key, actions, { prose, modelCalls: budget.used - before })
    fromCache = false
  }
  const moment = deps.now()
  const outcome = await deps.db.transaction(async (tx) => {
    const current = await lockIncident(tx, row.id)
    if (!current || current.state !== 'writing_postmortem') return undefined
    const modelCalls = Math.min(LB06_LIMITS.stepCap, budget.used)
    const events = await appendEvents(tx, row.id, [
      { kind: 'postmortem.written', minute: current.minute, data: { prose, modelCalls } },
      { kind: 'incident.closed', minute: current.minute, data: { modelCalls, proposals: Math.max(1, current.proposalsMade) } },
    ], moment)
    await patchIncident(tx, row.id, { state: 'closed', modelCalls, cached: fromCache || current.cached ? 1 : 0 }, moment)
    return { events, current }
  })
  if (!outcome) return
  await publish(deps, row.id, outcome.events)
  await recordEnd(deps, outcome.current, 'closed', null, moment, Math.min(LB06_LIMITS.stepCap, budget.used))
}

/** Ends the incident because the agents could not finish: the step cap, an unusable answer, or a gateway that cannot be reached. */
async function endForAgents(deps: Lb06Deps, incidentId: string, error: unknown): Promise<void> {
  const moment = deps.now()
  const reason = error instanceof StepCapReached ? 'step_cap' : 'agents_unavailable'
  const state = error instanceof StepCapReached ? 'aborted' : 'failed'
  if (!(error instanceof StepCapReached) && !(error instanceof ModelOutputInvalid) && !gatewayErrorOf(error)) throw error
  deps.log.warn({ incidentId, reason, errorName: error instanceof Error ? error.name : 'unknown' }, 'the agents could not finish an incident')
  const outcome = await deps.db.transaction(async (tx) => {
    const row = await lockIncident(tx, incidentId)
    if (!row || ENDED_STATES.includes(row.state)) return undefined
    const events = await endIncident(deps, tx, row, state, reason, moment)
    return { events, row }
  })
  if (!outcome) return
  await publish(deps, incidentId, outcome.events)
  await recordEnd(deps, outcome.row, state, reason, moment)
}

/**
 * Runs one incident to its end. The clock loop ticks every `tickMs` of wall time; the agents' work
 * runs beside it in the incident's run scope, under the root span, and the loop sees its result in
 * the row's state on a later tick. The loop stops the moment the incident has ended.
 */
export async function runIncidentJob(deps: Lb06Deps, incidentId: string, attempt: Attempt): Promise<void> {
  const starts = await countAttempt(deps.db, incidentId)
  if (starts > MAX_STARTS) {
    await endForAgents(deps, incidentId, new StepCapReached()).catch(() => undefined)
    return
  }
  const first = await readIncident(deps.db, incidentId, deps.now())
  if (!first || ENDED_STATES.includes(first.state)) return
  const run = runOf(incidentId, first.sessionKey, first.origin)
  const budget: Budget = { cap: LB06_LIMITS.stepCap, used: first.modelCalls }
  let working: Promise<void> | undefined
  deps.log.info({ incidentId, attempt: attempt.number, starts }, 'incident job started')

  const startWork = (kind: NonNullable<TickOutcome['work']>, row: IncidentRow) => {
    working = runScope(run, () => spanScope(rootSpanIdOf(incidentId), async () => {
      if (kind === 'investigate') await doInvestigate(deps, row, budget)
      else if (kind === 'rerank') await doRerank(deps, row, budget)
      else await doPostmortem(deps, row, budget)
    })).catch(error => endForAgents(deps, incidentId, error)).finally(() => {
      working = undefined
    })
  }

  for (;;) {
    const row = await readIncident(deps.db, incidentId, deps.now())
    if (!row || ENDED_STATES.includes(row.state)) break
    await sleep(row.nextTickAt.getTime() - deps.now().getTime())
    const outcome = await tick(deps, incidentId, working !== undefined)
    if (!outcome || outcome.ended) break
    if (outcome.work && working === undefined) startWork(outcome.work, outcome.row)
  }
  if (working) await working
}
