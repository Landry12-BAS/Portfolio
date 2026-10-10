// LB-02 as the mock back end plays it: the visitor API (what can be booked, a snapshot of the calendar, a
// visitor's own conversations) and the WebSocket conversation (hub.ts), over one calendar that follows
// the real booking rules. The answers have the shapes services/django-systems/openapi.json documents,
// and the conversations follow the golden set's curated cases (evals/lb02/golden.yaml), so the site's
// board can be driven end to end without a model. A few controls let a test act as the rest of the world:
// another visitor books or holds a slot, the clock moves so a hold runs out, the calendar is reset, the
// connections drop.
import type { Answer } from '../lb01.ts'
import { errorAnswer } from '../lb01.ts'
import type { MockSpan } from '../spans.ts'
import { HOLD_MS } from './calendar.ts'
import { Lb02Hub } from './hub.ts'
import type { HubOptions } from './hub.ts'
import { readOfferings } from './seed.ts'
import { addDays, isoMoment, pragueDay } from './time.ts'
import { typesetCzech } from './words.ts'
import type { MockConversation } from './concierge.ts'

/** What a test may choose about the mock's LB-02. */
export type Lb02MockOptions = HubOptions

/** The calendar a snapshot is asked for. */
interface CalendarQuery {
  from: string | null
  days: number
  conversation: string | null
}

/** A counter for the visitors who are not in a browser: other people, as the golden set's `world` events say. */
let strangers = 0

/** The mock's LB-02. */
export class Lb02Mock {
  readonly hub: Lb02Hub
  // The minutes the clock has been moved on, so holds run out without waiting.
  #movedMs = 0
  readonly #realNow: () => number

  /** Lays the calendar out and waits for visitors. */
  constructor(options: Lb02MockOptions) {
    this.#realNow = options.now
    this.hub = new Lb02Hub(readOfferings(), { ...options, now: () => this.now() })
  }

  /** The booking clock: the real one, plus whatever a test moved it on by. */
  now(): number {
    return this.#realNow() + this.#movedMs
  }

  /** Forgets every conversation and lays the calendar out afresh. */
  reset(): void {
    this.#movedMs = 0
    this.hub.reset()
  }

  /** What can be booked, in both languages. */
  offerings(): Answer {
    const body = this.hub.calendar.offerings.map(offering => ({
      key: offering.key,
      title: { en: offering.title.en, cs: typesetCzech(offering.title.cs) },
      summary: { en: offering.summary.en, cs: typesetCzech(offering.summary.cs) },
      room: { en: offering.roomName.en, cs: typesetCzech(offering.roomName.cs) },
      duration_minutes: offering.durationMinutes,
      capacity: offering.capacity,
      price_czk: offering.priceCzk,
    }))
    return { status: 200, body }
  }

