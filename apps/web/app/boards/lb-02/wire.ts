// The wire protocol of LB-02's WebSocket, as the page speaks it: every frame the page may send and
// every event the server may send, each a strict Zod schema, so a frame is exactly what the protocol
// says or it is refused (services/django-systems/lb02/events.py holds the Pydantic models these
// mirror, and its README the protocol). The server's text is the output of a system a model drives,
// so each field is typed and bounded here, and a frame that does not fit is never shown: the
// connection is closed instead (fail closed, see socket.ts). This file imports nothing from the
// site, so the sample recorder and the mock back end's tests load it as it is.
import { z } from 'zod'

/** The longest message the concierge takes, in characters (lb02/limits.py). */
export const MAX_MESSAGE_LENGTH = 500
/** The most messages a conversation may hold (the datasheet's limit). */
export const MESSAGES_PER_CONVERSATION = 30
/** The most a text frame from the server may weigh, in characters: a resumed conversation brings its whole transcript. */
export const MAX_SERVER_FRAME_LENGTH = 262_144

/** The reasons the server closes a connection (lb02/events.py, CloseCode). */
export const CLOSE_CODES = {
  unsupported: 1003,
  tooBig: 1009,
  unavailable: 1011,
  badFrame: 4400,
  unauthorized: 4401,
  notFound: 4404,
  timedOut: 4408,
  tooManyConversations: 4429,
} as const

/** The code the page closes with when the server sent something the protocol does not allow. */
export const CLOSE_CODE_MALFORMED = 4000

// A conversation's public ID: URL-safe characters, 16 to 24 of them (lb02/events.py).
const CONVERSATION_ID = /^[\w-]{16,24}$/
// An offering's key, such as `roasting-workshop`.
const OFFERING_KEY = z.string().regex(/^[a-z][a-z-]{0,39}$/)
// A moment in ISO 8601, with a `Z` or an offset: the server writes UTC.
const MOMENT = z.iso.datetime({ offset: true })

/** The steps a conversation goes through, decided by the facts and not by the model (lb02/states.py). */
export const STEPS = ['details', 'availability', 'hold', 'done', 'handoff'] as const
/** Where a conversation stands. */
export const stepSchema = z.enum(STEPS)

/** The kinds of message the concierge's code writes itself (lb02/messages.py, Receipt). */
export const RECEIPTS = ['hold_placed', 'booking_confirmed', 'hold_expired', 'slot_taken', 'injection_refused', 'unchecked', 'handed_off', 'message_limit', 'budget_spent', 'unavailable', 'oops', 'closed'] as const
/** One kind of code-written message. */
export const receiptSchema = z.enum(RECEIPTS)

/** The codes of the events that say something can't be done (lb02/events.py, ErrorCode). */
export const ERROR_CODES = ['invalid_frame', 'message_too_long', 'already_said_hello', 'conversation_gone', 'too_many_conversations', 'unavailable'] as const
/** One code of an error event. */
export const errorCodeSchema = z.enum(ERROR_CODES)

/** Whether a slot is free, held (for five minutes) or booked. */
export const slotStatusSchema = z.enum(['free', 'held', 'booked'])

/** One line of a transcript: who said it, or that it is a note of something the concierge did. */
export const lineSchema = z.strictObject({
  role: z.enum(['visitor', 'concierge', 'action']),
  text: z.string().max(2_100),
})

/** A slot on offer, by the number the concierge holds it with. */
export const optionSchema = z.strictObject({
  number: z.int().min(1).max(20),
  slot: z.int().nonnegative(),
  offering: OFFERING_KEY,
  starts_at: MOMENT,
  ends_at: MOMENT,
})

/** The slot a conversation holds, and when the hold runs out. */
export const holdSchema = z.strictObject({
  slot: z.int().nonnegative(),
  offering: OFFERING_KEY,
  starts_at: MOMENT,
  ends_at: MOMENT,
  expires_at: MOMENT,
})

/** A conversation's booking: its code, its slot, and the address its recorded confirmation was made out to (never sent to). */
export const bookingSchema = z.strictObject({
  code: z.string().min(1).max(40),
  slot: z.int().nonnegative(),
  offering: OFFERING_KEY,
  starts_at: MOMENT,
  ends_at: MOMENT,
  party_size: z.int().min(1).max(12),
  to: z.string().max(254),
})

/** A tool the concierge's model called: which, whether the booking rules let it run, and how it went. The name may be one the model made up. */
export const toolUseSchema = z.strictObject({
  name: z.string().max(64),
  executed: z.boolean(),
  ok: z.boolean(),
  error: z.string().max(200),
})

// What `ready` and `reply` both say about where the conversation stands.
const stateShape = {
  step: stepSchema,
  language: z.string().min(2).max(8),
  messages_left: z.int().min(0).max(MESSAGES_PER_CONVERSATION),
  closed: z.boolean(),
  options: z.array(optionSchema).max(10),
  hold: holdSchema.nullable(),
  booking: bookingSchema.nullable(),
}

/** The conversation is open: its ID, whether it resumed an earlier one, its whole transcript and where it stands. */
export const readySchema = z.strictObject({
  type: z.literal('ready'),
  conversation: z.string().regex(CONVERSATION_ID),
  resumed: z.boolean(),
  transcript: z.array(lineSchema).max(200),
  ...stateShape,
})

