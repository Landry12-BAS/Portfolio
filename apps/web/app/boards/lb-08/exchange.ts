// Reading a recorded exchange the way the board reads the API's own answer. A recording of a sample
// is the requests the board made and the answers it got; the replay hands those answers back one
// after another. Each answer is recognised by its request (the method and the path), checked with
// the schema the live call is checked with, and turned into the same kind of event the live calls
// produce, so a replay and a live run drive the board through one set of functions. An answer that
// is not a success, or does not fit its schema, is passed over: a recording is data, and the replay
// shows only what the board would have accepted.
import type { Exchange } from '@lb/contracts'

import { deadLetterListSchema, runEventsPageSchema, runViewSchema, sentListSchema, workflowViewSchema } from './schemas'
import type { DeadLetterView, RunEventsPage, RunView, SentView, WorkflowView } from './schemas'

/** What a recorded answer tells the board. */
export type RecordedFact
  = | { kind: 'workflow', view: WorkflowView }
    | { kind: 'run-started', view: RunView, replay: boolean }
    | { kind: 'run-view', view: RunView }
    | { kind: 'events', runId: string, page: RunEventsPage }
    | { kind: 'sent', rows: SentView[] }
    | { kind: 'dead-letters', rows: DeadLetterView[] }

// The paths of LB-08's routes, as a recording keeps them: a recorded path has no query string, so the
// cursor of a poll and the chain a list was asked for are not part of it. An identifier is a UUID, a step's id is a lowercase word.
const WORKFLOWS = /^\/api\/lb08\/workflows$/
const WORKFLOW = /^\/api\/lb08\/workflows\/[\w-]{1,64}$/
const START = /^\/api\/lb08\/workflows\/[\w-]{1,64}\/runs$/
const RUN = /^\/api\/lb08\/runs\/[\w-]{1,64}$/
const EVENTS = /^\/api\/lb08\/runs\/([\w-]{1,64})\/events$/
const REPLAY = /^\/api\/lb08\/runs\/[\w-]{1,64}\/replay$/
const DECISION = /^\/api\/lb08\/runs\/[\w-]{1,64}\/steps\/[a-z][a-z0-9_]{0,31}\/decision$/
const DEAD_LETTER_REPLAY = /^\/api\/lb08\/dead-letters\/[\w-]{1,64}\/replay$/
const SENT = /^\/api\/lb08\/sent$/
const DEAD_LETTERS = /^\/api\/lb08\/dead-letters$/

/** Reads a recorded exchange into what it tells the board, or undefined when it is not an answer the board would accept. */
export function factOf(exchange: Exchange): RecordedFact | undefined {
  const { method, path } = exchange.request
  if (exchange.response.status < 200 || exchange.response.status >= 300) return undefined
  const body = exchange.response.body
  if (method === 'POST' && WORKFLOWS.test(path)) return parse(workflowViewSchema.safeParse(body), view => ({ kind: 'workflow', view }))
  if (method === 'GET' && WORKFLOW.test(path)) return parse(workflowViewSchema.safeParse(body), view => ({ kind: 'workflow', view }))
  if (method === 'PUT' && WORKFLOW.test(path)) return parse(workflowViewSchema.safeParse(body), view => ({ kind: 'workflow', view }))
  if (method === 'POST' && START.test(path)) return parse(runViewSchema.safeParse(body), view => ({ kind: 'run-started', view, replay: false }))
  if (method === 'POST' && (REPLAY.test(path) || DEAD_LETTER_REPLAY.test(path))) return parse(runViewSchema.safeParse(body), view => ({ kind: 'run-started', view, replay: true }))
  if (method === 'POST' && DECISION.test(path)) return parse(runViewSchema.safeParse(body), view => ({ kind: 'run-view', view }))
  if (method === 'GET' && RUN.test(path)) return parse(runViewSchema.safeParse(body), view => ({ kind: 'run-view', view }))
  if (method === 'GET' && EVENTS.test(path)) {
    const runId = EVENTS.exec(path)?.[1] ?? ''
    return parse(runEventsPageSchema.safeParse(body), page => ({ kind: 'events', runId, page }))
  }
  if (method === 'GET' && SENT.test(path)) return parse(sentListSchema.safeParse(body), rows => ({ kind: 'sent', rows }))
  if (method === 'GET' && DEAD_LETTERS.test(path)) return parse(deadLetterListSchema.safeParse(body), rows => ({ kind: 'dead-letters', rows }))
  return undefined
}

/** Turns a successful parse into a fact, and a failed one into nothing. */
function parse<T>(result: { success: true, data: T } | { success: false }, make: (data: T) => RecordedFact): RecordedFact | undefined {
  return result.success ? make(result.data) : undefined
}
