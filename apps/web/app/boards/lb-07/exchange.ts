// Reading a recorded exchange the way the board reads the API's own answer. A recording of a sample is
// the requests the board made and the answers it got; the replay hands those answers back one after
// another. Each answer is recognised by its request (the method and the path), checked with the schema the
// live call is checked with, and turned into the same kind of fact the live calls produce, so a replay and
// a live run drive the board through one set of functions. An answer that is not a success, or does not
// fit its schema, is passed over: a recording is data, and the replay shows only what the board would
// have accepted.
import type { Exchange } from '@lb/contracts'

import { lb07EvidenceViewSchema, lb07ReportSchema, lb07RunViewSchema, lb07TestViewSchema } from './schemas'
import type { Lb07EvidenceView, Lb07Report, Lb07RunView, Lb07TestView } from './schemas'

/** What a recorded answer tells the board. */
export type RecordedFact
  = | { kind: 'started', view: Lb07RunView }
    | { kind: 'view', view: Lb07RunView }
    | { kind: 'report', report: Lb07Report }
    | { kind: 'test', test: Lb07TestView }
    | { kind: 'evidence', evidence: Lb07EvidenceView }

// The paths of LB-07's routes, as a recording keeps them. A run's id is a UUID, an evidence's `e` and a number.
const START = /^\/api\/lb07\/runs$/
const VIEW = /^\/api\/lb07\/runs\/[\w-]{1,64}$/
const REPORT = /^\/api\/lb07\/runs\/[\w-]{1,64}\/report$/
const TEST = /^\/api\/lb07\/runs\/[\w-]{1,64}\/test$/
const EVIDENCE = /^\/api\/lb07\/runs\/[\w-]{1,64}\/evidence\/e\d{1,3}$/

/** Turns a successful parse into a fact, and a failed one into nothing. */
function parse<T>(result: { success: true, data: T } | { success: false }, make: (data: T) => RecordedFact): RecordedFact | undefined {
  return result.success ? make(result.data) : undefined
}

/** Reads a recorded exchange into what it tells the board, or undefined when it is not an answer the board would accept. */
export function factOf(exchange: Exchange): RecordedFact | undefined {
  const { method, path } = exchange.request
  if (exchange.response.status < 200 || exchange.response.status >= 300) return undefined
  const body = exchange.response.body
  if (method === 'POST' && START.test(path)) return parse(lb07RunViewSchema.safeParse(body), view => ({ kind: 'started', view }))
  if (method !== 'GET') return undefined
  if (VIEW.test(path)) return parse(lb07RunViewSchema.safeParse(body), view => ({ kind: 'view', view }))
  if (REPORT.test(path)) return parse(lb07ReportSchema.safeParse(body), report => ({ kind: 'report', report }))
  if (TEST.test(path)) return parse(lb07TestViewSchema.safeParse(body), test => ({ kind: 'test', test }))
  if (EVIDENCE.test(path)) return parse(lb07EvidenceViewSchema.safeParse(body), evidence => ({ kind: 'evidence', evidence }))
  return undefined
}