/** The message was accepted, and the concierge is working on it. */
export const workingSchema = z.strictObject({ type: z.literal('working') })

/** The concierge's answer, and where the booking stands now. `receipt` names the kind of message the code wrote itself. */
export const replySchema = z.strictObject({
  type: z.literal('reply'),
  text: z.string().max(8_000),
  receipt: receiptSchema.nullable(),
  tools: z.array(toolUseSchema).max(10),
  // The model calls the conversation has used so far.
  model_calls: z.int().nonnegative().max(1_000),
  ...stateShape,
})

/** One slot's new state, as this conversation sees it. */
export const slotChangeSchema = z.strictObject({
  slot: z.int().nonnegative(),
  offering: OFFERING_KEY,
  starts_at: MOMENT,
  ends_at: MOMENT,
  status: slotStatusSchema,
  mine: z.boolean(),
  until: MOMENT.nullable(),
})

/** Slots that changed. */
export const calendarEventSchema = z.strictObject({
  type: z.literal('calendar'),
  changes: z.array(slotChangeSchema).max(200),
})

/** The demo calendar was laid out afresh: load the snapshot again. */
export const calendarResetSchema = z.strictObject({ type: z.literal('calendar_reset') })

/** Something that can't be done, with a code that stays the same. The sentence beside it is never shown: the page words each code itself. */
export const problemEventSchema = z.strictObject({
  type: z.literal('error'),
  code: errorCodeSchema,
  message: z.string().max(300),
})

/** Every event the server may send. Any other frame is refused. */
export const serverEventSchema = z.discriminatedUnion('type', [
  readySchema,
  workingSchema,
  replySchema,
  calendarEventSchema,
  calendarResetSchema,
  problemEventSchema,
])

/** The first frame a page sends: its visitor token, and the conversation to resume (none starts a new one). */
export const helloFrameSchema = z.strictObject({
  type: z.literal('hello'),
  token: z.string().min(1).max(2_048),
  conversation: z.string().regex(CONVERSATION_ID).nullable(),
})

/** A message of the visitor's, after the page has trimmed it: one to 500 characters. */
export const messageFrameSchema = z.strictObject({
  type: z.literal('message'),
  text: z.string().min(1).max(MAX_MESSAGE_LENGTH),
})

/** Every frame the page may send. */
export const clientFrameSchema = z.discriminatedUnion('type', [helloFrameSchema, messageFrameSchema])

/** A conversation's step. */
export type Step = z.infer<typeof stepSchema>
/** A kind of message the code writes itself. */
export type Receipt = z.infer<typeof receiptSchema>
/** The code of an error event. */
export type ErrorCode = z.infer<typeof errorCodeSchema>
/** Whether a slot is free, held or booked. */
export type SlotStatus = z.infer<typeof slotStatusSchema>
/** One line of a transcript. */
export type Line = z.infer<typeof lineSchema>
/** A slot on offer. */
export type Option = z.infer<typeof optionSchema>
/** The slot a conversation holds. */
export type Hold = z.infer<typeof holdSchema>
/** A conversation's booking. */
export type Booking = z.infer<typeof bookingSchema>
/** A tool call of the concierge's model. */
export type ToolUse = z.infer<typeof toolUseSchema>
/** The `ready` event. */
export type ReadyEvent = z.infer<typeof readySchema>
/** The `reply` event. */
export type ReplyEvent = z.infer<typeof replySchema>
/** A slot's new state. */
export type SlotChange = z.infer<typeof slotChangeSchema>
/** The `calendar` event. */
export type CalendarEvent = z.infer<typeof calendarEventSchema>
/** An event the server may send. */
export type ServerEvent = z.infer<typeof serverEventSchema>
/** A frame the page may send. */
export type ClientFrame = z.infer<typeof clientFrameSchema>
/** Where a conversation stands, as `ready` and `reply` both say it. */
export type ConversationState = Pick<ReadyEvent, 'step' | 'language' | 'messages_left' | 'closed' | 'options' | 'hold' | 'booking'>

/**
 * Reads one frame from the server as an event, or returns undefined for anything the protocol does
 * not allow: a binary frame, text that is too long or not JSON, a type nobody defined, a field
 * nobody planned for. The caller closes the connection on undefined and never looks at the frame again.
 */
export function parseServerFrame(data: unknown): ServerEvent | undefined {
  if (typeof data !== 'string' || data.length > MAX_SERVER_FRAME_LENGTH) return undefined
  let json: unknown
  try {
    json = JSON.parse(data)
  }
  catch {
    return undefined
  }
  const parsed = serverEventSchema.safeParse(json)
  return parsed.success ? parsed.data : undefined
}

/** Writes the hello frame for a token, as the text to send. */
export function helloText(token: string, conversation: string | null): string {
  return JSON.stringify(helloFrameSchema.parse({ type: 'hello', token, conversation }))
}

/** Writes a message frame for the visitor's text (trimmed), as the text to send. Throws when the text is empty or too long. */
export function messageText(text: string): string {
  return JSON.stringify(messageFrameSchema.parse({ type: 'message', text: text.trim() }))
}
