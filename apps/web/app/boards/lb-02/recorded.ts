// How a conversation is kept in a recording and read back from one. A recording (packages/contracts,
// replay/recording.ts) is a list of requests and the answers they got, and LB-02's conversation is a
// WebSocket, not requests. So each frame the board sent is kept as the request it stands for and the
// event the server sent back as its answer, under paths that exist only in recordings (they are
// not routes of the API):
//
//   GET  /api/lb02/calendar              the snapshot of the calendar the conversation opened on
//   POST /api/lb02/socket/hello          the hello (never with its token), answered by the `ready` event
//   POST /api/lb02/socket/message        one message of the visitor's, answered by the concierge's `reply`
//                                        and the calendar changes that came with it
//   GET  /api/lb02/conversations/<id>    the conversation in full at the end: the confirmation and the handoff
//
// Both the recorder (scripts/record/lb02.ts) and the board's replay use this file, so what one writes
// the other reads. It imports nothing from the site.
import { z } from 'zod'

import { calendarSchema, conversationSchema } from './schemas.ts'
import { calendarEventSchema, readySchema, replySchema } from './wire.ts'

/** The paths a recording keeps a conversation under. */
export const RECORDED_PATHS = {
  calendar: '/api/lb02/calendar',
  hello: '/api/lb02/socket/hello',
  message: '/api/lb02/socket/message',
  conversationPrefix: '/api/lb02/conversations/',
} as const

/** What the recorder kept of the hello: only which conversation it asked for, never the token. */
export const recordedHelloRequestSchema = z.strictObject({ conversation: z.string().nullable() })

/** What the visitor said, and how many minutes passed before they said it (a hold running out, for one). */
export const recordedMessageRequestSchema = z.strictObject({
  text: z.string().min(1).max(500),
  waitMinutes: z.int().min(0).max(60),
})

/** The concierge's answer to a message, and the calendar changes that reached the conversation since its last answer. */
export const recordedTurnSchema = z.strictObject({
  reply: replySchema,
  calendar: z.array(calendarEventSchema).max(30),
})

/** One recorded exchange of a conversation, read by what its path says it is. */
export type RecordedExchange
  = | { kind: 'calendar', snapshot: z.infer<typeof calendarSchema> }
    | { kind: 'hello', ready: z.infer<typeof readySchema> }
    | { kind: 'message', request: z.infer<typeof recordedMessageRequestSchema>, turn: z.infer<typeof recordedTurnSchema> }
    | { kind: 'conversation', detail: z.infer<typeof conversationSchema> }

/** Reads a recorded exchange, or returns undefined when it is none of the four kinds or does not fit its schema. */
export function readRecordedExchange(exchange: { request: { path: string, body?: unknown }, response: { status: number, body?: unknown } }): RecordedExchange | undefined {
  const { path } = exchange.request
  if (path === RECORDED_PATHS.calendar) {
    const snapshot = calendarSchema.safeParse(exchange.response.body)
    return snapshot.success ? { kind: 'calendar', snapshot: snapshot.data } : undefined
  }
  if (path === RECORDED_PATHS.hello) {
    const ready = readySchema.safeParse(exchange.response.body)
    return ready.success ? { kind: 'hello', ready: ready.data } : undefined
  }
  if (path === RECORDED_PATHS.message) {
    const request = recordedMessageRequestSchema.safeParse(exchange.request.body)
    const turn = recordedTurnSchema.safeParse(exchange.response.body)
    return request.success && turn.success ? { kind: 'message', request: request.data, turn: turn.data } : undefined
  }
  if (path.startsWith(RECORDED_PATHS.conversationPrefix)) {
    const detail = conversationSchema.safeParse(exchange.response.body)
    return detail.success ? { kind: 'conversation', detail: detail.data } : undefined
  }
  return undefined
}
