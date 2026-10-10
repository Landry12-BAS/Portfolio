// Reading a recorded exchange the way the board reads the API's own answer. A recording of a sample is the requests
// the board made and the answers it got: the run started, then read until it ended. The replay hands those answers
// back one after another; each is recognised by its request (the method and the path), checked with the schema the
// live call is checked with, and turned into the same kind of fact the live calls produce, so a replay and a live
// run drive the board through one set of functions. An answer that is not a success, or does not fit its schema, is
// passed over: a recording is data, and the replay shows only what the board would have accepted.
import type { Exchange } from '@lb/contracts'

import { runSchema, startedSchema } from './schemas'
import type { Lb10Run, Lb10Started } from './schemas'

/** What a recorded answer tells the board: a run was started, or a run was read. */
export type RecordedFact
  = | { kind: 'started', started: Lb10Started }
    | { kind: 'view', run: Lb10Run }

// The paths of LB-10's routes, as a recording keeps them. A run's ID is 8 to 64 URL-safe characters.
const START = /^\/api\/lb10\/runs$/
const VIEW = /^\/api\/lb10\/runs\/[\w-]{8,64}$/

/** Reads a recorded exchange into what it tells the board, or undefined when it is not an answer the board would accept. */
export function factOf(exchange: Exchange): RecordedFact | undefined {
  const { method, path } = exchange.request
  if (exchange.response.status < 200 || exchange.response.status >= 300) return undefined
  const body = exchange.response.body
  if (method === 'POST' && START.test(path)) {
    const parsed = startedSchema.safeParse(body)
    return parsed.success ? { kind: 'started', started: parsed.data } : undefined
  }
  if (method === 'GET' && VIEW.test(path)) {
    const parsed = runSchema.safeParse(body)
    return parsed.success ? { kind: 'view', run: parsed.data } : undefined
  }
  return undefined
}
