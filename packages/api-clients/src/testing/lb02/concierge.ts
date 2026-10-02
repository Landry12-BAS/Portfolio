// The mock concierge: one visitor message in, one answer out, following the real booking rules. The step
// of a conversation follows from the facts (are the details complete, is a slot held, is it booked,
// has it been handed to a person), never from what was said. The answers are what the real concierge
// gives to the curated conversations of the golden set (evals/lb02/golden.yaml): the same tools, the
// same receipts written by code, the same refusals, and the same count of gateway calls (an injection
// check for every message and one to three calls of the chat model). No model is behind it.
import { HOLD_MS } from './calendar.ts'
import type { MockCalendar, MockSlot, SlotChange } from './calendar.ts'
import { addDays, pragueDay, pragueParts, whenText } from './time.ts'
import { confirmationText, guests, receipt, reply, timeList } from './words.ts'
import type { ReceiptKind } from './words.ts'
import { understand } from './understand.ts'
import type { Understood } from './understand.ts'

/** The most messages a conversation may hold. */
export const MESSAGES_PER_CONVERSATION = 30
/** How many times the injection screen may flag a conversation before it goes to a person. */
export const INJECTION_STRIKES = 3
/** How many free slots a search offers at a time. */
export const MAX_OPTIONS = 6

/** Where a conversation stands. */
export type Step = 'details' | 'availability' | 'hold' | 'done' | 'handoff'

/** Why a conversation was handed to a person (lb02/models.py, Handoff.Reason). */
export type HandoffReason = 'asked_for_person' | 'out_of_scope' | 'cannot_help' | 'message_limit' | 'budget' | 'unavailable' | 'unchecked' | 'abuse'

/** One line of a conversation's transcript. */
export interface MockLine {
  role: 'visitor' | 'concierge' | 'action'
  text: string
  at: number
}

/** What the visitor has told the concierge so far. */
export interface Details {
  offering: string | undefined
  partySize: number | undefined
  name: string | undefined
  email: string | undefined
  // The days asked for, counted from tomorrow; the whole fortnight until the visitor says a day.
  firstDay: number
  lastDay: number
  partOfDay: Understood['partOfDay']
  time: Understood['time']
}

/** The recorded confirmation of a booking. It is never sent. */
export interface MockConfirmation {
  to: string
  subject: string
  body: string
  language: string
  recordedAt: number
}

/** A conversation the mock holds for one visitor. */
export interface MockConversation {
  id: string
  session: string
  runId: string
  createdAt: number
  expiresAt: number
  language: string
  details: Details
  // The slots on offer now.
  offered: number[]
  // Every slot the conversation was ever shown, in the order it was first shown. A slot's number is its place
  // here, counting from 1: it never changes and is never given to another slot.
  shown: number[]
  // Whether a turn of the conversation is being answered right now.
  answering: boolean
  messagesUsed: number
  modelCalls: number
  strikes: number
  lines: MockLine[]
  handoff: { reason: HandoffReason, summary: string, createdAt: number, transcript: MockLine[] } | undefined
  confirmation: MockConfirmation | undefined
  // Whether a hold had been placed that has since run out, so the next message can say so.
  lapsedHold: number | undefined
}

/** A tool the mock model called this turn. */
export interface MockTool {
  name: string
  executed: boolean
  ok: boolean
  error: string
}

/** What one turn produced, before the connection turns it into events. */
export interface TurnOutput {
  text: string
  receipt: ReceiptKind | undefined
  tools: MockTool[]
  // The gateway calls the turn used: the injection check, and the calls to the chat model.
  calls: { guard: number, chat: number }
  // Whether the language was read from the message without a call, as the real code does for the first message.
  detectedLanguage: boolean
  changes: SlotChange[]
}

/** Makes a conversation with nothing said yet. */
export function newConversation(id: string, session: string, runId: string, now: number, lifetimeMs: number): MockConversation {
  return {
    id,
    session,
    runId,
    createdAt: now,
    expiresAt: now + lifetimeMs,
    language: 'en',
    details: { offering: undefined, partySize: undefined, name: undefined, email: undefined, firstDay: 1, lastDay: 14, partOfDay: undefined, time: undefined },
    offered: [],
    shown: [],
    answering: false,
    messagesUsed: 0,
    modelCalls: 0,
    strikes: 0,
    lines: [],
    handoff: undefined,
    confirmation: undefined,
    lapsedHold: undefined,
  }
}

