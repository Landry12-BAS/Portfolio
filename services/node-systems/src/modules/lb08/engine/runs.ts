// The three ways a person begins or moves a run: starting it with a test payload, replaying
// a finished one, and answering an approval step.
//
// Starting and replaying are the only things that spend a visitor's daily runs, and they
// do it in the same transaction that creates the run, so a request that fails takes
// nothing. Starting checks everything it can before it spends anything: the workflow is
// the visitor's and still valid, the payload fits the trigger's event, and each failure the
// visitor asked for names an action step.
//
// A replay is a new run of the same version with the same payload, and it shares the root
// of its chain with the original. Side effects are keyed by that root, so the replay
// recognises everything the original already sent and sends it only once: the log says so
// with `effect.duplicate_suppressed`.
import { randomUUID } from 'node:crypto'

import { RUN_LIMITS, triggerPayloadSchema, validateWorkflow } from '@lb/contracts'
import type { DecisionRequest, StartRunRequest, Values } from '@lb/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import type { ZodError } from 'zod'

import { AppError } from '../../../core/errors.ts'
import type { Lb08Tx } from '../db/connection.ts'
import { deadLetters, faults, runs, runSteps } from '../db/schema.ts'
import type { EngineDeps } from './deps.ts'
import { dispatchSafely } from './dispatch.ts'
import { settle } from './settle.ts'
import { loadLocked, nodeOf, statusOf, updateStep, workOn } from './state.ts'
import { loadVersion, workflowNotFound } from './store.ts'
import type { LoadedVersion } from './store.ts'
import { nextReset, reserve } from './usage.ts'
import type { UsageKind } from './usage.ts'

/** Builds the error for a visitor who has used the day's allowance, with how long until it resets. */
export function dailyLimit(kind: UsageKind, now: Date): AppError {
  const seconds = Math.ceil((nextReset(now).getTime() - now.getTime()) / 1000)
  const message = kind === 'run'
    ? `A visitor may start ${RUN_LIMITS.runsPerVisitorPerDay} workflow runs a day, and a replay counts as one.`
    : `A visitor may describe ${RUN_LIMITS.generationsPerVisitorPerDay} workflows a day.`
  return new AppError(429, 'daily_limit', message, { retryAfterSeconds: seconds })
}

/** The error for a run that doesn't exist or isn't the visitor's: the same either way, so ids can't be probed. */
export function runNotFound(): AppError {
  return new AppError(404, 'not_found', 'There is no such run.')
}

/** Names the fields at fault in a payload, such as `totalEur`, without their values. */
function fieldsAtFault(error: ZodError): string {
  const names = error.issues.map(issue => issue.path.join('.') || 'input')
  return [...new Set(names)].sort().join(', ')
}

/** Loads a version for running and checks it still passes validation, because rules may have tightened since it was saved. */
async function loadRunnable(deps: EngineDeps, sessionKey: string, workflowId: string, version?: number): Promise<LoadedVersion> {
  const loaded = await loadVersion(deps.db, sessionKey, workflowId, version)
  if (!loaded) throw workflowNotFound()
  const checked = validateWorkflow(loaded.graph)
  if (!checked.ok) {
    throw new AppError(409, 'workflow_invalid', 'This version no longer passes validation. Edit the workflow and save it again.', { problems: checked.issues })
  }
  return loaded
}

/** Checks that every failure the visitor asked for names a different action step of the workflow. */
function checkFailures(workflow: LoadedVersion, failures: StartRunRequest['failures']): void {
  const actionIds = new Set(workflow.graph.nodes.filter(node => node.type === 'action').map(node => node.id))
  const named = (failures ?? []).map(failure => failure.nodeId)
  if (new Set(named).size !== named.length || named.some(id => !actionIds.has(id))) {
    throw new AppError(422, 'invalid_failure', 'Failures can only be set once on each action step of this workflow.', { fields: 'failures' })
  }
}

/** What a new run is made of. */
interface NewRun {
  id: string
  rootRunId: string
  replayOf: string | null
  sessionKey: string
  workflow: LoadedVersion
  input: Values
  failures: readonly { nodeId: string, times: number }[]
}

/**
 * Writes a run: the run, one row for each step (the trigger already done, with the payload
 * as its output), the failures asked for, and the first events. Then settles it, so the
 * steps after the trigger are ready, skipped or waiting before the transaction commits.
 */
