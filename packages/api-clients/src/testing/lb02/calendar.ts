// LB-02's calendar as the mock plays it: the slots of the seed laid out over the next 14 days, and the
// reservations on them. It keeps the real rules the page can see: a slot is free unless a booking or a
// live hold of its room overlaps it (so the cupping at 11:30 and the tasting at 12:00 take each other
// out), a hold lasts five minutes and ends by being read and not by a sweep, and a conversation has at
// most one hold and one booking. Everything that changes the calendar returns the states of the
// slots it touched, which is what the live calendar is told.
import { addDays, pragueDay, pragueParts, pragueToUtc } from './time.ts'

/** How long a hold lasts. */
export const HOLD_MS = 5 * 60_000
/** How many days ahead the calendar runs, from tomorrow. */
export const CALENDAR_DAYS = 14

/** An offering, as the seed describes it. */
export interface OfferingSeed {
  key: string
  room: string
  title: { en: string, cs: string }
  summary: { en: string, cs: string }
  roomName: { en: string, cs: string }
  durationMinutes: number
  capacity: number
  priceCzk: number
  // Start times in Prague time, such as `14:30`.
  starts: string[]
}

/** One slot of the calendar. */
export interface MockSlot {
  id: number
  offering: string
  room: string
  startsAt: number
  endsAt: number
}

/** A hold or a booking on a slot, kept for the conversation (or the other visitor) that made it. */
export interface MockReservation {
  slot: number
  room: string
  startsAt: number
  endsAt: number
  owner: string
  status: 'held' | 'booked'
  // When a hold runs out; unused for a booking.
  heldUntil: number
  code: string
  partySize: number
  guestName: string
}

/** Whether a slot is free, held or booked, and by whom. */
export interface SlotState {
  status: 'free' | 'held' | 'booked'
  owner: string | undefined
  until: number | undefined
}

/** A slot and its state, which is what the live calendar is told when it changes. */
export interface SlotChange {
  slot: MockSlot
  state: SlotState
}

/** Why a hold or a confirm was refused. */
export type Refusal = 'slot_taken' | 'no_such_slot' | 'party_too_large' | 'no_hold' | 'already_booked'

/** The soonest free slots of an offering, between two days, for a party and a part of the day. */
export interface SearchQuery {
  offering: string
  firstDay: string
  lastDay: string
  partySize: number
  partOfDay: 'morning' | 'afternoon' | 'evening' | undefined
  limit: number
}

// The hours a part of the day covers, by the hour a session starts in (lb02/booking.py).
const PART_OF_DAY: Record<'morning' | 'afternoon' | 'evening', (hour: number) => boolean> = {
  morning: hour => hour < 12,
  afternoon: hour => hour >= 12 && hour < 17,
  evening: hour => hour >= 17,
}

// The letters and digits a booking code is made of: the real service's alphabet (lb02/models.py), without the ones that are easily mistaken for each other.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Makes a booking code in the real service's form, two groups of four, such as `K7M2-9QXP`, from a number; the same number always makes the same code. */
function bookingCode(seed: number): string {
  let state = seed >>> 0
  let letters = ''
  for (let place = 0; place < 8; place += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    letters += CODE_ALPHABET[state >>> 27]
  }
  return `${letters.slice(0, 4)}-${letters.slice(4)}`
}

/** The mock's calendar and its reservations. */
export class MockCalendar {
  readonly #offerings: OfferingSeed[]
  readonly #now: () => number
  #slots: MockSlot[] = []
  #reservations: MockReservation[] = []
  #codes = 0

  /** Lays the calendar out from today, by the clock it is given. */
  constructor(offerings: OfferingSeed[], now: () => number) {
    this.#offerings = offerings
    this.#now = now
    this.reset()
  }

  /** The offerings of the seed. */
  get offerings(): readonly OfferingSeed[] {
    return this.#offerings
  }

  /** Every slot, oldest first. */
  get slots(): readonly MockSlot[] {
    return this.#slots
  }