/** Tells whether all the details a search needs are known. */
function complete(details: Details): boolean {
  return details.offering !== undefined && details.partySize !== undefined && details.name !== undefined && details.email !== undefined
}

/** Where a conversation stands, worked out from the facts. */
export function stepOf(conversation: MockConversation, calendar: MockCalendar): Step {
  const key = conversation.id
  if (conversation.handoff) return 'handoff'
  if (calendar.bookingOf(key)) return 'done'
  if (calendar.holdOf(key)) return 'hold'
  return complete(conversation.details) ? 'availability' : 'details'
}

/** Names the details still missing, in the visitor's language. */
function missingDetails(details: Details, language: string): string {
  const names = language === 'cs'
    ? [['offering', 'co chcete rezervovat'], ['partySize', 'počet osob'], ['name', 'vaše jméno'], ['email', 'váš e-mail']] as const
    : [['offering', 'what you would like to book'], ['partySize', 'how many people are coming'], ['name', 'your name'], ['email', 'your email address']] as const
  const missing = names.filter(([field]) => details[field] === undefined).map(([, label]) => label)
  return missing.join(language === 'cs' ? ', ' : ', ')
}

/** Folds what a message says into the conversation's details, and tells which details it changed. */
function learn(conversation: MockConversation, said: Understood): string[] {
  const details = conversation.details
  const changed: string[] = []
  const set = <K extends keyof Details>(field: K, value: Details[K] | undefined, label: string): void => {
    if (value === undefined || details[field] === value) return
    details[field] = value
    changed.push(label)
  }
  set('offering', said.offering, 'offering')
  set('partySize', said.partySize, 'party size')
  set('name', said.name, 'name')
  if (said.email !== undefined && said.emailIsExample) set('email', said.email, 'email')
  if (said.day !== undefined && (details.firstDay !== said.day || details.lastDay !== said.day)) {
    details.firstDay = said.day
    details.lastDay = said.day
    changed.push('day')
  }
  set('partOfDay', said.partOfDay, 'part of day')
  // A time named while slots are on offer picks one of them; it is a detail only when there is nothing to pick from.
  if (conversation.offered.length === 0) set('time', said.time, 'time')
  return changed
}

/** The slots a search finds for the conversation's details; with no free slot at the asked time, the next free ones of the offering. */
function searchFor(conversation: MockConversation, calendar: MockCalendar, now: number): { slots: MockSlot[], widened: boolean } {
  const { offering, partySize, firstDay, lastDay, partOfDay, time } = conversation.details
  const today = pragueDay(now)
  const base = { offering: offering ?? '', partySize: partySize ?? 1, firstDay: addDays(today, firstDay), lastDay: addDays(today, lastDay), partOfDay, limit: 40 }
  const wanted = calendar.search(base).filter(slot => time === undefined || sameTime(slot, time))
  if (wanted.length > 0) return { slots: wanted.slice(0, MAX_OPTIONS), widened: false }
  // Nothing at the asked time: if the day has other free times, those; otherwise the next free ones of the offering.
  const sameDay = calendar.search({ ...base, partOfDay: undefined, limit: MAX_OPTIONS })
  if (sameDay.length > 0 && partOfDay === undefined) return { slots: sameDay, widened: true }
  const later = calendar.search({ ...base, firstDay: addDays(today, 1), lastDay: addDays(today, 14), partOfDay, limit: MAX_OPTIONS })
  return { slots: later.length > 0 ? later : calendar.search({ ...base, firstDay: addDays(today, 1), lastDay: addDays(today, 14), partOfDay: undefined, limit: MAX_OPTIONS }), widened: true }
}

/** Tells whether a slot starts at a time of day, on the roastery's clock. */
function sameTime(slot: MockSlot, time: { hour: number, minute: number }): boolean {
  const start = pragueParts(slot.startsAt)
  return start.hour === time.hour && start.minute === time.minute
}

