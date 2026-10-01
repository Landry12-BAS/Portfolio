// Settling a run: after anything changes, decide what happens next and write it down.
//
// `advance` (flow.ts) says which steps may start and which can never run. Settling applies
// that: skipped steps are marked, conditions are evaluated on the spot (they read two
// values and compare them, so they need no worker), approvals start waiting for a person,
// and action steps become ready to be queued. It repeats until nothing more settles,
// because skipping a step or evaluating a condition can settle the steps after it. Then it
// brings the run's own status up to date and writes the matching events.
import { evaluateCondition } from '@lb/contracts'
import type { ApprovalNode, BranchLabel, ConditionNode, Values, WorkflowNode } from '@lb/contracts'
import { eq } from 'drizzle-orm'

import { runs } from '../db/schema.ts'
import { readValue, renderQuestion } from './context.ts'
import { StepError } from './errors.ts'
import { advance, runStatusOf } from './flow.ts'
import type { SkipReason } from './flow.ts'
import { contextOf, firstNodeWith, nodeOf, progressOf, statusOf, updateStep } from './state.ts'
import type { Work } from './state.ts'

/** Records that the run has begun, the first time something past its trigger happens. */
export async function startRunOnce(work: Work): Promise<void> {
  const { run } = work.state
  if (run.startedAt !== null) return
  await work.tx.update(runs).set({ startedAt: work.now }).where(eq(runs.id, run.id))
  run.startedAt = work.now
  work.log.add({ type: 'run.started' })
}

/** Marks a step as one that will never run, and says why. */
async function skipStep(work: Work, nodeId: string, reason: SkipReason): Promise<void> {
  await updateStep(work, nodeId, { status: 'skipped', finishedAt: work.now })
  work.log.add({ type: 'step.skipped', nodeId, reason })
}

/** Evaluates a condition on the spot: reads its value, compares it, and records which branch the run takes. */
async function evaluateConditionStep(work: Work, node: ConditionNode): Promise<void> {
  const actual = readValue(contextOf(work.state), node.field)
  const branch: BranchLabel = evaluateCondition(node.op, actual, node.value) ? 'true' : 'false'
  const output: Values = { checked: actual, branch }
  await updateStep(work, node.id, { status: 'succeeded', output, startedAt: work.now, finishedAt: work.now })
  work.log.add({ type: 'step.succeeded', nodeId: node.id, attempt: 0, output })
}

/** Puts an approval step to waiting: the question is written out for the person, who answers through the API. */
async function requestApproval(work: Work, node: ApprovalNode): Promise<void> {
  const question = renderQuestion(node.message, contextOf(work.state))
  await updateStep(work, node.id, { status: 'awaiting_approval', output: { question }, startedAt: work.now })
  work.log.add({ type: 'step.awaiting_approval', nodeId: node.id, approver: node.approver })
}

/** Fails a step that never needed a worker, for good, with the reason the error gives. */
async function failInline(work: Work, nodeId: string, error: StepError): Promise<void> {
  await updateStep(work, nodeId, { status: 'failed', errorCode: error.code, errorMessage: error.message, startedAt: work.now, finishedAt: work.now })
  work.log.add({ type: 'step.failed', nodeId, attempt: 1, maxAttempts: 1, code: error.code, message: error.message, retryInMs: null })
}

/** Starts a step that has what it needs: free steps run now, an approval waits, and an action is left for a worker. */
async function startReady(work: Work, node: WorkflowNode): Promise<void> {
  try {
    if (node.type === 'condition') await evaluateConditionStep(work, node)
    else if (node.type === 'approval') await requestApproval(work, node)
    else if (node.type === 'action') await updateStep(work, node.id, { status: 'ready' })
  }
  catch (error) {
    if (!(error instanceof StepError)) throw error
    await failInline(work, node.id, error)
  }
}

/** Tells whether any step of the run has failed. */
function hasFailed(work: Work): boolean {
  return [...work.state.steps.values()].some(step => statusOf(step) === 'failed')
}

/**
 * Brings the run's status up to date with its steps, and records the events for each change:
 * that it started, is waiting for a person, succeeded or failed.
 */
export async function syncRunStatus(work: Work): Promise<void> {
  const { run, steps } = work.state
  const status = runStatusOf([...steps.values()].map(statusOf), run.startedAt !== null)
  if (status === run.status) return
  if (status !== 'queued') await startRunOnce(work)
  const finished = status === 'succeeded' || status === 'failed'
  if (status === 'awaiting_approval') work.log.add({ type: 'run.awaiting_approval', nodeId: firstNodeWith(work.state, 'awaiting_approval') ?? '' })
  if (status === 'succeeded') work.log.add({ type: 'run.succeeded' })
  if (status === 'failed') work.log.add({ type: 'run.failed', nodeId: firstNodeWith(work.state, 'failed') ?? '' })
  await work.tx.update(runs).set({ status, ...(finished ? { finishedAt: work.now } : {}) }).where(eq(runs.id, run.id))
  run.status = status
  if (finished) run.finishedAt = work.now
}

/**
 * Decides and records what happens next in a run. Nothing starts after a step has failed:
 * what is already moving finishes, and the run ends as failed.
 */
export async function settle(work: Work): Promise<void> {
  while (!hasFailed(work)) {
    const next = advance(work.state.graph, progressOf(work.state))
    if (next.ready.length === 0 && next.skipped.length === 0) break
    for (const skipped of next.skipped) await skipStep(work, skipped.nodeId, skipped.reason)
    for (const nodeId of next.ready) {
      const node = nodeOf(work.state.graph, nodeId)
      if (node) await startReady(work, node)
    }
  }
  await syncRunStatus(work)
}
