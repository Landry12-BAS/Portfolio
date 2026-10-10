// Tests of the schemas LB-09's board checks every answer with: the mock back end's answers pass
// (they are the shape the real service writes), and an answer that strays (an unknown status, a
// transcript past its bounds, a label too long) is refused rather than shown.
import { Lb09Mock, readLb09Seed } from '@lb/api-clients/testing'
import { describe, expect, it } from 'vitest'

import { isOver, itemsSchema, limitsSchema, meetingSchema, sampleListSchema, transcriptSchema } from '~/boards/lb-09/schemas'

const NOW = Date.parse('2026-10-02T09:30:00.000Z')

/** A mock whose clock stands at a moment, so a meeting can be read at any stage. */
function mockAt(moment: number) {
  return new Lb09Mock(readLb09Seed(), { now: () => moment, verify: () => 'visitor' })
}

describe('LB-09\'s schemas against the mock back end', () => {
  it('accept the limits, the samples and a meeting as it is taken', () => {
    const mock = mockAt(NOW)
    expect(() => limitsSchema.parse(mock.limits('visitor').body)).not.toThrow()
    expect(() => sampleListSchema.parse(mock.samples().body)).not.toThrow()
    const started = mock.start('visitor', { source: 'sample', sample: 'monday-roasting-plan', mode: 'fast', language: 'en' })
    expect(started.status).toBe(202)
    const meeting = meetingSchema.parse(started.body)
    expect(meeting.status).toBe('received')
    expect(meeting.labels_inferred_from_text).toBe(true)
    expect(isOver(meeting)).toBe(false)
  })

  it('accept a finished meeting, its transcript and its items', () => {
    let clock = NOW
    const mock = new Lb09Mock(readLb09Seed(), { now: () => clock, verify: () => 'visitor', stageMs: 100 })
    const started = meetingSchema.parse(mock.start('visitor', { source: 'sample', sample: 'monday-roasting-plan', mode: 'private', language: 'en' }).body)
    clock += 10_000
    const meeting = meetingSchema.parse(mock.get('visitor', started.id).body)
    expect(meeting.status).toBe('done')
    expect(isOver(meeting)).toBe(true)
    const transcript = transcriptSchema.parse(mock.transcript('visitor', started.id).body)
    expect(transcript.segments.length).toBeGreaterThan(0)
    const items = itemsSchema.parse(mock.items('visitor', started.id).body)
    expect(items.items.filter(item => item.kind === 'action')).toHaveLength(3)
    expect(items.items.filter(item => item.kind === 'decision')).toHaveLength(2)
  })

  it('refuse a meeting with a status the protocol does not have, and one whose counts are out of bounds', () => {
    const mock = mockAt(NOW)
    const taken = mock.start('visitor', { source: 'sample', sample: 'weekend-staffing', mode: 'fast', language: 'en' }).body as Record<string, unknown>
    expect(meetingSchema.safeParse({ ...taken, status: 'running' }).success).toBe(false)
    expect(meetingSchema.safeParse({ ...taken, model_calls: 11 }).success).toBe(false)
    expect(meetingSchema.safeParse({ ...taken, labels_inferred_from_text: false }).success).toBe(false)
    expect(meetingSchema.safeParse({ ...taken, id: 'short' }).success).toBe(false)
  })

  it('refuse a transcript with a label too long, a segment out of time, or too many segments', () => {
    const base = { meeting: 'abcdefghijklmnop', labels_note: 'note' }
    const segment = { position: 0, start: 0, end: 1, text: 'Hello', speaker: 0, label: 'Speaker 1' }
    expect(transcriptSchema.safeParse({ ...base, segments: [segment] }).success).toBe(true)
    expect(transcriptSchema.safeParse({ ...base, segments: [{ ...segment, label: 'x'.repeat(41) }] }).success).toBe(false)
    expect(transcriptSchema.safeParse({ ...base, segments: [{ ...segment, end: 500 }] }).success).toBe(false)
    expect(transcriptSchema.safeParse({ ...base, segments: Array.from({ length: 501 }, (_, position) => ({ ...segment, position })) }).success).toBe(false)
  })

  it('refuse an item whose kind is unknown or whose evidence is too long', () => {
    const item = { position: 0, kind: 'action', text: 'Order bags', owner: 'Mia', deadline: 'Friday', evidence: 'I will order the bags by Friday.', start: 1, end: 3, first_segment: 0, last_segment: 0 }
    const base = { meeting: 'abcdefghijklmnop', dropped: 0 }
    expect(itemsSchema.safeParse({ ...base, items: [item] }).success).toBe(true)
    expect(itemsSchema.safeParse({ ...base, items: [{ ...item, kind: 'question' }] }).success).toBe(false)
    expect(itemsSchema.safeParse({ ...base, items: [{ ...item, evidence: 'x'.repeat(401) }] }).success).toBe(false)
  })
})
