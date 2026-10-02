// A run's events told as sentences. The log of a run is a list of numbered events with ids, counts
// and short fixed messages; this module writes each one as a sentence in the visitor's language, for
// the log table, and picks out the few worth saying aloud as they happen (a retry, a dead letter,
// the run's end) for the live region. A step is named by its label in the graph that ran, never by
// the id alone, and an error is named by its code: the service's own message is English and is only
// the technical detail.
import type { RunEvent, Values, WorkflowGraph } from '@lb/contracts'

import type { Words } from '../graph/words'

/** What the sentences need besides the event: the graph that ran, to name steps, and the words. */
export interface Narration {
  graph: WorkflowGraph | undefined
  words: Words
}

/** A step's name for a sentence: its label in the graph that ran, or its id when the graph is not known. */
export function stepName(graph: WorkflowGraph | undefined, nodeId: string): string {
  const node = graph?.nodes.find(candidate => candidate.id === nodeId)
  return node?.label || nodeId
}

/** An error code said in words; a code the board does not know says the general thing. */
export function errorWords(words: Words, code: string): string {
  const key = `lb08.errors.${code}`
  return words.has(key) ? words.say(key) : words.say('lb08.errors.unknown')
}

/** How many whole seconds a wait of so many milliseconds is, never less than one for a wait that is not nothing. */
export function secondsOf(ms: number): number {
  return ms <= 0 ? 0 : Math.max(1, Math.ceil(ms / 1000))
}

/** A decision said in words. */
function decisionWords(words: Words, decision: 'approved' | 'rejected'): string {
  return words.say(decision === 'approved' ? 'lb08.log.approved' : 'lb08.log.rejected')
}

/** An approver said in words. */
function approverWords(words: Words, approver: string): string {
  const key = `lb08.choices.approver.${approver}`
  return words.has(key) ? words.say(key) : approver
}

/** The sentence for a failed attempt: whether another comes, and when. */
function failureSentence(event: Extract<RunEvent, { type: 'step.failed' }>, narration: Narration): string {
  const { words, graph } = narration
  const step = stepName(graph, event.nodeId)
  const error = errorWords(words, event.code)
  if (event.retryInMs !== null) {
    return words.say('lb08.log.stepFailedRetry', { step, attempt: event.attempt, max: event.maxAttempts, error, seconds: secondsOf(event.retryInMs) })
  }
  if (event.attempt >= event.maxAttempts) return words.say('lb08.log.stepFailedLast', { step, attempt: event.attempt, max: event.maxAttempts, error })
  return words.say('lb08.log.stepFailedFinal', { step, error })
}

/** Tells one event as a sentence. */
export function sentenceFor(event: RunEvent, narration: Narration): string {
  const { words, graph } = narration
  const step = 'nodeId' in event ? stepName(graph, event.nodeId) : ''
  switch (event.type) {
    case 'run.queued':
      return words.say(event.replayOf === null ? 'lb08.log.runQueued' : 'lb08.log.replayQueued', { version: event.version })
    case 'run.started':
      return words.say('lb08.log.runStarted')
    case 'run.awaiting_approval':
      return words.say('lb08.log.runAwaiting', { step })
    case 'run.succeeded':
      return words.say('lb08.log.runSucceeded')
    case 'run.failed':
      return words.say('lb08.log.runFailed', { step })
    case 'step.started':
      return words.say('lb08.log.stepStarted', { step, attempt: event.attempt })
    case 'step.succeeded':
      return event.attempt > 1
        ? words.say('lb08.log.stepSucceededAfter', { step, attempt: event.attempt })
        : words.say('lb08.log.stepSucceeded', { step })
    case 'step.failed':
      return failureSentence(event, narration)
    case 'step.dead_lettered':
      return words.say('lb08.log.stepDead', { step, attempts: event.attempts })
    case 'step.skipped':
      return words.say(event.reason === 'branch_not_taken' ? 'lb08.log.stepSkippedBranch' : 'lb08.log.stepSkippedUpstream', { step })
    case 'step.awaiting_approval':
      return words.say('lb08.log.stepAwaiting', { step, approver: approverWords(words, event.approver) })
    case 'step.decided':
      return words.say('lb08.log.stepDecided', { step, decision: decisionWords(words, event.decision) })
    case 'effect.sent':
      return words.say('lb08.log.effectSent', { step, message: event.messageId })
    case 'effect.duplicate_suppressed':
      return words.say('lb08.log.effectSuppressed', { step, message: event.messageId })
  }
}

/** What is worth saying aloud about an event as it happens, or nothing. */
export function announcementFor(event: RunEvent, narration: Narration): string | undefined {
  const { words, graph } = narration
  switch (event.type) {
    case 'run.started':
      return words.say('lb08.run.announce.started')
    case 'run.succeeded':
      return words.say('lb08.run.announce.succeeded')
    case 'run.failed':
      return words.say('lb08.run.announce.failed')
    case 'run.awaiting_approval':
      return words.say('lb08.run.announce.waiting')
    case 'step.failed':
      return event.retryInMs === null
        ? undefined
        : words.say('lb08.run.announce.retry', { step: stepName(graph, event.nodeId), attempt: event.attempt, seconds: secondsOf(event.retryInMs) })
    case 'step.dead_lettered':
      return words.say('lb08.run.announce.dead', { step: stepName(graph, event.nodeId) })
    default:
      return undefined
  }
}

/** The announcements for the events of a run that come after one the board has already told, in order. */
export function announcementsAfter(events: readonly RunEvent[], toldSeq: number, narration: Narration): string[] {
  return events
    .filter(event => event.seq > toldSeq)
    .map(event => announcementFor(event, narration))
    .filter((text): text is string => text !== undefined)
}

/** A value of a step's output, as text: a yes or no is said in words, a number or a text as it is. */
export function valueWords(words: Words, value: Values[string]): string {
  if (typeof value === 'boolean') return words.say(value ? 'lb08.inspector.boolYes' : 'lb08.inspector.boolNo')
  return String(value)
}
