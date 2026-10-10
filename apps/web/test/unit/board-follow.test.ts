// Unit tests for how the Scope paces its reads of a run's trace and merges what comes back, and
// for the daily-quota arithmetic every board shares.
import type { Span } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { BUSY_READ_DELAY_MS, QUIET_READ_DELAY_MS, mergeSpans, readDelay } from '~/board-kit/follow'
import { exhausted, quotaFromRuns, timeUntil, untouched } from '~/board-kit/quota'

/** Makes a span with the given ID. */
function span(spanId: string): Span {
  return { v: 1, runId: 'run-0123456789', system: 'lb-01', spanId, kind: 'system.step', name: 'step', status: 'ok', startMs: 0, endMs: 1, attrs: {} }
}

describe('readDelay', () => {
  it('reads again at once when the page said more was waiting', () => {
    expect(readDelay({ more: true, added: 500, quietReads: 0 })).toBe(0)
  })

  it('looks again soon after a read that brought new spans', () => {
    expect(readDelay({ more: false, added: 2, quietReads: 0 })).toBe(BUSY_READ_DELAY_MS)
  })

  it('backs off as reads bring nothing, up to a cap', () => {
    const delays = [1, 2, 3, 4, 5, 20].map(quietReads => readDelay({ more: false, added: 0, quietReads }))
    expect(delays).toEqual([1_000, 1_500, 2_000, 2_500, 2_500, 2_500])
    expect(Math.max(...delays)).toBe(QUIET_READ_DELAY_MS)
  })
})

describe('mergeSpans', () => {
  it('adds new spans after the known ones, in arrival order', () => {
    const merged = mergeSpans([span('a'), span('b')], [span('c'), span('d')])
    expect(merged.spans.map(item => item.spanId)).toEqual(['a', 'b', 'c', 'd'])
    expect(merged.added).toBe(2)
  })

  it('does not repeat a span it already has, nor one repeated within the page', () => {
    const merged = mergeSpans([span('a')], [span('a'), span('b'), span('b')])
    expect(merged.spans.map(item => item.spanId)).toEqual(['a', 'b'])
    expect(merged.added).toBe(1)
  })

  it('keeps what it has when a page is empty', () => {
    const known = [span('a')]
    expect(mergeSpans(known, [])).toEqual({ spans: known, added: 0 })
  })
})

describe('quota', () => {
  // The day ends at midnight UTC on the 3rd, so it began at midnight on the 2nd.
  const resetsAt = '2026-10-03T00:00:00.000Z'

  it('counts what was made since the day began and subtracts it from the limit', () => {
    const quota = quotaFromRuns(['2026-10-02T08:00:00.000Z', '2026-10-02T23:59:59.000Z', '2026-10-01T23:59:59.000Z'], 20, resetsAt)
    expect(quota).toEqual({ limit: 20, used: 2, remaining: 18, resetsAt })
  })

  it('never goes below nothing left', () => {
    const times = Array.from({ length: 25 }, () => '2026-10-02T12:00:00.000Z')
    expect(quotaFromRuns(times, 20, resetsAt)).toMatchObject({ used: 25, remaining: 0 })
  })

  it('is all still to use before anything is counted', () => {
    expect(untouched(20, resetsAt)).toEqual({ limit: 20, used: 0, remaining: 20, resetsAt })
  })

  it('has nothing left after a refusal, whatever the count said', () => {
    expect(exhausted(quotaFromRuns([], 20, resetsAt))).toEqual({ limit: 20, used: 20, remaining: 0, resetsAt })
  })

  it('says how long until the allowance starts again', () => {
    const now = Date.parse('2026-10-02T18:40:00.000Z')
    expect(timeUntil(resetsAt, now)).toEqual({ hours: 5, minutes: 20 })
    expect(timeUntil(resetsAt, Date.parse('2026-10-03T01:00:00.000Z'))).toEqual({ hours: 0, minutes: 0 })
  })
})
