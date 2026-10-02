// LB-02's conversations and the connections open to them, as the mock plays the real service
// (services/django-systems/lb02/consumers.py), apart from the transport: a connection gets text
// frames and hands text frames back, so the same hub serves a real WebSocket in the end-to-end tests
// and an in-memory stand-in in the unit tests. It speaks the protocol exactly: the first frame must be
// a hello with a good token within the hello timeout, the conversation is started or resumed
// (a visitor's own, never another's), `ready` carries the whole transcript, messages are taken one at
// a time, a frame that is not in the protocol is an error event or, before the hello, a close, and the
// live calendar reaches every open connection from its own conversation's point of view.
import { randomBytes } from 'node:crypto'

import { MockCalendar } from './calendar.ts'
import type { OfferingSeed, SlotChange } from './calendar.ts'
import { MESSAGES_PER_CONVERSATION, MockConcierge, newConversation, stepOf } from './concierge.ts'
import type { MockConversation, TurnOutput } from './concierge.ts'
import { turnSpans } from './spans.ts'
import type { MockSpan } from '../spans.ts'
import { isoMoment } from './time.ts'

/** The close codes the real service uses (lb02/events.py, CloseCode). */
export const CLOSE = { unsupported: 1003, tooBig: 1009, unavailable: 1011, badFrame: 4400, unauthorized: 4401, notFound: 4404, timedOut: 4408, tooManyConversations: 4429 } as const

/** The longest frame the service takes, in bytes (lb02/limits.py). */
export const MAX_FRAME_BYTES = 4_096
/** The longest message, in characters. */
export const MAX_MESSAGE_LENGTH = 500
/** How long a conversation, its holds and its bookings are kept. */
export const LIFETIME_MS = 24 * 60 * 60 * 1000

/** What a hub needs from the way frames travel. */
export interface Transport {
  send: (text: string) => void
  close: (code: number, reason?: string) => void
}

/** What a test may choose about the hub. */
export interface HubOptions {
  // The clock, in Unix milliseconds, for the calendar and the conversations. Tests move it to run holds out.
  now: () => number
  // Reads a visitor token and returns the visitor's session, or undefined when it is not good.
  verify: (token: string) => string | undefined
  // How long a connection has to say hello, and how long it may be silent after: 10 seconds and 15 minutes in the real service.
  helloTimeoutMs?: number
  idleTimeoutMs?: number
  // How many messages a conversation takes before it is handed to a person (30), and how many a visitor may start in a day (10).
  messagesPerConversation?: number
  conversationsPerDay?: number
  // How long the concierge "thinks" about a message, so a test can see the working state.
  thinkMs?: number
}

/** The error codes of the protocol (lb02/events.py, ErrorCode). */
type ErrorCode = 'invalid_frame' | 'message_too_long' | 'already_said_hello' | 'conversation_gone' | 'too_many_conversations' | 'unavailable'

// The sentences the real service sends with each code. The page never shows them: it words each code itself.
const ERROR_SENTENCES: Record<ErrorCode, string> = {
  invalid_frame: 'That message wasn\'t understood.',
  message_too_long: `A message may be at most ${MAX_MESSAGE_LENGTH} characters.`,
  already_said_hello: 'This connection is already open.',
  conversation_gone: 'That conversation doesn\'t exist, or it has ended and its data has been removed.',
  too_many_conversations: 'You have started as many conversations today as you may. Come back tomorrow.',
  unavailable: 'The concierge can\'t answer right now.',
}

/** A frame a client may send, once it has been read strictly. */
type Frame = { type: 'hello', token: string, conversation: string | null } | { type: 'message', text: string }

/** Tells whether a character is a control character, other than a tab or a line break. */
function isControl(code: number): boolean {
  return (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) || code === 0x7F
}

/** Cleans a visitor's message the way the real service does: control characters out, blank ends off. */
function cleanText(text: string): string {
  return [...text].filter(character => !isControl(character.codePointAt(0) ?? 0)).join('').trim()
}

