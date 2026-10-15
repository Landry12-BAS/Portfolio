// Tests that the measured characteristics a datasheet shows are its recordings', not copies that drifted: every
// recording of a system is reduced the way the page's module reduces it, and the rows must equal the constant
// the page ships with, in the order of the system's curated samples. No network, no back end.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { recordingSchema } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { MEASURED, measuredOf, recordedDayOf } from '../../shared/data/measured.ts'
import { LB01_SAMPLES } from '../../shared/data/samples/lb01.ts'

const RECORDINGS = join(import.meta.dirname, '../../recordings')

/** Reads and checks every recording of a system, by sample. */
function recordingsOf(system: string) {
  const folder = join(RECORDINGS, system)
  return new Map(readdirSync(folder).filter(name => name.endsWith('.json')).map((name) => {
    const recording = recordingSchema.parse(JSON.parse(readFileSync(join(folder, name), 'utf8')))
    return [recording.sample, recording] as const
  }))
}

describe('LB-01\'s measured characteristics', () => {
  const rows = MEASURED['lb-01'] ?? []
  const recordings = recordingsOf('lb-01')

  it('have one row per curated sample, in the samples\' order', () => {
    expect(rows.map(row => row.sample)).toEqual(LB01_SAMPLES.map(sample => sample.id))
  })

  it('are each recording, reduced: the same counts, tokens, time and end', () => {
    for (const row of rows) {
      const recording = recordings.get(row.sample)
      expect(recording, `a recording of ${row.sample}`).toBeDefined()
      expect(measuredOf(recording!)).toEqual(row)
    }
  })

  it('come from live runs, made on one day, which the table states once', () => {
    for (const recording of recordings.values()) expect(recording.origin).toBe('live')
    expect(recordedDayOf(rows)).toBe('2026-10-07')
  })

  it('agree with the stats each recording carries', () => {
    for (const row of rows) {
      const stats = recordings.get(row.sample)!.stats
      expect({ steps: row.steps, calls: row.calls, durationMs: row.durationMs }).toEqual({ steps: stats.steps, calls: stats.modelCalls, durationMs: stats.durationMs })
    }
  })

  it('show the one ticket handed to a person early with its reason, and the rest as drafts', () => {
    expect(rows.filter(row => row.outcome === 'escalated')).toEqual([expect.objectContaining({ sample: 'injection-admin-mode', reason: 'injection', steps: 3, calls: 1 })])
    expect(rows.filter(row => row.outcome === 'draft').every(row => row.steps === 9 && row.reason === undefined)).toBe(true)
  })
})

describe('recordedDayOf', () => {
  it('gives nothing when the rows were recorded on different days', () => {
    const [first, second] = MEASURED['lb-01'] ?? []
    expect(recordedDayOf([first!, { ...second!, recordedAt: '2026-10-08' }])).toBeUndefined()
  })
})
