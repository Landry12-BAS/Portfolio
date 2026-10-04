// The wire protocol of LB-09's WebSocket, as the page speaks it: the one frame the page sends and the
// events the server may send, each a strict Zod schema, so a frame is exactly what the protocol says
// or it is refused (services/django-systems/lb09/events.py holds the Pydantic models these mirror,
// and its README the protocol). A frame that does not fit is never shown: the connection is closed
// instead (fail closed, see socket.ts). This file imports nothing from the site, so the sample
// recorder and the mock back end's tests load it as it is.
import { z } from 'zod'
import { failureSchema, stageSchema } from './schemas.ts'

/** The most a text frame from the server may weigh, in characters: a state is a few hundred. */
export const MAX_SERVER_FRAME_LENGTH = 4_096

/** The reasons the server closes a connection (lb09/events.py, CloseCode). */
export const CLOSE_CODES = {
  normal: 1000,
  unsupported: 1003,
  tooBig: 1009,
  unavailable: 1011,
  tryAgainLater: 1013,
  badFrame: 4400,
  unauthorized: 4401,
  notFound: 4404,
  timedOut: 4408,
} as const

/** The code the page closes with when the server sent something the protocol does not allow. */
export const CLOSE_CODE_MALFORMED = 4000

// A meeting's public ID: URL-safe characters, 16 to 24 of them (lb09/events.py).
const MEETING_ID = /^[\w-]{16,24}$/

/** The codes of the events that say something can't be done (lb09/events.py, ErrorCode). */
export const ERROR_CODES = ['invalid_frame', 'already_said_hello', 'meeting_gone', 'too_many_connections', 'too_many_frames', 'unavailable'] as const

/** Where a meeting stands, as the socket says it: the same fields as the API's meeting, without the words. */
export const stateEventSchema = z.strictObject({
  type: z.literal('state'),
  meeting: z.string().regex(MEETING_ID),
  status: z.enum(['received', 'processing', 'done', 'failed']),
  stage: stageSchema,
  failure: failureSchema.nullable(),
  run_id: z.string().max(64),
  model_calls: z.int().nonnegative().max(10),
  dropped_items: z.int().nonnegative().max(100),
  updated_at: z.iso.datetime({ offset: true }),
})

/** Something that can't be done, with a code the page words itself. */
export const errorEventSchema = z.strictObject({
  type: z.literal('error'),
  code: z.enum(ERROR_CODES),
  message: z.string().max(300),
})

/** Every event the server may send. */
export const serverEventSchema = z.discriminatedUnion('type', [stateEventSchema, errorEventSchema])

/** A state event. */
export type StateEvent = z.infer<typeof stateEventSchema>
/** An error event. */
export type ErrorEvent = z.infer<typeof errorEventSchema>
/** Any event the server may send. */
export type ServerEvent = z.infer<typeof serverEventSchema>

/** Writes the hello frame: the visitor's pass and the meeting to follow. */
export function helloText(token: string, meeting: string): string {
  if (!MEETING_ID.test(meeting)) throw new Error('Not a meeting ID.')
  return JSON.stringify({ type: 'hello', token, meeting })
}

/** Reads a frame from the server as an event of the protocol, or returns undefined for anything that is not one. */
export function parseServerFrame(data: unknown): ServerEvent | undefined {
  if (typeof data !== 'string' || data.length > MAX_SERVER_FRAME_LENGTH) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  }
  catch {
    return undefined
  }
  const read = serverEventSchema.safeParse(parsed)
  return read.success ? read.data : undefined
}
