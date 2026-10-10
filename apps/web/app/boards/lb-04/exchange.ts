// Reading a recorded exchange the way the board reads the API's own answer. A recording of a sample is
// the requests the board made and the answers it got; the replay hands those answers back one after
// another. Each answer is recognised by its request (the method and the path), checked with the schema
// the live call is checked with, and turned into the same kind of fact the live calls produce, so a
// replay and a live review drive the board through one set of functions. An answer that is not a
// success, or does not fit its schema, is passed over: a recording is data, and the replay shows only
// what the board would have accepted.
import type { Exchange } from '@lb/contracts'

import { lb04ContractViewSchema, lb04FileViewSchema, lb04PagesViewSchema, lb04RedlineSchema, lb04ReportSchema } from './schemas'
import type { Lb04ContractView, Lb04FileView, Lb04PagesView, Lb04Redline, Lb04Report } from './schemas'

/** What a recorded answer tells the board. */
export type RecordedFact
  = | { kind: 'started', view: Lb04ContractView }
    | { kind: 'view', view: Lb04ContractView }
    | { kind: 'pages', contractId: string, pages: Lb04PagesView['pages'] }
    | { kind: 'file', contractId: string, file: Lb04FileView }
    | { kind: 'report', contractId: string, report: Lb04Report }
    | { kind: 'redline', contractId: string, redline: Lb04Redline }

// The paths of LB-04's routes, as a recording keeps them: a recorded path has no query string. An identifier is a UUID, a finding's is `f` and a number.
const CONTRACTS = /^\/api\/lb04\/contracts$/
const CONTRACT = /^\/api\/lb04\/contracts\/[\w-]{1,64}$/
const PAGES = /^\/api\/lb04\/contracts\/([\w-]{1,64})\/pages$/
const FILE = /^\/api\/lb04\/contracts\/([\w-]{1,64})\/file$/
const REPORT = /^\/api\/lb04\/contracts\/([\w-]{1,64})\/report$/
const REDLINE = /^\/api\/lb04\/contracts\/([\w-]{1,64})\/findings\/f\d{1,3}\/redline$/

/** Reads a recorded exchange into what it tells the board, or undefined when it is not an answer the board would accept. */
export function factOf(exchange: Exchange): RecordedFact | undefined {
  const { method, path } = exchange.request
  if (exchange.response.status < 200 || exchange.response.status >= 300) return undefined
  const body = exchange.response.body
  if (method === 'POST' && CONTRACTS.test(path)) return parse(lb04ContractViewSchema.safeParse(body), view => ({ kind: 'started', view }))
  if (method === 'GET' && CONTRACT.test(path)) return parse(lb04ContractViewSchema.safeParse(body), view => ({ kind: 'view', view }))
  if (method === 'GET' && PAGES.test(path)) {
    const contractId = PAGES.exec(path)?.[1] ?? ''
    return parse(lb04PagesViewSchema.safeParse(body), view => ({ kind: 'pages', contractId, pages: view.pages }))
  }
  if (method === 'GET' && FILE.test(path)) {
    const contractId = FILE.exec(path)?.[1] ?? ''
    return parse(lb04FileViewSchema.safeParse(body), file => ({ kind: 'file', contractId, file }))
  }
  if (method === 'GET' && REPORT.test(path)) {
    const contractId = REPORT.exec(path)?.[1] ?? ''
    return parse(lb04ReportSchema.safeParse(body), report => ({ kind: 'report', contractId, report }))
  }
  if (method === 'POST' && REDLINE.test(path)) {
    const contractId = REDLINE.exec(path)?.[1] ?? ''
    return parse(lb04RedlineSchema.safeParse(body), redline => ({ kind: 'redline', contractId, redline }))
  }
  return undefined
}

/** Turns a successful parse into a fact, and a failed one into nothing. */
function parse<T>(result: { success: true, data: T } | { success: false }, make: (data: T) => RecordedFact): RecordedFact | undefined {
  return result.success ? make(result.data) : undefined
}
