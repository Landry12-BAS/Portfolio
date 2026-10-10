// Unit tests for the limit on how often one run's trace may be read: a bucket of reads per run that
// refills at a steady rate, so a burst is fine and a flood is not, and that keeps only a bounded
// number of runs in memory.
import { describe, expect, it } from 'vitest'

import { ReadLimiter } from '../../src/read-limit.ts'

/** A limiter on a clock the test moves: 4 reads to start with, refilled at 2 a second, and room for 3 runs. */
function limiterWithClock(): { limiter: ReadLimiter, advance: (ms: number) => void } {
  let now = 1_790_000_000_000
  const limiter = new ReadLimiter(() => now, { burst: 4, perSecond: 2, maxRuns: 3 })
  return {
    limiter,
    advance: (ms) => {
      now += ms
    },
  }
}

describe('a run\'s reads', () => {
  it('are let through up to the burst, then refused with how long to wait', () => {
    const { limiter } = limiterWithClock()

    const answers = Array.from({ length: 6 }, () => limiter.take('run-a'))

    expect(answers).toEqual([undefined, undefined, undefined, undefined, 500, 500])
  })

  it('come back at the steady rate: one more read every half second', () => {
    const { limiter, advance } = limiterWithClock()
    for (let read = 0; read < 4; read += 1) limiter.take('run-a')

    advance(250)
    expect(limiter.take('run-a')).toBe(250)
    advance(250)
    expect(limiter.take('run-a')).toBeUndefined()
    expect(limiter.take('run-a')).toBe(500)
    advance(1_000)
    expect(limiter.take('run-a')).toBeUndefined()
    expect(limiter.take('run-a')).toBeUndefined()
    expect(limiter.take('run-a')).toBe(500)
  })

  it('never save up more than the burst, however long a run is left alone', () => {
    const { limiter, advance } = limiterWithClock()
    limiter.take('run-a')
    advance(3_600_000)

    const answers = Array.from({ length: 5 }, () => limiter.take('run-a'))

    expect(answers).toEqual([undefined, undefined, undefined, undefined, 500])
  })

  it('are counted for each run on its own', () => {
    const { limiter } = limiterWithClock()
    for (let read = 0; read < 4; read += 1) limiter.take('run-a')

    expect(limiter.take('run-a')).toBe(500)
    expect(limiter.take('run-b')).toBeUndefined()
  })

  it('do not use up a read when they are refused', () => {
    const { limiter, advance } = limiterWithClock()
    for (let read = 0; read < 4; read += 1) limiter.take('run-a')
    for (let read = 0; read < 10; read += 1) limiter.take('run-a')

    advance(500)

    expect(limiter.take('run-a')).toBeUndefined()
  })
})

describe('the runs it remembers', () => {
  it('are no more than it was given room for: the one left alone longest is forgotten first', () => {
    const { limiter } = limiterWithClock()
    for (const run of ['run-a', 'run-b', 'run-c']) for (let read = 0; read < 4; read += 1) limiter.take(run)
    expect(limiter.size).toBe(3)

    limiter.take('run-d')

    expect(limiter.size).toBe(3)
    // run-a was forgotten, so it starts again with a whole burst; run-b and run-c are still counted.
    expect(limiter.take('run-a')).toBeUndefined()
    expect(limiter.take('run-c')).toBe(500)
  })

  it('keep a run that is being read, however long ago it first appeared', () => {
    const { limiter } = limiterWithClock()
    limiter.take('run-a')
    limiter.take('run-b')
    limiter.take('run-c')
    limiter.take('run-a')
    limiter.take('run-d')

    // run-b was left alone longest, not run-a, which was read again after run-c.
    expect(limiter.size).toBe(3)
    for (let read = 0; read < 2; read += 1) expect(limiter.take('run-a')).toBeUndefined()
    expect(limiter.take('run-a')).toBe(500)
  })
})

describe('the settings', () => {
  it('must be sensible numbers', () => {
    const clock = () => 0

    expect(() => new ReadLimiter(clock, { burst: 0, perSecond: 1, maxRuns: 1 })).toThrow(RangeError)
    expect(() => new ReadLimiter(clock, { burst: 1, perSecond: 0, maxRuns: 1 })).toThrow(RangeError)
    expect(() => new ReadLimiter(clock, { burst: 1, perSecond: 1, maxRuns: 0 })).toThrow(RangeError)
    expect(() => new ReadLimiter(clock, { burst: 1.5, perSecond: 1, maxRuns: 1 })).toThrow(RangeError)
  })
})
