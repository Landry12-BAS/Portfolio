// Small pieces of LB-02's data for the component tests: slots, a hold, a booking, a confirmation, a
// handoff and the lines of a chat. They have the shapes the board's schemas give them, and the moments
// are on the day the fake site's clock runs on (2 October 2026), in Prague time.
import type { CalendarSlot, Confirmation, Handoff } from '~/boards/lb-02/schemas'
import type { SlotMap } from '~/boards/lb-02/calendar'
import type { Booking, Hold } from '~/boards/lb-02/wire'

/** Makes a slot of the calendar. Times are UTC, as the server writes them. */
export function slot(id: number, startsAt: string, status: CalendarSlot['status'] = 'free', extra: Partial<CalendarSlot> = {}): CalendarSlot {
  const start = Date.parse(startsAt)
  return { id, offering: 'cupping', starts_at: startsAt, ends_at: new Date(start + 60 * 60_000).toISOString(), status, mine: false, until: null, ...extra }
}

/** Makes a map of slots by ID. */
export function slotMap(...slots: CalendarSlot[]): SlotMap {
  return new Map(slots.map(item => [item.id, item]))
}

/** The hold the tests use: slot 7, a cupping at 14:30 Prague time on 3 October, held until a given moment. */
export function hold(expiresAt: string): Hold {
  return { slot: 7, offering: 'cupping', starts_at: '2026-10-03T12:30:00.000Z', ends_at: '2026-10-03T13:30:00.000Z', expires_at: expiresAt }
}

/** The booking the tests use. */
export const BOOKING: Booking = {
  code: 'K7M2-9QXP',
  slot: 7,
  offering: 'cupping',
  starts_at: '2026-10-03T12:30:00.000Z',
  ends_at: '2026-10-03T13:30:00.000Z',
  party_size: 2,
  to: 'jana@example.test',
}

/** The recorded confirmation email the tests use. */
export const CONFIRMATION: Confirmation = {
  to: 'jana@example.test',
  subject: 'Your cupping session is booked',
  body: 'Hello Jana,\n\nYour cupping session is booked for Saturday 3 October at 14:30.\n<img src=x onerror=alert(1)>',
  language: 'en',
  delivery: 'mock',
  recorded_at: '2026-10-02T09:35:00.000Z',
}

/** A handoff with a transcript of two lines. */
export const HANDOFF: Handoff = {
  reason: 'asked_for_person',
  summary: 'Wants a cupping for two on Saturday; asked for a person.',
  created_at: '2026-10-02T09:36:00.000Z',
  transcript: [
    { position: 0, role: 'visitor', text: 'Can I talk to a person?', at: '2026-10-02T09:35:30.000Z' },
    { position: 1, role: 'concierge', text: 'Of course. I am handing this over.', at: '2026-10-02T09:35:40.000Z' },
  ],
}