async function insertRun(tx: Lb08Tx, deps: EngineDeps, run: NewRun): Promise<void> {
  const now = deps.now()
  const { graph } = run.workflow
  const trigger = graph.nodes.find(node => node.type === 'trigger')
  if (!trigger) throw new Error('A validated workflow always has a trigger.')
  await tx.insert(runs).values({ id: run.id, workflowId: run.workflow.workflowId, version: run.workflow.version, sessionKey: run.sessionKey, rootRunId: run.rootRunId, replayOf: run.replayOf, status: 'queued', input: run.input, createdAt: now })
  await tx.insert(runSteps).values(graph.nodes.map(node => node.id === trigger.id
    ? { runId: run.id, nodeId: node.id, status: 'succeeded', output: run.input, startedAt: now, finishedAt: now, updatedAt: now }
    : { runId: run.id, nodeId: node.id, status: 'pending', updatedAt: now }))
  if (run.failures.length > 0) {
    await tx.insert(faults).values(run.failures.map(failure => ({ rootRunId: run.rootRunId, nodeId: failure.nodeId, workflowId: run.workflow.workflowId, remaining: failure.times })))
  }
  const state = await loadLocked(tx, run.id)
  if (!state) throw new Error('The run that was just written is missing.')
  const work = workOn(tx, state, now)
  work.log.add({ type: 'run.queued', version: run.workflow.version, replayOf: run.replayOf })
  work.log.add({ type: 'step.succeeded', nodeId: trigger.id, attempt: 0, output: run.input })
  await settle(work)
  await work.log.flush(tx)
}

/**
 * Starts a run of one of the visitor's workflows with a test payload, and returns its id.
 * The run is queued: workers do the rest, and the site watches its log.
 */
export async function startRun(deps: EngineDeps, sessionKey: string, workflowId: string, request: StartRunRequest): Promise<string> {
  const workflow = await loadRunnable(deps, sessionKey, workflowId, request.version)
  const trigger = workflow.graph.nodes.find(node => node.type === 'trigger')
  if (trigger?.type !== 'trigger') throw new Error('A validated workflow always has a trigger.')
  const payload = triggerPayloadSchema(trigger.event).safeParse(request.input)
  if (!payload.success) throw new AppError(422, 'invalid_input', `The payload doesn't fit the ${trigger.event} event.`, { fields: fieldsAtFault(payload.error) })
  checkFailures(workflow, request.failures)

  const id = randomUUID()
  await deps.db.transaction(async (tx) => {
    if (!(await reserve(tx, sessionKey, 'run', deps.now()))) throw dailyLimit('run', deps.now())
    await insertRun(tx, deps, { id, rootRunId: id, replayOf: null, sessionKey, workflow, input: payload.data, failures: request.failures ?? [] })
  })
  await dispatchSafely(deps, id)
  return id
}

/**
 * Replays a finished run: a new run of the same version, with the same payload, in the same
 * chain. Whatever the original already sent is recognised and not sent again, and a step
 * that was dead-lettered gets another go with whatever failures the visitor asked for
 * still left. A replay counts as one of the visitor's runs. Returns the new run's id.
 */
export async function replayRun(deps: EngineDeps, sessionKey: string, runId: string): Promise<string> {
  const [original] = await deps.db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.sessionKey, sessionKey))).limit(1)
  if (!original) throw runNotFound()
  if (original.status !== 'succeeded' && original.status !== 'failed') {
    throw new AppError(409, 'run_not_finished', 'Only a finished run can be replayed.')
  }
  const workflow = await loadRunnable(deps, sessionKey, original.workflowId, original.version)

  const id = randomUUID()
  const replayed = await deps.db.transaction(async (tx) => {
    if (!(await reserve(tx, sessionKey, 'run', deps.now()))) throw dailyLimit('run', deps.now())
    await insertRun(tx, deps, { id, rootRunId: original.rootRunId, replayOf: original.id, sessionKey, workflow, input: original.input, failures: [] })
    // The dead letters of the original are answered by this replay.
    return tx.update(deadLetters).set({ replayedRunId: id })
      .where(and(eq(deadLetters.runId, original.id), isNull(deadLetters.replayedRunId)))
      .returning({ nodeId: deadLetters.nodeId })
  })
  for (const letter of replayed) await deps.scheduler.unpark(original.id, letter.nodeId).catch(() => undefined)
  await dispatchSafely(deps, id)
  return id
}

/**
 * Records a person's answer to an approval step: the step succeeds with the branch they
 * chose, and the run carries on down it. Only a step that is waiting can be answered, once.
 */
export async function decide(deps: EngineDeps, sessionKey: string, runId: string, nodeId: string, request: DecisionRequest): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const state = await loadLocked(tx, runId)
    if (!state || state.run.sessionKey !== sessionKey) throw runNotFound()
    const step = state.steps.get(nodeId)
    if (nodeOf(state.graph, nodeId)?.type !== 'approval' || !step) throw new AppError(404, 'not_found', 'There is no such approval step in this run.')
    const over = state.run.status === 'succeeded' || state.run.status === 'failed'
    if (statusOf(step) !== 'awaiting_approval' || over) throw new AppError(409, 'not_waiting', 'Only an approval that is waiting can be decided.')
    const work = workOn(tx, state, deps.now())
    const output: Values = { ...step.output, branch: request.decision }
    await updateStep(work, nodeId, { status: 'succeeded', output, finishedAt: work.now })
    work.log.add({ type: 'step.decided', nodeId, decision: request.decision })
    work.log.add({ type: 'step.succeeded', nodeId, attempt: 0, output })
    await settle(work)
    await work.log.flush(tx)
  })
  await dispatchSafely(deps, runId)
}