/** Hides the email addresses in the visitor's words, as the transcript keeps them. */
function hideEmails(text: string): string {
  return text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
}

/** What a turn does, so the answer and the counts of calls follow from one place. */
interface Answer {
  text: string
  receipt?: ReceiptKind
  tools?: MockTool[]
  chat: number
  changes?: SlotChange[]
}

/** The mock concierge. */
export class MockConcierge {
  readonly #calendar: MockCalendar
  readonly #now: () => number
  readonly #limit: () => number

  /** Plays the real booking rules on a calendar, by a clock, with a limit of messages a conversation takes. */
  constructor(calendar: MockCalendar, now: () => number, limit: () => number = () => MESSAGES_PER_CONVERSATION) {
    this.#calendar = calendar
    this.#now = now
    this.#limit = limit
  }

  /** The offering's title in a language. */
  #titleOf(key: string | undefined, language: string): string {
    const offering = this.#calendar.offerings.find(item => item.key === key)
    return language === 'cs' ? (offering?.title.cs ?? key ?? '') : (offering?.title.en ?? key ?? '')
  }

  /** Records a line of the transcript. */
  #record(conversation: MockConversation, role: MockLine['role'], text: string): void {
    conversation.lines.push({ role, text, at: this.#now() })
  }

  /** Hands the conversation to a person: the hold is released, the case file is written and the receipt says so. */
  #handOff(conversation: MockConversation, reason: HandoffReason, kind: ReceiptKind): Answer {
    const changes = this.#calendar.release(conversation.id)
    const details = conversation.details
    const known = [details.offering ? `Wants ${details.offering}` : '', details.partySize ? `for ${details.partySize}` : '', details.name ? `Name ${details.name}` : ''].filter(Boolean).join(', ')
    this.#record(conversation, 'action', `Handed to a person: ${reason}.`)
    const text = receipt(kind, conversation.language, { limit: this.#limit() })
    conversation.handoff = { reason, summary: known, createdAt: this.#now(), transcript: [...conversation.lines] }
    return { text, receipt: kind, tools: kind === 'message_limit' ? [] : [{ name: 'handoff_to_person', executed: true, ok: true, error: '' }], chat: kind === 'message_limit' ? 0 : 1, changes }
  }

  /** Searches again and says what was found. */
  #offer(conversation: MockConversation, tool: string): Answer {
    const { slots, widened } = searchFor(conversation, this.#calendar, this.#now())
    conversation.offered = slots.map(slot => slot.id)
    for (const slot of slots) {
      if (!conversation.shown.includes(slot.id)) conversation.shown.push(slot.id)
    }
    conversation.lapsedHold = undefined
    const language = conversation.language
    const offering = this.#titleOf(conversation.details.offering, language)
    const tools: MockTool[] = [{ name: tool, executed: true, ok: true, error: '' }]
    const list = timeList(slots, language)
    let text: string
    if (slots.length === 0) text = reply('which', language)
    else if (widened) text = reply('no_times', language, { offering, list })
    else if (slots.length === 1) text = reply('one_time', language, { offering, when: whenText(slots[0]?.startsAt ?? 0, slots[0]?.endsAt ?? 0, language === 'cs' ? 'cs' : 'en') })
    else text = reply('times', language, { offering, list })
    return { text, tools, chat: 2 }
  }

  /** Chooses the offered slot the message names, if it names one. */
  #chosen(conversation: MockConversation, said: Understood): MockSlot | undefined | 'none' {
    const offered = conversation.offered.map(id => this.#calendar.slot(id)).filter((slot): slot is MockSlot => slot !== undefined)
    if (said.time !== undefined) {
      const time = said.time
      return offered.find(slot => sameTime(slot, time)) ?? 'none'
    }
    if (said.pick !== undefined) return offered[said.pick - 1] ?? 'none'
    if (said.yes && offered.length === 1) return offered[0]
    return undefined
  }

  /** Holds the slot the visitor chose, and writes the receipt from the calendar's facts. */
  #hold(conversation: MockConversation, slot: MockSlot): Answer {
    const language = conversation.language
    const result = this.#calendar.hold(conversation.id, slot.id, conversation.details.partySize ?? 1, conversation.details.name ?? '')
    if (!result.ok) {
      const tools: MockTool[] = [{ name: 'hold_slot', executed: true, ok: false, error: result.refusal === 'slot_taken' ? 'slot_unavailable' : result.refusal }]
      return { text: receipt('slot_taken', language), receipt: 'slot_taken', tools, chat: 1 }
    }
    const wording = language === 'cs' ? 'cs' : 'en'
    conversation.lapsedHold = slot.id
    this.#record(conversation, 'action', `Held ${slot.offering} on ${whenText(slot.startsAt, slot.endsAt, 'en')} for 5 minutes.`)
    const text = receipt('hold_placed', language, {
      offering: this.#titleOf(slot.offering, wording),
      when: whenText(slot.startsAt, slot.endsAt, wording),
      party: guests(conversation.details.partySize ?? 1, language),
      minutes: HOLD_MS / 60_000,
    })
    return { text, receipt: 'hold_placed', tools: [{ name: 'hold_slot', executed: true, ok: true, error: '' }], chat: 1, changes: result.changes }
  }

  /** Confirms the hold as a booking, records the confirmation (never sent) and writes the receipt. */
  #confirm(conversation: MockConversation): Answer {
    const language = conversation.language
    const result = this.#calendar.confirm(conversation.id)
    if (!result.ok) return { text: reply('which', language), tools: [{ name: 'confirm_booking', executed: false, ok: false, error: 'no_hold' }], chat: 1 }
    const booking = result.reservation
    const slot = this.#calendar.slot(booking.slot)
    const wording = language === 'cs' ? 'cs' : 'en'
    const facts = {
      name: booking.guestName,
      offering: this.#titleOf(slot?.offering, wording),
      when: whenText(booking.startsAt, booking.endsAt, wording),
      party: guests(booking.partySize, language),
      code: booking.code,
      to: conversation.details.email ?? '',
    }
    conversation.lapsedHold = undefined
    if (!conversation.confirmation) {
      conversation.confirmation = { to: facts.to, ...confirmationText(language, facts), language: wording, recordedAt: this.#now() }
      this.#record(conversation, 'action', `Booked ${slot?.offering ?? ''} on ${whenText(booking.startsAt, booking.endsAt, 'en')}, code ${booking.code}.`)
    }
    return { text: receipt('booking_confirmed', language, facts), receipt: 'booking_confirmed', tools: [{ name: 'confirm_booking', executed: true, ok: true, error: '' }], chat: 1, changes: result.changes }
  }

  /** Answers a message in the step where a slot is held: yes books it, no gives it up, a time picks another. */
  #whileHeld(conversation: MockConversation, said: Understood): Answer {
    const language = conversation.language
    if (said.time !== undefined || said.pick !== undefined) {
      const chosen = this.#chosen(conversation, said)
      if (chosen !== undefined && chosen !== 'none') return this.#hold(conversation, chosen)
    }
    if (said.no) {
      const changes = this.#calendar.release(conversation.id)
      conversation.lapsedHold = undefined
      this.#record(conversation, 'action', 'Released the hold.')
      return { text: reply('released', language), tools: [{ name: 'release_hold', executed: true, ok: true, error: '' }], chat: 2, changes }
    }
    if (said.yes) return this.#confirm(conversation)
    return { text: reply('which', language), chat: 1 }
  }

  /** Answers a message in the step where the details are known: a choice is held, anything else is another search. */
  #whileOffering(conversation: MockConversation, said: Understood, changed: string[]): Answer {
    const language = conversation.language
    const asksAgain = said.askAgain && changed.length === 0
    const lapsed = conversation.lapsedHold !== undefined ? this.#calendar.slot(conversation.lapsedHold) : undefined
    // The visitor says yes to a hold that ran out: the code says so, from the calendar's facts, and the slots on offer are searched again.
    if (lapsed && said.yes && changed.length === 0) {
      conversation.lapsedHold = undefined
      const wording = language === 'cs' ? 'cs' : 'en'
      const refreshed = this.#offer(conversation, 'check_availability')
      return { text: receipt('hold_expired', language, { when: whenText(lapsed.startsAt, lapsed.endsAt, wording), minutes: HOLD_MS / 60_000 }), receipt: 'hold_expired', tools: refreshed.tools, chat: 1 }
    }
    if (changed.length > 0 || asksAgain || conversation.offered.length === 0) return this.#offer(conversation, changed.length > 0 ? 'update_details' : 'check_availability')
    const chosen = this.#chosen(conversation, said)
    if (chosen === 'none') {
      const list = timeList(conversation.offered.map(id => this.#calendar.slot(id)).filter((slot): slot is MockSlot => slot !== undefined), language)
      return { text: reply('not_offered', language, { list }), chat: 1 }
    }
    if (chosen !== undefined) return this.#hold(conversation, chosen)
    return { text: reply('which', language), chat: 1 }
  }

  /** Works out the answer to one message, once it has passed the checks that need no model. */
  #answer(conversation: MockConversation, said: Understood): Answer {
    const language = conversation.language
    const changed = learn(conversation, said)
    const step = stepOf(conversation, this.#calendar)
    if (step === 'details') {
      const tools: MockTool[] = changed.length > 0 ? [{ name: 'update_details', executed: true, ok: true, error: '' }] : []
      if (changed.length > 0) this.#record(conversation, 'action', `Recorded ${changed.join(', ')}.`)
      return { text: reply('ask_details', language, { missing: missingDetails(conversation.details, language) }), tools, chat: changed.length > 0 ? 2 : 1 }
    }
    if (changed.length > 0) this.#record(conversation, 'action', `Recorded ${changed.join(', ')}.`)
    if (step === 'hold') return this.#whileHeld(conversation, said)
    if (step === 'done') return { text: reply('all_set', language), chat: 1 }
    return this.#whileOffering(conversation, said, changed)
  }

  /**
   * Takes in a message: counts it and writes the visitor's words in the transcript. The real service does this before
   * its first model call, so a turn that dies leaves the message behind with no answer. Says whether it was the first.
   */
  receive(conversation: MockConversation, text: string): boolean {
    // A conversation that is over takes nothing in: nothing is counted or kept, as in the service.
    if (conversation.handoff) return false
    conversation.messagesUsed += 1
    const wasFirst = conversation.lines.length === 0
    this.#record(conversation, 'visitor', hideEmails(text))
    return wasFirst
  }

  /** Answers a message that was taken in. */
  respond(conversation: MockConversation, text: string, wasFirst: boolean): TurnOutput {
    const finish = (answer: Answer, guard: number): TurnOutput => {
      this.#record(conversation, 'concierge', answer.text)
      // A person is handed the whole case, so the handoff's copy of the transcript includes the concierge's last words about it.
      if (conversation.handoff) conversation.handoff.transcript = [...conversation.lines]
      conversation.modelCalls += guard + answer.chat
      return { text: answer.text, receipt: answer.receipt, tools: answer.tools ?? [], calls: { guard, chat: answer.chat }, detectedLanguage: wasFirst, changes: answer.changes ?? [] }
    }
    if (conversation.handoff) return { text: receipt('closed', conversation.language), receipt: 'closed', tools: [], calls: { guard: 0, chat: 0 }, detectedLanguage: false, changes: [] }
    if (conversation.messagesUsed > this.#limit()) return finish(this.#handOff(conversation, 'message_limit', 'message_limit'), 0)
    const said = understand(text)
    if (said.language !== undefined) conversation.language = said.language
    if (said.injection) {
      conversation.strikes += 1
      if (conversation.strikes >= INJECTION_STRIKES) return finish(this.#handOff(conversation, 'abuse', 'handed_off'), 1)
      return finish({ text: receipt('injection_refused', conversation.language), receipt: 'injection_refused', chat: 0 }, 1)
    }
    if (said.wantsPerson) return finish(this.#handOff(conversation, 'asked_for_person', 'handed_off'), 1)
    if (said.outOfScope && stepOf(conversation, this.#calendar) === 'details') return finish(this.#handOff(conversation, 'out_of_scope', 'handed_off'), 1)
    return finish(this.#answer(conversation, said), 1)
  }
}