/** Reads a text frame as a frame of the protocol, or returns an error: `too_long` for a message that only failed for its length. */
export function readFrame(text: string): { frame: Frame } | { problem: 'invalid' | 'too_long' } {
  let json: unknown
  try {
    json = JSON.parse(text)
  }
  catch {
    return { problem: 'invalid' }
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { problem: 'invalid' }
  const record = json as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  if (record.type === 'hello' && keys === 'conversation,token,type') {
    const conversation = record.conversation
    const idLike = typeof conversation === 'string' && /^[\w-]{16,24}$/.test(conversation)
    if (typeof record.token === 'string' && record.token.length >= 1 && record.token.length <= 2_048 && (conversation === null || idLike)) {
      return { frame: { type: 'hello', token: record.token, conversation: conversation as string | null } }
    }
    return { problem: 'invalid' }
  }
  if (record.type === 'message' && keys === 'text,type' && typeof record.text === 'string') {
    const cleaned = cleanText(record.text)
    if (cleaned.length > MAX_MESSAGE_LENGTH) return { problem: 'too_long' }
    return cleaned.length === 0 ? { problem: 'invalid' } : { frame: { type: 'message', text: cleaned } }
  }
  return { problem: 'invalid' }
}

/** Lets a timer die with the process, where the timer is one that can (a test's fake timers and a DOM's may not be). */
function unref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
}

/** Makes a random ID of URL-safe characters, as the real conversation IDs look. */
function newPublicId(): string {
  return randomBytes(12).toString('base64url')
}

/** The conversations, the calendar and the open connections of the mock LB-02. */
export class Lb02Hub {
  readonly calendar: MockCalendar
  readonly conversations = new Map<string, MockConversation>()
  readonly options: Required<Omit<HubOptions, 'verify' | 'now'>> & Pick<HubOptions, 'verify' | 'now'>
  readonly #concierge: MockConcierge
  readonly #connections = new Set<Lb02Connection>()
  readonly #spans = new Map<string, MockSpan[]>()
  #turns = 0

  /** Lays the calendar out and waits for visitors. */
  constructor(offerings: OfferingSeed[], options: HubOptions) {
    this.options = {
      helloTimeoutMs: 10_000,
      idleTimeoutMs: 900_000,
      messagesPerConversation: MESSAGES_PER_CONVERSATION,
      conversationsPerDay: 10,
      thinkMs: 0,
      ...options,
    }
    this.calendar = new MockCalendar(offerings, options.now)
    this.#concierge = new MockConcierge(this.calendar, options.now, () => this.options.messagesPerConversation)
  }

  /** Changes the hub's limits while it runs, for a test that wants a conversation to hit one quickly. Only numbers are taken. */
  configure(changes: Record<string, unknown>): void {
    const settable = ['helloTimeoutMs', 'idleTimeoutMs', 'messagesPerConversation', 'conversationsPerDay', 'thinkMs'] as const
    for (const key of settable) {
      const value = changes[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) this.options[key] = value
    }
  }

  /** Opens a connection on a transport. Nothing it says is trusted until its hello has been checked. */
  open(transport: Transport): Lb02Connection {
    const connection = new Lb02Connection(this, transport)
    this.#connections.add(connection)
    return connection
  }

  /** Forgets a connection that closed. */
  forget(connection: Lb02Connection): void {
    this.#connections.delete(connection)
  }

