// The words LB-06's WebSocket speaks, as the page uses them (services/node-systems/README.md, "The
// LB-06 WebSocket"). The page sends one frame, a hello with the visitor's pass, the incident and the
// number of the last event it holds. The server answers `ready` with the incident as it stands and
// the events after that number, then sends an `event` frame for every event the incident appends, or
// an `error` frame just before it closes the connection. Every frame the server sends is checked
// here with the contracts' schemas before the page looks at it; a frame that does not fit is a broken
// protocol and ends the connection (fail closed).
import { LB06_LIMITS, lb06EventSchema, lb06IncidentViewSchema } from '@lb/contracts'
import { z } from 'zod'

/** The close codes the server uses: the standard ones where one fits, and its own from 4400 up. */
export const CLOSE_CODES = {
  unsupported: 1003,
  tooBig: 1009,
  unavailable: 1011,
  tryAgainLater: 1013,
  badFrame: 4400,
  unauthorized: 4401,
  notFound: 4404,
  timedOut: 4408,
} as const

/** The code the page closes a connection with when the server broke the protocol: 1002, a protocol error. */
export const CLOSE_CODE_MALFORMED = 1002

/** The longest frame the page reads, in characters: a `ready` frame may carry the whole log, up to the log's most events. */
export const MAX_FRAME_CHARS = 2_000_000

/** What the server sends. */
export const serverFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), incident: lb06IncidentViewSchema, events: z.array(lb06EventSchema).max(LB06_LIMITS.maxEvents) }),
  z.strictObject({ type: z.literal('event'), event: lb06EventSchema }),
  z.strictObject({ type: z.literal('error'), code: z.enum(['invalid_frame', 'already_said_hello', 'too_many_connections']) }),
])

/** A frame the server sends. */
export type ServerFrame = z.infer<typeof serverFrameSchema>

/** The hello, the one frame the page sends: the visitor's pass goes here and never in the address, because addresses end up in logs. */
const helloSchema = z.strictObject({
  type: z.literal('hello'),
  token: z.string().min(1).max(1_024),
  incident: z.uuid(),
  after: z.int().min(0).max(LB06_LIMITS.maxEvents),
})

/** Makes the text of the hello, checking what goes into it. Throws when the pass or the incident is not what the server accepts. */
export function helloText(token: string, incident: string, after: number): string {
  return JSON.stringify(helloSchema.parse({ type: 'hello', token, incident, after }))
}

/** Reads one frame from the server, or returns undefined when it is not text, is too long, is not JSON, or does not fit the protocol. */
export function parseServerFrame(data: unknown): ServerFrame | undefined {
  if (typeof data !== 'string' || data.length > MAX_FRAME_CHARS) return undefined
  let json: unknown
  try {
    json = JSON.parse(data)
  }
  catch {
    return undefined
  }
  const parsed = serverFrameSchema.safeParse(json)
  return parsed.success ? parsed.data : undefined
}
