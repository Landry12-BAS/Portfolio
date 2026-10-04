// Tests of the exports LB-09's board makes in the browser: the JSON holds the meeting, the items and
// the transcript; the CSV has a header and quotes every cell, doubles quotes inside one, and keeps a
// comma in a cell; the plain-English follow-up names each owner and deadline; and every format says
// the speaker labels were inferred from the words.
import { describe, expect, it } from 'vitest'

import { exportCsv, exportJson, exportMeeting, exportText, LABELS_NOTE } from '~/boards/lb-09/export'
import type { Item, Meeting, Segment } from '~/boards/lb-09/schemas'

const meeting: Meeting = {
  id: 'abcdefghijklmnop',
  sample: 'monday-roasting-plan',
  mode: 'fast',
  status: 'done',
  stage: 'done',
  failure: null,
  run_id: 'lb09-run',
  language: 'en',
  heard_language: 'en',
  transcriber: 'lb-stt',
  duration_seconds: 41.1,
  source_bytes: 164_000,
  model_calls: 2,
  dropped_items: 1,
  labels_inferred_from_text: true,
  created_at: '2026-10-02T09:30:00Z',
  updated_at: '2026-10-02T09:30:05Z',
  expires_at: '2026-10-03T09:30:00Z',
}

const segments: Segment[] = [
  { position: 0, start: 0.2, end: 3.1, text: 'Let\'s start with the Ethiopia.', speaker: 0, label: 'Mia' },
  { position: 1, start: 3.4, end: 7.0, text: 'I will order the bags, say "forty", by Friday.', speaker: 1, label: 'Speaker 2' },
]

const items: Item[] = [
  { position: 0, kind: 'decision', text: 'Roast the Ethiopia first', owner: null, deadline: null, evidence: 'Let\'s start with the Ethiopia.', start: 0.2, end: 3.1, first_segment: 0, last_segment: 0 },
  { position: 1, kind: 'action', text: 'Order the bags, "forty"', owner: 'Speaker 2', deadline: 'Friday', evidence: 'I will order the bags, say "forty", by Friday.', start: 3.4, end: 7, first_segment: 1, last_segment: 1 },
]

describe('the exports', () => {
  it('write the meeting, its items and its transcript as JSON, with the labels note', () => {
    const document = JSON.parse(exportJson(meeting, segments, items)) as { meeting: Record<string, unknown>, items: unknown[], transcript: { speaker: string }[] }
    expect(document.meeting).toEqual({ id: meeting.id, mode: 'fast', duration_seconds: 41.1, transcriber: 'lb-stt', labels_note: LABELS_NOTE })
    expect(document.items).toHaveLength(2)
    expect(document.transcript.map(line => line.speaker)).toEqual(['Mia', 'Speaker 2'])
  })

  it('write the items as CSV with every cell quoted and inner quotes doubled', () => {
    const lines = exportCsv(items).trimEnd().split('\n')
    expect(lines[0]).toBe('"kind","text","owner","deadline","start_seconds","end_seconds","evidence"')
    expect(lines[1]).toBe('"decision","Roast the Ethiopia first","","","0.2","3.1","Let\'s start with the Ethiopia."')
    expect(lines[2]).toBe('"action","Order the bags, ""forty""","Speaker 2","Friday","3.4","7","I will order the bags, say ""forty"", by Friday."')
  })

  it('write the follow-up for LB-08 with each decision, each owner and deadline, and the labels note', () => {
    const text = exportText(items)
    expect(text).toContain('Post these decisions to the team channel: Roast the Ethiopia first.')
    expect(text).toContain('- Speaker 2: Order the bags, "forty" by Friday.')
    expect(text).toContain(`(${LABELS_NOTE})`)
    expect(exportText([])).toContain('There are no action items to remind anyone of.')
  })

  it('name each file after the meeting and its format', () => {
    expect(exportMeeting('json', meeting, segments, items)).toMatchObject({ filename: 'meeting-abcdefghijklmnop.json', contentType: 'application/json' })
    expect(exportMeeting('csv', meeting, segments, items)).toMatchObject({ filename: 'meeting-abcdefghijklmnop.csv', contentType: 'text/csv' })
    expect(exportMeeting('text', meeting, segments, items)).toMatchObject({ filename: 'meeting-abcdefghijklmnop.txt', contentType: 'text/plain' })
  })
})
