// Running one action step, from the moment a worker picks its job up to the moment its
// result is written down.
//
//   claim     lock the run, count the attempt, log that the step started
//   execute   call the connector (outside any transaction: it may take a while)
//   complete  lock the run, record the output, acknowledge the outbox row, log the
//             effect, decide what starts next
//   fail      lock the run, log the failure, and either schedule a retry, or give up:
//             the step fails, and if it ran out of attempts it goes to the dead-letter queue
//
// The step's side effect happens between claim and complete, and it is the one place a
// crash can leave the books uneven: the thing was sent, but the step was never marked
// done. That is safe by design. The retry runs the step again, finds the outbox row and
// the delivery under the same idempotency key, sends nothing a second time, and records
// the step as done. `Hooks.afterEffect` exists so a test can stop a worker right there.
import { createRun, runScope, spanScope } from '@lb/common'
import type { ActionNode } from '@lb/contracts'

import { retryDelayMs } from '../config.ts'
import { deadLetters } from '../db/schema.ts'
import { buildCall } from './context.ts'
import type { RunContext } from './context.ts'
import type { DeadLetterNote, EngineDeps } from './deps.ts'
import { dispatchSafely } from './dispatch.ts'
import { StepError, StepFailure, StepKilled } from './errors.ts'
import { acknowledge } from './outbox.ts'
import { callConnector } from './sandbox.ts'
import type { ConnectorResult, StepIdentity } from './sandbox.ts'
import { settle, startRunOnce, syncRunStatus } from './settle.ts'
import { contextOf, loadLocked, nodeOf, statusOf, updateStep, workOn } from './state.ts'
import type { Work } from './state.ts'
import { endOf, recordRunEnd, rootSpanIdOf } from './trace.ts'
import type { RunEnd } from './trace.ts'

/** Everything the worker needs to run a step it has claimed. */
interface Claim {
  runId: string
  node: ActionNode
  // Which try this is, counting the first as 1.
  attempt: number
  who: StepIdentity
  context: RunContext
}

/**
 * What claiming came to: a step to run, a step that had no attempts left (which may have made
 * a dead letter, and ends the run if it was the last), or nothing to do.
 */
type Claimed
  = | { kind: 'run', claim: Claim }
    | { kind: 'exhausted', deadLetter: DeadLetterNote | undefined, ended: RunEnd | undefined }
    | { kind: 'nothing' }

/** What recording a failure came to: whether the step is finished for good, the dead letter if it made one, and how the run ended if that was the end of it. */
interface FailureOutcome {
  final: boolean
  deadLetter: DeadLetterNote | undefined
  ended: RunEnd | undefined
}

/** Wraps whatever a connector threw as a step error, so one that wasn't expected fails the step instead of crashing the worker. */
function asStepError(deps: EngineDeps, error: unknown): StepError {
  if (error instanceof StepError) return error
  deps.log.error({ err: error }, 'a step hit an unexpected error')
  return new StepError('internal_error', 'The step hit an unexpected error.', true)
}

/**
 * Records that an attempt failed. A retryable failure with attempts left puts the step
 * back to waiting and logs when the next attempt comes. Anything else ends the step: it
 * fails, and when the cause was retryable it also goes to the dead-letter queue.
 */
async function recordFailure(deps: EngineDeps, work: Work, nodeId: string, attempt: number, error: StepError): Promise<FailureOutcome> {
  const maxAttempts = deps.config.maxAttempts
  const failure = { nodeId, attempt, maxAttempts, code: error.code, message: error.message }
  if (error.retryable && attempt < maxAttempts) {
    await updateStep(work, nodeId, { status: 'queued', errorCode: error.code, errorMessage: error.message })
    work.log.add({ type: 'step.failed', ...failure, retryInMs: retryDelayMs(deps.config, attempt) })
    return { final: false, deadLetter: undefined, ended: undefined }
  }
  await updateStep(work, nodeId, { status: 'failed', errorCode: error.code, errorMessage: error.message, finishedAt: work.now })
  work.log.add({ type: 'step.failed', ...failure, retryInMs: null })
  let deadLetter: DeadLetterNote | undefined
  if (error.retryable) {
    const { run } = work.state
    await work.tx.insert(deadLetters).values({ workflowId: run.workflowId, runId: run.id, sessionKey: run.sessionKey, nodeId, attempts: attempt, errorCode: error.code, errorMessage: error.message })
    work.log.add({ type: 'step.dead_lettered', nodeId, attempts: attempt })
    deadLetter = { runId: run.id, nodeId, attempts: attempt, code: error.code }
  }
  await settle(work)
  return { final: true, deadLetter, ended: endOf(work) }
}

/** Parks a copy of a dead letter in the queue for the owner's tools. A failure here is logged and nothing more: the database holds the real record. */
async function parkSafely(deps: EngineDeps, note: DeadLetterNote): Promise<void> {
  try {
    await deps.scheduler.park(note)
  }
  catch (error) {
    deps.log.warn({ err: error, runId: note.runId }, 'could not park a dead letter in the queue')
  }
}

/**
 * Takes a step for a worker: locks the run, counts the attempt and logs that it started.
 * Returns nothing to do for a step that has moved on (a duplicate job, a finished run, a
 * workflow that expired). A step that already used every attempt without finishing, which
 * only a worker that keeps dying does, is dead-lettered here instead of run again.
 */
