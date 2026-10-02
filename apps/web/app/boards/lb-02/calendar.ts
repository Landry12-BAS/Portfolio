// The live calendar's model: the slots the board knows, how a snapshot and the live changes
// that follow it combine, and how the slots are grouped into the roastery's days. These are plain
// functions over plain data, so what the calendar shows can be tested without a page. The
// roastery's days are Prague days, because the server writes UTC and the sessions are held in Prague.
import type { CalendarSlot, CalendarSnapshot } from './schemas.ts'
import type { SlotChange, SlotStatus } from './wire.ts'

/** The roastery's time zone, in which every time on the board is shown (lb02/events.py). */
export const ROASTERY_TIME_ZONE = 'Europe/Prague'

/** The slots the board knows, by ID. A new map is made for every change, so Vue sees it. */
export type SlotMap = ReadonlyMap<number, CalendarSlot>

/** A slot as it is shown at one moment: its status once a hold that has run out is taken into account. */
export interface ShownSlot {
  slot: CalendarSlot
  // `held` becomes `free` when the hold's end has passed, which is how the booking rules read it too.
  status: SlotStatus
  // The hold ran out and the server has not said so yet (its sweep runs once a minute).
  lapsed: boolean
}

/** One day of the calendar, with its slots in the order they start. */
export interface CalendarDay {
  // The date in Prague, such as `2026-10-02`.
  date: string
  slots: ShownSlot[]
  free: number
  held: number
  booked: number
  // Whether one of the slots is this conversation's own, held or booked.
  hasMine: boolean
}

/** Makes the map of slots a snapshot holds. */
export function slotsFromSnapshot(snapshot: CalendarSnapshot): SlotMap {
  return new Map(snapshot.slots.map(slot => [slot.id, slot]))
}

/** Turns one live change into the slot it describes. */
function slotFromChange(change: SlotChange): CalendarSlot {
  return {
    id: change.slot,
    offering: change.offering,
    starts_at: change.starts_at,
    ends_at: change.ends_at,
    status: change.status,
    mine: change.mine,
    until: change.until,
  }
}

/** Applies live changes to the slots, in the order they arrived: the last word about a slot wins. */
export function applyChanges(slots: SlotMap, changes: readonly SlotChange[]): SlotMap {
  const next = new Map(slots)
  for (const change of changes) next.set(change.slot, slotFromChange(change))
  return next
}

/** How far the server's clock is ahead of the page's, in milliseconds, from a snapshot's `as_of` and the moment it arrived. */
export function clockOffset(snapshot: CalendarSnapshot, arrivedAt: number): number {
  return Date.parse(snapshot.as_of) - arrivedAt
}

/** Reads a slot at a moment on the server's clock: a hold whose time has passed is free again. */
export function showSlot(slot: CalendarSlot, serverNow: number): ShownSlot {
  const lapsed = slot.status === 'held' && slot.until !== null && Date.parse(slot.until) <= serverNow
  return { slot, status: lapsed ? 'free' : slot.status, lapsed }
}

/** Writes the Prague date of a moment as `YYYY-MM-DD`. */
export function pragueDate(moment: string | number | Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ROASTERY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(moment))
  const part = (type: string): string => parts.find(item => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

/** Orders slots by when they start, then by offering, so a day reads from morning to evening. */
function byStart(a: ShownSlot, b: ShownSlot): number {
  return Date.parse(a.slot.starts_at) - Date.parse(b.slot.starts_at) || a.slot.offering.localeCompare(b.slot.offering)
}

/** Groups the slots into Prague days, oldest first, each with its slots shown at the server's time. */
export function groupByDay(slots: SlotMap, serverNow: number): CalendarDay[] {
  const days = new Map<string, ShownSlot[]>()
  for (const slot of slots.values()) {
    const date = pragueDate(slot.starts_at)
    days.set(date, [...(days.get(date) ?? []), showSlot(slot, serverNow)])
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, shown]) => {
      const sorted = shown.sort(byStart)
      return {
        date,
        slots: sorted,
        free: sorted.filter(item => item.status === 'free').length,
        held: sorted.filter(item => item.status === 'held').length,
        booked: sorted.filter(item => item.status === 'booked').length,
        hasMine: sorted.some(item => item.slot.mine && item.status !== 'free'),
      }
    })
}

/** Lists the slots whose state is different in `after` than in `before`, which is what a screen reader is told about. */
export function changedSlots(before: SlotMap, after: SlotMap): CalendarSlot[] {
  const changed: CalendarSlot[] = []
  for (const slot of after.values()) {
    const earlier = before.get(slot.id)
    if (earlier === undefined || earlier.status !== slot.status || earlier.mine !== slot.mine) changed.push(slot)
  }
  return changed
}

/** Finds the day to show first: the one with this conversation's own slot, else the first with a free slot, else the first. */
export function dayToShow(days: readonly CalendarDay[]): string | undefined {
  return (days.find(day => day.hasMine) ?? days.find(day => day.free > 0) ?? days[0])?.date
}
