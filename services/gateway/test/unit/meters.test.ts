// Unit tests for meters: windows, what a call reserves, settlement and refunds.
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { createMeter, modelMeters, quotaMeters, refund, settlement } from '../../src/budget/meters.ts'
import { loadRouting } from '../../src/routing/load.ts'

const routing = loadRouting(readFileSync(new URL('../../routing.yaml', import.meta.url), 'utf8'), {
  GROQ_API_KEY: 'k', CLOUDFLARE_API_TOKEN: 'k', CLOUDFLARE_ACCOUNT_ID: 'acc', OPENROUTER_API_KEY: 'k',
})
// 12:00:15 UTC on 28 Sep 2026.
const noon = Date.UTC(2026, 8, 28, 12, 0, 15)

describe('windows', () => {
  it('slides a minute window by weighting the previous minute', () => {
    const meter = createMeter('lb:', 'model:groq/gpt-oss-120b', 'minute', 'tokens', 7200, 500, noon)
    const minute = Math.floor(noon / 60_000)
    expect(meter.key).toBe(`lb:gw:meter:model:groq/gpt-oss-120b:tokens:m:${minute}`)
    expect(meter.previousKey).toBe(`lb:gw:meter:model:groq/gpt-oss-120b:tokens:m:${minute - 1}`)
    expect(meter.previousWeight).toBeCloseTo(0.75)
    expect(meter.resetAtMs).toBe((minute + 1) * 60_000)
  })

  it('resets a day window at 00:00 UTC', () => {
    const lateEvening = createMeter('lb:', 'provider:workers-ai', 'day', 'neurons', 9500, 10, Date.UTC(2026, 8, 28, 23, 59, 59))
    const justAfter = createMeter('lb:', 'provider:workers-ai', 'day', 'neurons', 9500, 10, Date.UTC(2026, 8, 29, 0, 0, 1))
    expect(lateEvening.key).not.toBe(justAfter.key)
    expect(lateEvening.previousWeight).toBe(0)
    expect(lateEvening.resetAtMs).toBe(Date.UTC(2026, 8, 29))
  })

  it('keeps one counter for a whole run, which never resets', () => {
    const meter = createMeter('lb:', 'run:lb-01:run-1', 'run', 'requests', 6, 1, noon)
    expect(meter.key).toBe('lb:gw:meter:run:lb-01:run-1:requests:run')
    expect(meter.resetAtMs).toBeUndefined()
  })
})

describe('what a call reserves', () => {
  it('reserves requests and tokens on a Groq model, cut to the ceilings', () => {
    const model = routing.models.get('groq/gpt-oss-120b')!
    const meters = modelMeters(routing, model, { input: 1000, output: 500 }, 'lb:', noon)
    expect(meters.map(meter => [meter.window, meter.unit, meter.limit, meter.amount])).toEqual([
      ['minute', 'requests', 27, 1],
      ['minute', 'tokens', 7200, 1500],
      ['day', 'requests', 950, 1],
      ['day', 'tokens', 190_000, 1500],
    ])
  })

  it('reserves one request per segment when a guard check sends several', () => {
    const guard = routing.models.get('groq/llama-prompt-guard-2-86m')!
    const meters = modelMeters(routing, guard, { input: 400, output: 24, requests: 3 }, 'lb:', noon)
    expect(meters.map(meter => [meter.window, meter.unit, meter.amount])).toEqual([
      ['minute', 'requests', 3],
      ['minute', 'tokens', 424],
      ['day', 'requests', 3],
      ['day', 'tokens', 424],
    ])
  })

  it('reserves Neurons on Workers AI\'s shared pool at the model\'s rates', () => {
    const model = routing.models.get('workers-ai/gpt-oss-120b')!
    const meters = modelMeters(routing, model, { input: 1000, output: 1000 }, 'lb:', noon)
    const neurons = meters.find(meter => meter.unit === 'neurons')!
    expect(neurons.scope).toBe('provider:workers-ai')
    expect(neurons.limit).toBe(9500)
    expect(neurons.amount).toBeCloseTo(100)
  })

  it('counts a system\'s calls per day, per visitor and per run', () => {
    const system = routing.systems.get('lb-01')!
    const meters = quotaMeters(system, 'session-abc', 'run-1', 'lb:', noon)
    expect(meters.map(meter => [meter.scope, meter.window, meter.limit])).toEqual([
      ['system:lb-01', 'day', 350],
      ['run:lb-01:run-1', 'run', 7],
      ['session:lb-01:session-abc', 'day', 140],
    ])
    expect(quotaMeters(system, undefined, 'run-1', 'lb:', noon)).toHaveLength(2)
  })
})

describe('after the call', () => {
  const model = routing.models.get('workers-ai/gpt-oss-120b')!
  const estimate = { input: 1000, output: 1000 }
  const meters = modelMeters(routing, model, estimate, 'lb:', noon)

  it('moves token and Neuron meters to the provider\'s real count', () => {
    const changes = settlement(meters, model, estimate, { input: 900, output: 100 })
    expect(changes).toHaveLength(1)
    expect(changes[0]?.meter.unit).toBe('neurons')
    expect(changes[0]?.delta).toBeCloseTo(900 * 0.031818 + 100 * 0.068182 - 100)
  })

  it('refunds everything but the request when a provider refused the call', () => {
    const groq = routing.models.get('groq/gpt-oss-20b')!
    const reserved = modelMeters(routing, groq, { input: 300, output: 200 }, 'lb:', noon)
    expect(refund(reserved).map(change => [change.meter.unit, change.delta])).toEqual([['tokens', -500], ['tokens', -500]])
  })
})
