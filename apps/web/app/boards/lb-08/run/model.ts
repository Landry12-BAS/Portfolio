// A run as the board shows it, built from what the back end says: the events of the run's log
// and, now and then, the run in full. The log is the whole story of a run, every change one numbered
// event, so the board keeps the events and folds them into the state of each step: whether it is
// waiting, running, retrying, done, skipped or failed, how many attempts it has used, what it
// produced, and why it stopped. The same fold serves a live run, which the board polls for the events
// it has not seen, and a replay, which hands the same answers back from a recording.
//
// Nothing here talks to the network or to Vue. Time comes in as an argument, so a retry's
// countdown can be tested without waiting.
import type { RunEvent, RunStatus, RunView, StepStatus, Values } from '@lb/contracts'

/** A step waiting for its next attempt: which attempt just failed, how long the queue waits, and when the board learnt of it. */
export interface PendingRetry {
  attempt: number
  inMs: number
  // When the board saw the failure, in Unix milliseconds. The countdown runs from here.
  seenAt: number
}

/** One step of a run. */
export interface StepRun {
  nodeId: string
  status: StepStatus
  // Attempts used so far, and the most it gets.
  attempts: number
  maxAttempts: number
  output: Values | null
  error: { code: string, message: string } | null
  retry: PendingRetry | undefined
  deadLettered: boolean
  skipped: 'branch_not_taken' | 'upstream_skipped' | undefined
  // For an approval: who is asked, what they are asked and what they answered.
  approver: string | undefined
  question: string | undefined
  decision: 'approved' | 'rejected' | undefined
}

/** A run: its status, its steps in the graph's order and its whole log so far. */
export interface RunModel {
  id: string
  workflowId: string
  version: number
  // The first run of the chain of replays this run belongs to.
  rootRunId: string
  replayOf: string | null
  replayedBy: string | null
  status: RunStatus
  input: Values
  createdAt: string
  finishedAt: string | null
  steps: StepRun[]
  events: RunEvent[]
  // The highest sequence number seen: the next poll asks for what comes after it.
  lastSeq: number
}

// Attempts a step gets: the contracts' limit, which the failed event repeats.
const DEFAULT_MAX_ATTEMPTS = 3

/** Tells whether a run has finished, so nothing more will happen to it. */
export function isOver(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'failed'
}

/** A step that has not begun. */
function pendingStep(nodeId: string): StepRun {
  return {
    nodeId,
    status: 'pending',
    attempts: 0,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    output: null,
    error: null,
    retry: undefined,
    deadLettered: false,
    skipped: undefined,
    approver: undefined,
    question: undefined,
    decision: undefined,
  }
}

/** Replaces the step with this id by a changed copy. */
function changeStep(model: RunModel, nodeId: string, change: (step: StepRun) => StepRun): StepRun[] {
  return model.steps.map(step => (step.nodeId === nodeId ? change(step) : step))
}

/** Folds one event into the run's status and steps. */
function foldEvent(model: RunModel, event: RunEvent, now: number): RunModel {
  const next = { ...model, events: [...model.events, event], lastSeq: Math.max(model.lastSeq, event.seq) }
  switch (event.type) {
    case 'run.queued':
      return { ...next, status: 'queued' }
    case 'run.started':
      return { ...next, status: 'running' }
    case 'run.awaiting_approval':
      return { ...next, status: 'awaiting_approval' }
    case 'run.succeeded':
      return { ...next, status: 'succeeded', finishedAt: event.at }
    case 'run.failed':
      return { ...next, status: 'failed', finishedAt: event.at }
    case 'step.started':
      return { ...next, steps: changeStep(next, event.nodeId, step => ({ ...step, status: 'running', attempts: event.attempt, retry: undefined })) }
    case 'step.succeeded':
      return { ...next, steps: changeStep(next, event.nodeId, step => ({ ...step, status: 'succeeded', output: event.output, error: null, retry: undefined })) }
    case 'step.failed':
      return {
        ...next,
        steps: changeStep(next, event.nodeId, step => ({
          ...step,
          status: event.retryInMs === null ? 'failed' : 'queued',
          attempts: event.attempt,
          maxAttempts: event.maxAttempts,
          error: { code: event.code, message: event.message },
          retry: event.retryInMs === null ? undefined : { attempt: event.attempt, inMs: event.retryInMs, seenAt: now },
        })),
      }
    case 'step.dead_lettered':
      return { ...next, steps: changeStep(next, event.nodeId, step => ({ ...step, deadLettered: true })) }
    case 'step.skipped':
      return { ...next, steps: changeStep(next, event.nodeId, step => ({ ...step, status: 'skipped', skipped: event.reason })) }
    case 'step.awaiting_approval':
      return { ...next, steps: changeStep(next, event.nodeId, step => ({ ...step, status: 'awaiting_approval', approver: event.approver })) }
    case 'step.decided':
      return { ...next, steps: changeStep(next, event.nodeId, step => ({ ...step, decision: event.decision })) }
    default:
      return next
  }
}

