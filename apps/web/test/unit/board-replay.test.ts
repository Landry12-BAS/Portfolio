// Unit tests for the replay player's plan and runner: a recording is spread over a few seconds,
// every recorded answer is handed over once and in order, spans appear as they ended, reduced
// motion shows everything at once, and a stopped replay says nothing more.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_REPLAY_MS, MIN_REPLAY_MS, planReplay, playReplay, spansInOrder } from '~/board-kit/replay'

import { recordLb01Sample } from '../support/recording'

describe('planReplay', () => {
  it('starts with the first recorded answer and no spans, and ends with everything', () => {
    const recording = recordLb01Sample()
    const plan = planReplay(recording, false)
    expect(plan[0]).toMatchObject({ atMs: 0, exchangesApplied: 1, finished: false })
    expect(plan[0]?.spansShown).toBe(0)
    const last = plan.at(-1)
    expect(last).toMatchObject({ exchangesApplied: recording.exchanges.length, spansShown: recording.trace.spans.length, finished: true })
  })

  it('fits the recorded run into the replay limits', () => {
    const recording = recordLb01Sample()
    // The mock's run took 2.7 seconds: inside the limits, so it plays at its own pace.
    expect(planReplay(recording, false).at(-1)?.atMs).toBe(recording.stats.durationMs)
    const slow = { ...recording, stats: { ...recording.stats, durationMs: 60_000 } }
    expect(planReplay(slow, false).at(-1)?.atMs).toBe(MAX_REPLAY_MS)
    const quick = { ...recording, stats: { ...recording.stats, durationMs: 100 } }
    expect(planReplay(quick, false).at(-1)?.atMs).toBe(MIN_REPLAY_MS)
  })

  it('never goes back in time or takes an answer or a span back', () => {
    const plan = planReplay(recordLb01Sample(), false)
    for (const [index, step] of plan.slice(1).entries()) {
      const before = plan[index]
      expect(step.atMs).toBeGreaterThan(before?.atMs ?? -1)
      expect(step.exchangesApplied).toBeGreaterThanOrEqual(before?.exchangesApplied ?? 0)
      expect(step.spansShown).toBeGreaterThanOrEqual(before?.spansShown ?? 0)
    }
  })

  it('shows everything at once when the visitor prefers reduced motion', () => {
    const recording = recordLb01Sample()
    expect(planReplay(recording, true)).toEqual([{ atMs: 0, exchangesApplied: recording.exchanges.length, spansShown: recording.trace.spans.length, finished: true }])
  })

  it('orders a recording\'s spans by when they ended', () => {
    const ordered = spansInOrder(recordLb01Sample())
    expect(ordered.map(span => span.endMs)).toEqual([...ordered.map(span => span.endMs)].sort((a, b) => a - b))
    expect(ordered.at(-1)?.kind).toBe('system.run')
  })
})

describe('playReplay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hands over each answer once, in order, and reports the spans as they appear', () => {
    const recording = recordLb01Sample()
    const plan = planReplay(recording, false)
    const applied: number[] = []
    const shown: [number, boolean][] = []
    playReplay(plan, { applyExchange: index => applied.push(index), showSpans: (count, finished) => shown.push([count, finished]) })
    expect(applied).toEqual([0])
    vi.advanceTimersByTime(MAX_REPLAY_MS)
    expect(applied).toEqual([0, 1, 2])
    expect(shown.at(-1)).toEqual([recording.trace.spans.length, true])
    expect(shown.filter(([, finished]) => finished)).toHaveLength(1)
  })

  it('says nothing more once it is stopped', () => {
    const plan = planReplay(recordLb01Sample(), false)
    const applied: number[] = []
    const run = playReplay(plan, { applyExchange: index => applied.push(index), showSpans: () => {} })
    run.stop()
    vi.advanceTimersByTime(MAX_REPLAY_MS)
    expect(applied).toEqual([0])
  })
})