  /** Clears what visitors made and lays out the next 14 days from today, as the nightly reset does. */
  reset(): void {
    this.#reservations = []
    this.#slots = []
    const today = pragueDay(this.#now())
    let id = 0
    for (let ahead = 1; ahead <= CALENDAR_DAYS; ahead += 1) {
      const [year, month, day] = addDays(today, ahead).split('-').map(Number)
      for (const offering of this.#offerings) {
        for (const start of offering.starts) {
          const [hour, minute] = start.split(':').map(Number)
          const startsAt = pragueToUtc(year ?? 1970, month ?? 1, day ?? 1, hour ?? 0, minute ?? 0)
          id += 1
          this.#slots.push({ id, offering: offering.key, room: offering.room, startsAt, endsAt: startsAt + offering.durationMinutes * 60_000 })
        }
      }
    }
    this.#slots.sort((a, b) => a.startsAt - b.startsAt || a.id - b.id)
  }

  /** Finds a slot by its ID. */
  slot(id: number): MockSlot | undefined {
    return this.#slots.find(slot => slot.id === id)
  }

  /** Finds the slot of an offering that starts at a Prague date and time. */
  slotAt(offering: string, day: string, time: string): MockSlot | undefined {
    const [year, month, date] = day.split('-').map(Number)
    const [hour, minute] = time.split(':').map(Number)
    const startsAt = pragueToUtc(year ?? 1970, month ?? 1, date ?? 1, hour ?? 0, minute ?? 0)
    return this.#slots.find(slot => slot.offering === offering && slot.startsAt === startsAt)
  }

  /** Tells whether a reservation still keeps its room: a booking always does, a hold until it runs out. */
  #active(reservation: MockReservation): boolean {
    return reservation.status === 'booked' || reservation.heldUntil > this.#now()
  }

