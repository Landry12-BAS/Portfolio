// Tests of the live calendar's model: how a snapshot and the changes that follow it combine, how a
// hold that has run out is read as free, how the slots are grouped into Prague days (a slot at half
// past midnight in Prague is the next day's, whatever UTC says), and which day the calendar opens on.
import { describe, expect, it } from 'vitest'

import { applyChanges, changedSlots, clockOffset, dayToShow, groupByDay, pragueDate, showSlot, slotsFromSnapshot } from '~/boards/lb-02/calendar'
import type { CalendarSlot, CalendarSnapshot } from '~/boards/lb-02/schemas'
import type { SlotChange } from '~/boards/lb-02/wire'

/** Makes a slot, free unless the test says. */
function slot(id: number, startsAt: string, fields: Partial<CalendarSlot> = {}): CalendarSlot {
  return { id, offering: 'cupping', starts_at: startsAt, ends_at: new Date(Date.parse(startsAt) + 3_600_000).toISOString(), status: 'free', mine: false, until: null, ...fields }
}

/** Makes the change event for a slot. */
function change(id: number, startsAt: string, fields: Partial<SlotChange> = {}): SlotChange {
  return { slot: id, offering: 'cupping', starts_at: startsAt, ends_at: new Date(Date.parse(startsAt) + 3_600_000).toISOString(), status: 'held', mine: false, until: null, ...fields }
}

const SNAPSHOT: CalendarSnapshot = {
  as_of: '2026-10-02T09:30:00Z',
  first_day: '2026-10-03',
  last_day: '2026-10-04',
  slots: [slot(1, '2026-10-03T12:30:00Z'), slot(2, '2026-10-03T08:00:00Z'), slot(3, '2026-10-04T08:00:00Z')],
}

describe('combining a snapshot with live changes', () => {
  it('starts from the snapshot, and the last word about a slot wins', () => {
    const slots = applyChanges(slotsFromSnapshot(SNAPSHOT), [
      change(1, '2026-10-03T12:30:00Z', { status: 'held', mine: true, until: '2026-10-02T09:35:00Z' }),
      change(1, '2026-10-03T12:30:00Z', { status: 'booked', mine: true }),
    ])
    expect(slots.get(1)).toMatchObject({ status: 'booked', mine: true })
    expect(slots.get(2)?.status).toBe('free')
  })

  it('adds a slot the snapshot did not hold, and leaves the earlier map as it was', () => {
    const before = slotsFromSnapshot(SNAPSHOT)
    const after = applyChanges(before, [change(9, '2026-10-05T08:00:00Z')])
    expect(after.has(9)).toBe(true)
    expect(before.has(9)).toBe(false)
  })

  it('reports the slots whose status or ownership differ, and no others', () => {
    const before = slotsFromSnapshot(SNAPSHOT)
    const after = applyChanges(before, [change(1, '2026-10-03T12:30:00Z', { status: 'held' }), change(2, '2026-10-03T08:00:00Z', { status: 'free' })])
    expect(changedSlots(before, after).map(item => item.id)).toEqual([1])
  })

  it('measures how far the server\'s clock is ahead of the page\'s', () => {
    expect(clockOffset(SNAPSHOT, Date.parse('2026-10-02T09:29:58Z'))).toBe(2_000)
  })
})

describe('a hold that has run out', () => {
  const held = slot(1, '2026-10-03T12:30:00Z', { status: 'held', until: '2026-10-02T09:35:00Z' })

  it('is held until its time and free after, as the booking rules read it, and says it lapsed', () => {
    expect(showSlot(held, Date.parse('2026-10-02T09:34:59Z'))).toMatchObject({ status: 'held', lapsed: false })
    expect(showSlot(held, Date.parse('2026-10-02T09:35:00Z'))).toMatchObject({ status: 'free', lapsed: true })
  })

  it('never frees a booking, or a hold with no end given', () => {
    expect(showSlot(slot(2, '2026-10-03T12:30:00Z', { status: 'booked' }), Date.parse('2030-01-01T00:00:00Z')).status).toBe('booked')
    expect(showSlot(slot(3, '2026-10-03T12:30:00Z', { status: 'held', until: null }), Date.parse('2030-01-01T00:00:00Z')).status).toBe('held')
  })
})

describe('days', () => {
  it('groups by the roastery\'s day: half past midnight in Prague is already the next day', () => {
    expect(pragueDate('2026-10-02T22:30:00Z')).toBe('2026-10-03')
    expect(pragueDate('2026-10-02T21:59:00Z')).toBe('2026-10-02')
    // The clocks go back on the last Sunday of October: the offset changes from +2 to +1 hours.
    expect(pragueDate('2026-10-24T22:30:00Z')).toBe('2026-10-25')
    expect(pragueDate('2026-10-25T22:30:00Z')).toBe('2026-10-25')
  })

  it('lists the days in order with their slots from morning to evening, and counts', () => {
    const slots = applyChanges(slotsFromSnapshot(SNAPSHOT), [change(1, '2026-10-03T12:30:00Z', { status: 'booked', mine: true })])
    const days = groupByDay(slots, Date.parse('2026-10-02T09:30:00Z'))
    expect(days.map(day => day.date)).toEqual(['2026-10-03', '2026-10-04'])
    expect(days[0]?.slots.map(item => item.slot.id)).toEqual([2, 1])
    expect(days[0]).toMatchObject({ free: 1, held: 0, booked: 1, hasMine: true })
    expect(days[1]).toMatchObject({ free: 1, hasMine: false })
  })

  it('opens on the day with the conversation\'s own slot, else the first day with a free slot', () => {
    const open = groupByDay(slotsFromSnapshot(SNAPSHOT), Date.parse('2026-10-02T09:30:00Z'))
    expect(dayToShow(open)).toBe('2026-10-03')
    const mine = groupByDay(applyChanges(slotsFromSnapshot(SNAPSHOT), [change(3, '2026-10-04T08:00:00Z', { status: 'held', mine: true, until: '2026-10-02T09:40:00Z' })]), Date.parse('2026-10-02T09:30:00Z'))
    expect(dayToShow(mine)).toBe('2026-10-04')
    expect(dayToShow([])).toBeUndefined()
  })

  it('does not count a hold that ran out as the visitor\'s own', () => {
    const lapsed = groupByDay(applyChanges(slotsFromSnapshot(SNAPSHOT), [change(3, '2026-10-04T08:00:00Z', { status: 'held', mine: true, until: '2026-10-02T09:31:00Z' })]), Date.parse('2026-10-02T09:32:00Z'))
    expect(lapsed[1]).toMatchObject({ held: 0, free: 1, hasMine: false })
  })
})
