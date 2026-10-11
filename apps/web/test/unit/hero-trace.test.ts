// Tests that the run the landing page plays is the recording's, not a copy that drifted: the recording is
// reduced the way the hero's module reduces it, and must equal the constant the page ships with. A change to
// the recording, or to the reducer, fails here and names what moved. No network, no back end.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { recordingSchema } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { HERO_TRACE, heroTraceOf } from '../../shared/data/hero-trace.ts'

const RECORDING = join(import.meta.dirname, '../../recordings/lb-01/torn-bag.json')

describe('the landing page\'s trace', () => {
  it('is the recorded LB-01 run, reduced: the same steps, times, calls and tokens', () => {
    const recording = recordingSchema.parse(JSON.parse(readFileSync(RECORDING, 'utf8')))

    expect(heroTraceOf(recording)).toEqual(HERO_TRACE)
  })

  it('was made on the live back end, and the hero says when', () => {
    const recording = recordingSchema.parse(JSON.parse(readFileSync(RECORDING, 'utf8')))

    expect(recording.origin).toBe('live')
    expect(HERO_TRACE.recordedAt).toBe(recording.recordedAt.slice(0, 10))
  })

  it('reads as the Scope draws it: every model call sits under a step, in time order, inside the run', () => {
    let previous = -1
    for (const step of HERO_TRACE.steps) {
      expect(step.startMs).toBeGreaterThanOrEqual(previous)
      expect(step.endMs).toBeGreaterThanOrEqual(step.startMs)
      expect(step.endMs).toBeLessThanOrEqual(HERO_TRACE.totalMs)
      if (step.call) expect(['guard', 'retrieval', 'model']).toContain(step.kind)
      else expect(['step', 'tool']).toContain(step.kind)
      previous = step.startMs
    }
    expect(HERO_TRACE.steps.filter(step => step.call)).toHaveLength(5)
  })
})