  /** The reservations of a room that overlap a span of time and still keep it. */
  #inTheWay(room: string, startsAt: number, endsAt: number): MockReservation[] {
    return this.#reservations.filter(item => item.room === room && item.startsAt < endsAt && startsAt < item.endsAt && this.#active(item))
  }

  /** Says whether a slot is free, held or booked at the clock's time: booked beats held, as the real rules read it. */
  stateOf(slot: MockSlot): SlotState {
    const overlapping = this.#inTheWay(slot.room, slot.startsAt, slot.endsAt)
    const booked = overlapping.find(item => item.status === 'booked')
    if (booked) return { status: 'booked', owner: booked.owner, until: undefined }
    const held = overlapping.find(item => item.status === 'held')
    if (held) return { status: 'held', owner: held.owner, until: held.heldUntil }
    return { status: 'free', owner: undefined, until: undefined }
  }

  /** Finds the soonest free slots that fit the query, which are the ones no live reservation of their room overlaps. */
  search(query: SearchQuery): MockSlot[] {
    const offering = this.#offerings.find(item => item.key === query.offering)
    if (!offering || query.partySize > offering.capacity) return []
    return this.#slots
      .filter(slot => slot.offering === query.offering && slot.startsAt > this.#now())
      .filter(slot => pragueDay(slot.startsAt) >= query.firstDay && pragueDay(slot.startsAt) <= query.lastDay)
      .filter(slot => query.partOfDay === undefined || PART_OF_DAY[query.partOfDay](pragueParts(slot.startsAt).hour))
      .filter(slot => this.stateOf(slot).status === 'free')
      .slice(0, query.limit)
  }

  /** Lists the slots of the room that a reservation's span touches: the ones whose state its change may alter. */
  #touched(room: string, startsAt: number, endsAt: number): SlotChange[] {
    return this.#slots
      .filter(slot => slot.room === room && slot.startsAt < endsAt && startsAt < slot.endsAt)
      .map(slot => ({ slot, state: this.stateOf(slot) }))
  }

  /** The hold or booking a conversation has now, if any. */
  holdOf(owner: string): MockReservation | undefined {
    return this.#reservations.find(item => item.owner === owner && item.status === 'held' && this.#active(item))
  }

  /** The booking a conversation has, if any. */
  bookingOf(owner: string): MockReservation | undefined {
    return this.#reservations.find(item => item.owner === owner && item.status === 'booked')
  }

  /**
   * Holds a slot for an owner for five minutes. A slot someone else keeps, or a party above the
   * offering's capacity, is refused. An owner who holds another slot gives that one up when this one is won.
   */
  hold(owner: string, slotId: number, partySize: number, guestName: string): { ok: true, changes: SlotChange[] } | { ok: false, refusal: Refusal } {
    const slot = this.slot(slotId)
    const offering = this.#offerings.find(item => item.key === slot?.offering)
    if (!slot || !offering) return { ok: false, refusal: 'no_such_slot' }
    if (partySize > offering.capacity) return { ok: false, refusal: 'party_too_large' }
    if (this.bookingOf(owner)) return { ok: false, refusal: 'already_booked' }
    const previous = this.holdOf(owner)
    // Asking again for the slot already held returns that hold unchanged, so the five minutes do not start over.
    if (previous?.slot === slot.id) return { ok: true, changes: [] }
    const blockers = this.#inTheWay(slot.room, slot.startsAt, slot.endsAt).filter(item => item.owner !== owner || item.status === 'booked')
    if (blockers.length > 0) return { ok: false, refusal: 'slot_taken' }
    this.#reservations = this.#reservations.filter(item => item !== previous)
    this.#reservations.push({ slot: slot.id, room: slot.room, startsAt: slot.startsAt, endsAt: slot.endsAt, owner, status: 'held', heldUntil: this.#now() + HOLD_MS, code: '', partySize, guestName })
    const changes = [...(previous ? this.#touched(previous.room, previous.startsAt, previous.endsAt) : []), ...this.#touched(slot.room, slot.startsAt, slot.endsAt)]
    return { ok: true, changes: dedupe(changes) }
  }

  /** Confirms an owner's live hold as a booking with a code. Confirming twice returns the same booking. */
  confirm(owner: string): { ok: true, reservation: MockReservation, changes: SlotChange[] } | { ok: false, refusal: Refusal } {
    const booked = this.bookingOf(owner)
    if (booked) return { ok: true, reservation: booked, changes: [] }
    const held = this.holdOf(owner)
    if (!held) return { ok: false, refusal: 'no_hold' }
    this.#codes += 1
    held.status = 'booked'
    held.code = bookingCode(this.#codes * 7919 + held.slot)
    return { ok: true, reservation: held, changes: this.#touched(held.room, held.startsAt, held.endsAt) }
  }

  /** Gives up an owner's hold, if they have one. */
  release(owner: string): SlotChange[] {
    const held = this.holdOf(owner)
    if (!held) return []
    this.#reservations = this.#reservations.filter(item => item !== held)
    return this.#touched(held.room, held.startsAt, held.endsAt)
  }

  /** Removes everything an owner holds or booked, as the deletion of their conversation does. */
  forget(owner: string): SlotChange[] {
    const mine = this.#reservations.filter(item => item.owner === owner)
    this.#reservations = this.#reservations.filter(item => item.owner !== owner)
    return dedupe(mine.flatMap(item => this.#touched(item.room, item.startsAt, item.endsAt)))
  }

  /** Marks the holds that have run out as gone and returns the slots they freed: the minute-by-minute sweep tells the live calendar this. */
  sweep(): SlotChange[] {
    const lapsed = this.#reservations.filter(item => item.status === 'held' && !this.#active(item))
    this.#reservations = this.#reservations.filter(item => !lapsed.includes(item))
    return dedupe(lapsed.flatMap(item => this.#touched(item.room, item.startsAt, item.endsAt)))
  }
}

/** Keeps one change for each slot, the last one. */
function dedupe(changes: SlotChange[]): SlotChange[] {
  const bySlot = new Map<number, SlotChange>()
  for (const change of changes) bySlot.set(change.slot.id, change)
  return [...bySlot.values()]
}
