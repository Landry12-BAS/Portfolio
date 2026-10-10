// Unit tests for the circuit breaker: tripping, probing, backing off and cooling down.
import { describe, expect, it } from 'vitest'

import { CircuitBreaker } from '../../src/breaker.ts'

/** Makes a breaker with a clock the test controls. */
function breaker() {
  let now = 1_000_000
  const instance = new CircuitBreaker(() => now, { failureThreshold: 3, openMs: 30_000, maxOpenMs: 100_000 })
  return { instance, advance: (ms: number) => (now += ms), now: () => now }
}

describe('circuit breaker', () => {
  it('stays closed through fewer failures than the threshold', () => {
    const { instance } = breaker()
    instance.failure('groq/gpt-oss-120b')
    instance.failure('groq/gpt-oss-120b')
    expect(instance.admit('groq/gpt-oss-120b')).toEqual({ ok: true })
  })

  it('opens after repeated failures, then lets one probe through', () => {
    const { instance, advance, now } = breaker()
    for (let i = 0; i < 3; i += 1) instance.failure('m')
    expect(instance.admit('m')).toEqual({ ok: false, retryAtMs: now() + 30_000 })

    advance(30_000)
    expect(instance.admit('m')).toEqual({ ok: true })
    // A second caller waits for the probe's verdict.
    expect(instance.admit('m').ok).toBe(false)

    instance.success('m')
    expect(instance.admit('m')).toEqual({ ok: true })
    expect(instance.admit('m')).toEqual({ ok: true })
  })

  it('doubles the pause each time a probe fails, up to the maximum', () => {
    const { instance, advance, now } = breaker()
    for (let i = 0; i < 3; i += 1) instance.failure('m')
    advance(30_000)
    instance.admit('m')
    instance.failure('m')
    expect(instance.admit('m')).toEqual({ ok: false, retryAtMs: now() + 60_000 })

    advance(60_000)
    instance.admit('m')
    instance.failure('m')
    advance(60_000)
    instance.admit('m')
    instance.failure('m')
    expect(instance.admit('m')).toEqual({ ok: false, retryAtMs: now() + 100_000 })
  })

  it('honours a provider\'s Retry-After without counting a failure', () => {
    const { instance, advance, now } = breaker()
    instance.coolDown('m', now() + 20_000)
    expect(instance.admit('m')).toEqual({ ok: false, retryAtMs: now() + 20_000 })
    advance(20_000)
    expect(instance.admit('m')).toEqual({ ok: true })
    expect(instance.admit('m')).toEqual({ ok: true })
  })

  it('frees the probe slot when the probe never reached the provider', () => {
    const { instance, advance } = breaker()
    for (let i = 0; i < 3; i += 1) instance.failure('m')
    advance(30_000)
    expect(instance.admit('m').ok).toBe(true)
    instance.release('m')
    expect(instance.admit('m').ok).toBe(true)
  })
})
