// Reading a recorded exchange the way the board reads the API's own answer. A recording of a sample
// is the requests the board made and the answers it got; the replay hands those answers back one
// after another. Each answer is recognised by its request (the method and the path), checked with
// the schema the live call is checked with, and turned into the same kind of fact the live calls
// produce, so a replay and a live incident drive the board through one set of functions. An answer
// that is not a success, or does not fit its schema, is passed over: a recording is data, and the
// replay shows only what the board would have accepted.
import type { Exchange } from '@lb/contracts'
import { lb06EventsPageSchema, lb06IncidentViewSchema, lb06PostmortemViewSchema } from './schemas'
import type { Lb06EventsPage, Lb06IncidentView, Lb06PostmortemView } from './schemas'

/** What a recorded answer tells the board. */
export type RecordedFact
  = | { kind: 'started', view: Lb06IncidentView }
    | { kind: 'view', view: Lb06IncidentView }
    | { kind: 'events', incidentId: string, page: Lb06EventsPage }
    | { kind: 'postmortem', view: Lb06PostmortemView }

// The paths of LB-06's routes, as a recording keeps them: a recorded path has no query string, so the
// cursor of a poll is not part of it. An identifier is a UUID, a proposal's is `p` and a digit.
const START = /^\/api\/lb06\/incidents$/
const VIEW = /^\/api\/lb06\/incidents\/[\w-]{1,64}$/
const EVENTS = /^\/api\/lb06\/incidents\/([\w-]{1,64})\/events$/
const DECISION = /^\/api\/lb06\/incidents\/[\w-]{1,64}\/proposals\/p[1-3]\/decision$/
const ABORT = /^\/api\/lb06\/incidents\/[\w-]{1,64}\/abort$/
const POSTMORTEM = /^\/api\/lb06\/incidents\/[\w-]{1,64}\/postmortem$/

/** Turns a successful parse into a fact, and a failed one into nothing. */
function parse<T>(result: { success: true, data: T } | { success: false }, make: (data: T) => RecordedFact): RecordedFact | undefined {
  return result.success ? make(result.data) : undefined
}

/** Reads a recorded exchange into what it tells the board, or undefined when it is not an answer the board would accept. */
export function factOf(exchange: Exchange): RecordedFact | undefined {
  const { method, path } = exchange.request
  if (exchange.response.status < 200 || exchange.response.status >= 300) return undefined
  const body = exchange.response.body
  if (method === 'POST' && START.test(path)) return parse(lb06IncidentViewSchema.safeParse(body), view => ({ kind: 'started', view }))
  if (method === 'GET' && VIEW.test(path)) return parse(lb06IncidentViewSchema.safeParse(body), view => ({ kind: 'view', view }))
  if (method === 'POST' && (DECISION.test(path) || ABORT.test(path))) return parse(lb06IncidentViewSchema.safeParse(body), view => ({ kind: 'view', view }))
  if (method === 'GET' && EVENTS.test(path)) {
    const incidentId = EVENTS.exec(path)?.[1] ?? ''
    return parse(lb06EventsPageSchema.safeParse(body), page => ({ kind: 'events', incidentId, page }))
  }
  if (method === 'GET' && POSTMORTEM.test(path)) return parse(lb06PostmortemViewSchema.safeParse(body), view => ({ kind: 'postmortem', view }))
  return undefined
}