  /** Reads the query of a calendar snapshot: up to 14 days from a day, seen from one of the visitor's conversations. */
  #query(search: URLSearchParams): CalendarQuery | undefined {
    const from = search.get('from')
    const days = search.has('days') ? Number(search.get('days')) : 14
    if (from !== null && !/^\d{4}-\d{2}-\d{2}$/.test(from)) return undefined
    if (!Number.isInteger(days) || days < 1 || days > 14) return undefined
    return { from, days, conversation: search.get('conversation') }
  }

  /** A snapshot of the calendar: each slot free, held or booked, and which is the conversation's own. */
  calendar(session: string, search: URLSearchParams): Answer {
    const query = this.#query(search)
    if (!query) return errorAnswer(422, 'invalid_request', 'The request does not fit its schema.')
    let viewer: MockConversation | undefined
    if (query.conversation !== null) {
      viewer = this.hub.find(session, query.conversation)
      if (!viewer) return errorAnswer(404, 'not_found', 'There is no such conversation.')
    }
    const now = this.now()
    const firstDay = query.from ?? addDays(pragueDay(now), 1)
    const lastDay = addDays(firstDay, query.days - 1)
    const slots = this.hub.calendar.slots
      .filter(slot => slot.startsAt > now && pragueDay(slot.startsAt) >= firstDay && pragueDay(slot.startsAt) <= lastDay)
      .map((slot) => {
        const state = this.hub.calendar.stateOf(slot)
        return { id: slot.id, offering: slot.offering, starts_at: isoMoment(slot.startsAt), ends_at: isoMoment(slot.endsAt), status: state.status, mine: viewer !== undefined && state.owner === viewer.id, until: state.until === undefined ? null : isoMoment(state.until) }
      })
    return { status: 200, body: { as_of: isoMoment(now), first_day: firstDay, last_day: lastDay, slots } }
  }

  /** A conversation as the list shows it. */
  #summary(conversation: MockConversation): Record<string, unknown> {
    const state = this.hub.stateOf(conversation)
    return {
      id: conversation.id,
      step: state.step,
      language: conversation.language,
      messages_used: conversation.messagesUsed,
      messages_left: state.messages_left,
      closed: state.closed,
      created_at: isoMoment(conversation.createdAt),
      expires_at: isoMoment(conversation.expiresAt),
    }
  }

  /** The visitor's own conversations, newest first, as many as the real list shows. */
  conversations(session: string): Answer {
    return { status: 200, body: this.hub.ownedBy(session).slice(0, 20).map(conversation => this.#summary(conversation)) }
  }

  /** One of the visitor's conversations in full: the transcript, the booking, the recorded confirmation and the handoff. */
  conversation(session: string, id: string): Answer {
    const conversation = this.hub.find(session, id)
    if (!conversation) return errorAnswer(404, 'not_found', 'There is no such conversation.')
    const line = (item: { role: string, text: string, at: number }, position: number): Record<string, unknown> => ({ position, role: item.role, text: item.text, at: isoMoment(item.at) })
    const confirmation = conversation.confirmation
    const handoff = conversation.handoff
    return {
      status: 200,
      body: {
        ...this.#summary(conversation),
        ...this.hub.stateOf(conversation),
        run_id: conversation.runId,
        model_calls: conversation.modelCalls,
        transcript: conversation.lines.map((item, index) => line(item, index + 1)),
        confirmation: confirmation ? { to: confirmation.to, subject: confirmation.subject, body: confirmation.body, language: confirmation.language, delivery: 'mock', recorded_at: isoMoment(confirmation.recordedAt) } : null,
        handoff: handoff ? { reason: handoff.reason, summary: handoff.summary, created_at: isoMoment(handoff.createdAt), transcript: handoff.transcript.map((item, index) => line(item, index + 1)) } : null,
      },
    }
  }

  /** The spans a conversation's run has written, for the Scope's route. */
  spansOf(runId: string): MockSpan[] | undefined {
    return this.hub.spansOf(runId)
  }

  // The controls of a test: the rest of the world.

  /**
   * Makes another visitor hold or book a slot of an offering, on a day counted from tomorrow (1) at a Prague
   * time: the golden set's `world` events. The live calendar hears of it at once. Returns false when there is no such free slot.
   */
  otherVisitor(action: 'books' | 'holds', offering: string, day: number, time: string): boolean {
    const slot = this.hub.calendar.slotAt(offering, addDays(pragueDay(this.now()), day), time)
    if (!slot) return false
    strangers += 1
    const owner = `other-visitor-${strangers}`
    const held = this.hub.calendar.hold(owner, slot.id, 2, 'Another Visitor')
    if (!held.ok) return false
    const confirmed = action === 'books' ? this.hub.calendar.confirm(owner) : undefined
    this.hub.announce([...held.changes, ...(confirmed?.ok ? confirmed.changes : [])])
    return true
  }

  /** Moves the booking clock on, so holds run out without waiting, and runs the sweep that tells the live calendar. */
  advance(minutes: number): void {
    this.#movedMs += minutes * 60_000
    this.hub.sweep()
  }

  /** How long a hold lasts, in minutes. */
  get holdMinutes(): number {
    return HOLD_MS / 60_000
  }
}