/** Adds the events the board has not seen yet. An event with a number already seen is passed over, so a poll that overlaps the last one does no harm. */
export function applyEvents(model: RunModel, events: readonly RunEvent[], now: number): RunModel {
  return [...events]
    .sort((a, b) => a.seq - b.seq)
    .filter(event => event.seq > model.lastSeq)
    .reduce((current, event) => foldEvent(current, event, now), model)
}

/** Takes the status of the run from the answer that goes with the events, which is the authority on where the run is. */
export function withStatus(model: RunModel, status: RunStatus): RunModel {
  return status === model.status ? model : { ...model, status }
}

/** Builds a run from the back end's full view of it: the log is folded, and what the log does not carry (outputs, the question an approval asks) is read from the steps. */
export function modelFromView(view: RunView, now: number): RunModel {
  const blank: RunModel = {
    id: view.id,
    workflowId: view.workflowId,
    version: view.version,
    rootRunId: view.rootRunId,
    replayOf: view.replayOf,
    replayedBy: view.replayedBy,
    status: 'queued',
    input: view.input,
    createdAt: view.createdAt,
    finishedAt: view.finishedAt,
    steps: view.steps.map(step => pendingStep(step.nodeId)),
    events: [],
    lastSeq: 0,
  }
  const folded = applyEvents(blank, view.events, now)
  return {
    ...folded,
    status: view.status,
    steps: folded.steps.map((step) => {
      const known = view.steps.find(candidate => candidate.nodeId === step.nodeId)
      if (!known) return step
      const question = typeof known.output?.question === 'string' ? known.output.question : undefined
      return { ...step, status: known.status, attempts: Math.max(step.attempts, known.attempts), output: known.output, error: known.error, question }
    }),
  }
}

/** Reads a view's answer into a model that already exists: the same run, brought up to date (the approval's question, the replay that followed, the final outputs). */
export function reconcile(model: RunModel, view: RunView, now: number): RunModel {
  const fresh = modelFromView(view, now)
  const retrying = new Map(model.steps.map(step => [step.nodeId, step.retry]))
  return { ...fresh, steps: fresh.steps.map(step => ({ ...step, retry: step.status === 'queued' ? retrying.get(step.nodeId) ?? step.retry : undefined })) }
}

/** How long is left before the queue tries a waiting step again, in milliseconds; zero when it is not waiting. */
export function retryLeftMs(step: StepRun, now: number): number {
  if (step.retry === undefined || step.status !== 'queued') return 0
  return Math.max(step.retry.inMs - (now - step.retry.seenAt), 0)
}

/** The steps that wait for a person to approve or reject them. */
export function waitingForApproval(model: RunModel): StepRun[] {
  return model.steps.filter(step => step.status === 'awaiting_approval')
}

/** The steps that used all their attempts and were put in the dead-letter queue. */
export function deadLettered(model: RunModel): StepRun[] {
  return model.steps.filter(step => step.deadLettered)
}

/** The failed attempts of a step and, when it had to be retried, how many times: `attempts - 1` for a step that succeeded after failing, `attempts` for one that did not. */
export function failedAttempts(model: RunModel, nodeId: string): number {
  return model.events.filter(event => event.type === 'step.failed' && event.nodeId === nodeId).length
}