async function claimStep(deps: EngineDeps, runId: string, nodeId: string): Promise<Claimed> {
  const now = deps.now()
  return deps.db.transaction(async (tx): Promise<Claimed> => {
    const state = await loadLocked(tx, runId)
    const node = state ? nodeOf(state.graph, nodeId) : undefined
    const step = state?.steps.get(nodeId)
    if (!state || !step || node?.type !== 'action') return { kind: 'nothing' }
    const waiting = ['ready', 'queued', 'running'].includes(statusOf(step))
    if (!waiting || state.run.status === 'succeeded' || state.run.status === 'failed') return { kind: 'nothing' }

    const work = workOn(tx, state, now)
    if (step.attempts >= deps.config.maxAttempts) {
      const error = new StepError('attempts_exhausted', 'The step used all its attempts without finishing.', true)
      const outcome = await recordFailure(deps, work, nodeId, step.attempts, error)
      await work.log.flush(tx)
      return { kind: 'exhausted', deadLetter: outcome.deadLetter, ended: outcome.ended }
    }

    const attempt = step.attempts + 1
    await updateStep(work, nodeId, { status: 'running', attempts: attempt, startedAt: step.startedAt ?? now })
    await startRunOnce(work)
    work.log.add({ type: 'step.started', nodeId, attempt })
    await syncRunStatus(work)
    await work.log.flush(tx)
    const who: StepIdentity = { workflowId: state.run.workflowId, sessionKey: state.run.sessionKey, runId, rootRunId: state.run.rootRunId, nodeId }
    return { kind: 'run', claim: { runId, node, attempt, who, context: contextOf(state) } }
  })
}

/**
 * Calls the step's connector inside a span of the run's trace, so the Scope shows the
 * step, its attempt and what became of it. The span carries labels only, never a payload.
 * It names the run's root span as its parent: the root is written when the run ends, long
 * after this span, but its ID is known now (see trace.ts).
 */
async function executeStep(deps: EngineDeps, claim: Claim): Promise<ConnectorResult> {
  const run = createRun({ system: 'lb-08', runId: claim.runId, session: claim.who.sessionKey })
  return runScope(run, () => spanScope(rootSpanIdOf(claim.runId), () => deps.tracer.span(`step.${claim.node.id}`, async (span) => {
    span.set('connector', claim.node.connector)
    span.set('attempt', claim.attempt)
    const result = await callConnector(deps.db, deps.hooks, claim.who, buildCall(claim.node, claim.context))
    span.set('outcome', result.delivery === null ? 'read' : result.delivery.duplicateOf === null ? 'sent' : 'duplicate_suppressed')
    return result
  })))
}

/**
 * Records a step's success: the output, the outbox acknowledgement, the effect's event,
 * and whatever the run does next. Does nothing if the step is no longer running (another
 * worker already finished it, or the workflow expired). Returns how the run ended, if this
 * step was its last.
 */
async function completeStep(deps: EngineDeps, claim: Claim, result: ConnectorResult): Promise<RunEnd | undefined> {
  const nodeId = claim.node.id
  return deps.db.transaction(async (tx) => {
    const state = await loadLocked(tx, claim.runId)
    const step = state?.steps.get(nodeId)
    if (!state || !step || statusOf(step) !== 'running') return undefined
    const work = workOn(tx, state, deps.now())
    const { delivery } = result
    if (delivery) {
      await acknowledge(tx, delivery.key, delivery.messageId, work.now)
      const effect = { nodeId, connector: claim.node.connector, messageId: delivery.messageId }
      work.log.add(delivery.duplicateOf === null
        ? { type: 'effect.sent', ...effect }
        : { type: 'effect.duplicate_suppressed', ...effect, originalRunId: delivery.duplicateOf })
    }
    await updateStep(work, nodeId, { status: 'succeeded', output: result.output, errorCode: null, errorMessage: null, finishedAt: work.now })
    work.log.add({ type: 'step.succeeded', nodeId, attempt: claim.attempt, output: result.output })
    await settle(work)
    await work.log.flush(tx)
    return endOf(work)
  })
}

/**
 * Records a failed attempt, and throws what the queue needs to hear: a failure that will
 * be retried, or one that is final. Returns quietly if the step is no longer running.
 */
async function failStep(deps: EngineDeps, claim: Claim, error: StepError): Promise<void> {
  const outcome = await deps.db.transaction(async (tx): Promise<FailureOutcome | undefined> => {
    const state = await loadLocked(tx, claim.runId)
    const step = state?.steps.get(claim.node.id)
    if (!state || !step || statusOf(step) !== 'running') return undefined
    const work = workOn(tx, state, deps.now())
    const recorded = await recordFailure(deps, work, claim.node.id, claim.attempt, error)
    await work.log.flush(tx)
    return recorded
  })
  if (!outcome) return
  if (outcome.deadLetter) await parkSafely(deps, outcome.deadLetter)
  await recordRunEnd(deps, outcome.ended)
  throw new StepFailure(!outcome.final)
}

/**
 * Runs one step job: claim, execute, then record the result. Throws `StepFailure` when the
 * step failed, saying whether the queue should retry it, and `StepKilled` (only tests make
 * one) to stand in for a worker that died, in which case nothing is recorded, just as if
 * the process had been killed.
 */
export async function runStep(deps: EngineDeps, runId: string, nodeId: string): Promise<void> {
  const claimed = await claimStep(deps, runId, nodeId)
  if (claimed.kind === 'exhausted') {
    if (claimed.deadLetter) await parkSafely(deps, claimed.deadLetter)
    await recordRunEnd(deps, claimed.ended)
  }
  if (claimed.kind !== 'run') return
  let result: ConnectorResult
  try {
    result = await executeStep(deps, claimed.claim)
  }
  catch (error) {
    if (error instanceof StepKilled) throw error
    await failStep(deps, claimed.claim, asStepError(deps, error))
    return
  }
  await recordRunEnd(deps, await completeStep(deps, claimed.claim, result))
  await dispatchSafely(deps, runId)
}