  /** How many connections are open and have said hello. */
  get openConnections(): number {
    return [...this.#connections].filter(connection => connection.conversation !== undefined).length
  }

  /** The conversations of a visitor, newest first. */
  ownedBy(session: string): MockConversation[] {
    return [...this.conversations.values()].filter(item => item.session === session).sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Tells whether a visitor has started as many conversations today as they may. */
  startedToday(session: string): number {
    const midnight = new Date(this.options.now()).setUTCHours(0, 0, 0, 0)
    return this.ownedBy(session).filter(item => item.createdAt >= midnight).length
  }

  /** Starts a conversation for a visitor. */
  start(session: string): MockConversation {
    const now = this.options.now()
    const id = newPublicId()
    const conversation = newConversation(id, session, `run-${randomBytes(10).toString('hex')}`, now, LIFETIME_MS)
    this.conversations.set(id, conversation)
    return conversation
  }

  /** Finds one of a visitor's own conversations: another visitor's is exactly as missing as one that isn't there. */
  find(session: string, id: string): MockConversation | undefined {
    const found = this.conversations.get(id)
    return found?.session === session && found.expiresAt > this.options.now() ? found : undefined
  }

  /** Takes in a message, as the service does before it starts to answer: it is counted and kept in the transcript. Says whether it was the first. */
  receive(conversation: MockConversation, text: string): boolean {
    return this.#concierge.receive(conversation, text)
  }

  /** Answers a message that was taken in and writes the turn's spans. */
  respond(conversation: MockConversation, text: string, wasFirst: boolean): { output: TurnOutput, step: string } {
    const startedAt = this.options.now()
    const output = this.#concierge.respond(conversation, text, wasFirst)
    this.#turns += 1
    const step = stepOf(conversation, this.calendar)
    this.#spans.set(conversation.runId, [...(this.#spans.get(conversation.runId) ?? []), ...turnSpans(conversation.runId, this.#turns, startedAt, output, step)])
    return { output, step }
  }

  /** Where the conversation stands, as `ready` and `reply` both say it. */
  stateOf(conversation: MockConversation): Record<string, unknown> {
    const calendar = this.calendar
    const step = stepOf(conversation, calendar)
    const language = conversation.language
    const options = step === 'availability'
      ? conversation.offered.flatMap((id, index) => {
          const slot = calendar.slot(id)
          return slot ? [{ number: index + 1, slot: slot.id, offering: slot.offering, starts_at: isoMoment(slot.startsAt), ends_at: isoMoment(slot.endsAt) }] : []
        })
      : []
    const held = calendar.holdOf(conversation.id)
    const booked = calendar.bookingOf(conversation.id)
    const heldSlot = held ? calendar.slot(held.slot) : undefined
    const bookedSlot = booked ? calendar.slot(booked.slot) : undefined
    return {
      step,
      language,
      messages_left: Math.max(this.options.messagesPerConversation - conversation.messagesUsed, 0),
      closed: step === 'handoff',
      options,
      hold: held && heldSlot ? { slot: heldSlot.id, offering: heldSlot.offering, starts_at: isoMoment(heldSlot.startsAt), ends_at: isoMoment(heldSlot.endsAt), expires_at: isoMoment(held.heldUntil) } : null,
      booking: booked && bookedSlot ? { code: booked.code, slot: bookedSlot.id, offering: bookedSlot.offering, starts_at: isoMoment(bookedSlot.startsAt), ends_at: isoMoment(bookedSlot.endsAt), party_size: booked.partySize, to: conversation.details.email ?? '' } : null,
    }
  }

  /** The spans a conversation's run has written so far, or undefined for a run nobody started. */
  spansOf(runId: string): MockSpan[] | undefined {
    return this.#spans.get(runId)
  }

  /** Tells every open connection about slots that changed, each as its own conversation sees them. */
  announce(changes: SlotChange[]): void {
    if (changes.length === 0) return
    for (const connection of this.#connections) connection.tellCalendar(changes)
  }

  /** The minute-by-minute sweep: holds that ran out are freed and the live calendar hears of it. */
  sweep(): void {
    this.announce(this.calendar.sweep())
  }

  /** The nightly reset: what visitors made is cleared, the next 14 days are laid out, and every connection is told to load the snapshot again. */
  resetCalendar(): void {
    for (const conversation of this.conversations.values()) conversation.lapsedHold = undefined
    this.calendar.reset()
    for (const connection of this.#connections) connection.tellReset()
  }

  /** Closes every open connection with a code, as a restart or a dropped network would. */
  dropAll(code: number): void {
    for (const connection of [...this.#connections]) connection.drop(code)
  }

  /** Forgets every conversation, span and connection, and lays the calendar out afresh. */
  reset(): void {
    this.dropAll(1001)
    this.conversations.clear()
    this.#spans.clear()
    this.calendar.reset()
  }
}

/** One visitor's connection: the first frame must be a hello, and after it the conversation is theirs to talk in. */
export class Lb02Connection {
  readonly #hub: Lb02Hub
  readonly #transport: Transport
  #conversation: MockConversation | undefined
  #closed = false
  #helloTimer: ReturnType<typeof setTimeout> | undefined
  #idleTimer: ReturnType<typeof setTimeout> | undefined
  // Messages are taken one at a time, in the order they came.
  #queue: Promise<void> = Promise.resolve()

  /** Waits for the hello, which has to come within the hub's timeout. */
  constructor(hub: Lb02Hub, transport: Transport) {
    this.#hub = hub
    this.#transport = transport
    this.#helloTimer = setTimeout(() => this.#shut(CLOSE.timedOut), hub.options.helloTimeoutMs)
    unref(this.#helloTimer)
  }

  /** The conversation this connection is in, once its hello has been accepted. */
  get conversation(): MockConversation | undefined {
    return this.#conversation
  }

  /** Closes the connection from the server's side. */
  #shut(code: number): void {
    if (this.#closed) return
    this.#closed = true
    this.#stopTimers()
    this.#hub.forget(this)
    this.#transport.close(code)
  }

  /** Closes the connection as a restart or a dropped network would. */
  drop(code: number): void {
    this.#shut(code)
  }

  /** The transport says the connection is gone. */
  dispose(): void {
    this.#closed = true
    this.#stopTimers()
    this.#hub.forget(this)
  }

  /** Stops the two timers. */
  #stopTimers(): void {
    if (this.#helloTimer !== undefined) clearTimeout(this.#helloTimer)
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer)
    this.#helloTimer = undefined
    this.#idleTimer = undefined
  }

  /** Closes the connection after a quarter of an hour of silence. */
  #armIdle(): void {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => this.#shut(CLOSE.timedOut), this.#hub.options.idleTimeoutMs)
    unref(this.#idleTimer)
  }

  /** Sends an event. */
  #tell(event: object): void {
    if (!this.#closed) this.#transport.send(JSON.stringify(event))
  }

  /** Sends an error event: something that can't be done, with a code that stays the same. */
  #tellError(code: ErrorCode): void {
    this.#tell({ type: 'error', code, message: ERROR_SENTENCES[code] })
  }

  /** Takes one text frame. A binary frame is the transport's to refuse with 1003. */
  receive(text: string): void {
    if (this.#closed) return
    if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) return this.#shut(CLOSE.tooBig)
    const read = readFrame(text)
    if (this.#conversation === undefined) {
      if ('problem' in read || read.frame.type !== 'hello') return this.#shut(CLOSE.badFrame)
      return this.#greet(read.frame.token, read.frame.conversation)
    }
    if ('problem' in read) return this.#tellError(read.problem === 'too_long' ? 'message_too_long' : 'invalid_frame')
    if (read.frame.type === 'hello') return this.#tellError('already_said_hello')
    this.#armIdle()
    const message = read.frame.text
    this.#queue = this.#queue.then(() => this.#hear(message))
  }

  /** Checks the hello's token, then starts or resumes the conversation and says `ready`. */
  #greet(token: string, resume: string | null): void {
    const session = this.#hub.options.verify(token)
    if (session === undefined) return this.#shut(CLOSE.unauthorized)
    let conversation: MockConversation | undefined
    if (resume === null) {
      if (this.#hub.startedToday(session) >= this.#hub.options.conversationsPerDay) {
        this.#tellError('too_many_conversations')
        return this.#shut(CLOSE.tooManyConversations)
      }
      conversation = this.#hub.start(session)
    }
    else {
      conversation = this.#hub.find(session, resume)
      if (conversation === undefined) {
        this.#tellError('conversation_gone')
        return this.#shut(CLOSE.notFound)
      }
    }
    if (this.#helloTimer !== undefined) clearTimeout(this.#helloTimer)
    this.#helloTimer = undefined
    this.#conversation = conversation
    this.#armIdle()
    this.#tell({ type: 'ready', conversation: conversation.id, resumed: resume !== null, transcript: this.#transcript(conversation), ...this.#hub.stateOf(conversation) })
  }

  /** The transcript as the page is sent it. */
  #transcript(conversation: MockConversation): { role: string, text: string }[] {
    return conversation.lines.map(line => ({ role: line.role, text: line.text }))
  }

  /** Answers one message: `working`, a pause, and the `reply`, with the calendar told about whatever the turn changed. */
  async #hear(text: string): Promise<void> {
    const conversation = this.#conversation
    if (!conversation || this.#closed) return
    // The message is kept and counted at once, as the service does; a connection that ends before the answer leaves it unanswered.
    const wasFirst = this.#hub.receive(conversation, text)
    this.#tell({ type: 'working' })
    if (this.#hub.options.thinkMs > 0) await new Promise<void>(resolve => setTimeout(resolve, this.#hub.options.thinkMs))
    if (this.#closed) return
    const { output } = this.#hub.respond(conversation, text, wasFirst)
    // The calendar is told once the change has been committed, which is before the answer goes out.
    this.#hub.announce(output.changes)
    this.#tell({ type: 'reply', text: output.text, receipt: output.receipt ?? null, tools: output.tools, model_calls: conversation.modelCalls, ...this.#hub.stateOf(conversation) })
    this.#armIdle()
  }

  /** Tells this connection about slots that changed, from its own conversation's point of view: the slot it holds or has is `mine`. */
  tellCalendar(changes: SlotChange[]): void {
    const conversation = this.#conversation
    if (!conversation) return
    this.#tell({
      type: 'calendar',
      changes: changes.map(({ slot, state }) => ({
        slot: slot.id,
        offering: slot.offering,
        starts_at: isoMoment(slot.startsAt),
        ends_at: isoMoment(slot.endsAt),
        status: state.status,
        mine: state.owner !== undefined && state.owner === conversation.id,
        until: state.until === undefined ? null : isoMoment(state.until),
      })),
    })
  }

  /** Tells this connection the calendar was laid out afresh. */
  tellReset(): void {
    if (this.#conversation) this.#tell({ type: 'calendar_reset' })
  }
}
