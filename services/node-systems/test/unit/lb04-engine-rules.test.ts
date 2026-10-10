// The engine's pure rules, with no database and no queue: how long a retry waits, what each way of
// failing means for a review, when a visitor's day ends and what the limit's error says, and how a
// review's root span is named. The rest of the engine is tested on a real Postgres and a real Redis in
// test/integration/lb04-*.test.ts.
import { GatewayCallError } from '@lb/common'
import type { GatewayCode } from '@lb/common'
import { LB04_LIMITS } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { ModelOutputInvalid } from '../../src/modules/lb04/analysis/pipeline.ts'
import { DEFAULT_CONFIG, retryDelayMs } from '../../src/modules/lb04/config.ts'
import { reactionTo } from '../../src/modules/lb04/engine/failures.ts'
import { rootSpanIdOf } from '../../src/modules/lb04/engine/trace.ts'
import { dailyLimit, dayOf, limitFor, nextReset } from '../../src/modules/lb04/engine/usage.ts'

describe('the wait before a retry', () => {
  it('doubles with each try already made, from the base wait', () => {
    expect([1, 2, 3, 4].map(attempt => retryDelayMs(DEFAULT_CONFIG, attempt))).toEqual([2_000, 4_000, 8_000, 16_000])
  })

  it('is never less than the gateway asked for, in whole seconds', () => {
    expect(retryDelayMs(DEFAULT_CONFIG, 1, 30)).toBe(30_000)
    expect(retryDelayMs(DEFAULT_CONFIG, 3, 1)).toBe(8_000)
  })

  it('is the production numbers: three attempts, and a contract kept for the hour the datasheet promises', () => {
    expect(DEFAULT_CONFIG.maxAttempts).toBe(3)
    expect(DEFAULT_CONFIG.keptMs).toBe(LB04_LIMITS.keptMinutes * 60_000)
    expect(DEFAULT_CONFIG.staleAfterMs).toBeGreaterThan(180_000)
  })
})

describe('what a failed attempt means', () => {
  it.each<GatewayCode>(['upstream_failed', 'upstream_timeout', 'gateway_unavailable', 'internal_error'])('is another try after the gateway\'s %s, with the wait it asked for', (code) => {
    expect(reactionTo(new GatewayCallError(code, 502, 12))).toEqual({ kind: 'retry', retryAfterSeconds: 12 })
  })

  it('is another try when the gateway cannot be reached at all', () => {
    expect(reactionTo(new GatewayCallError('unreachable', undefined, undefined))).toEqual({ kind: 'retry', retryAfterSeconds: undefined })
  })

  it.each<GatewayCode>(['quota_exceeded', 'budget_exhausted', 'upstream_rejected'])('is the end of the review as unavailable after %s: waiting would not help', (code) => {
    expect(reactionTo(new GatewayCallError(code, 429, undefined))).toEqual({ kind: 'fail', code: 'analysis_unavailable' })
  })

  it.each<GatewayCode>(['system_not_allowed', 'alias_not_allowed', 'invalid_service_token', 'input_too_large', 'invalid_request', 'model_not_found'])('is the end of the review as internal after %s: it is this deploy\'s fault and no visitor\'s', (code) => {
    expect(reactionTo(new GatewayCallError(code, 400, undefined))).toEqual({ kind: 'fail', code: 'internal' })
  })

  it('is the end of the review as invalid when the model never answered in a usable form', () => {
    expect(reactionTo(new ModelOutputInvalid())).toEqual({ kind: 'fail', code: 'analysis_invalid' })
  })

  it('is nothing the engine classifies for an error that has nothing to do with the gateway or the model', () => {
    expect(reactionTo(new Error('the database fell over'))).toBeUndefined()
    expect(reactionTo('a string')).toBeUndefined()
  })
})

describe('a visitor\'s day', () => {
  it('is a UTC day, and ends at the next 00:00 UTC', () => {
    expect(dayOf(new Date('2026-10-02T23:59:59.999Z'))).toBe('2026-10-02')
    expect(nextReset(new Date('2026-10-02T23:59:59.999Z')).toISOString()).toBe('2026-10-03T00:00:00.000Z')
    expect(nextReset(new Date('2026-12-31T00:00:00.000Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('allows what the datasheet promises: three contracts and ten files', () => {
    expect(limitFor('contract')).toBe(3)
    expect(limitFor('upload')).toBe(10)
  })

  it('says, when a day is spent, which limit it was, when it ends, and how many seconds that is', () => {
    const contracts = dailyLimit('contract', new Date('2026-10-02T23:00:00.000Z'))
    const files = dailyLimit('upload', new Date('2026-10-02T12:00:00.000Z'))

    expect(contracts).toMatchObject({ status: 429, code: 'daily_limit', details: { resetsAt: '2026-10-03T00:00:00.000Z', retryAfterSeconds: 3_600 } })
    expect(files).toMatchObject({ status: 429, code: 'upload_limit', details: { resetsAt: '2026-10-03T00:00:00.000Z', retryAfterSeconds: 43_200 } })
    expect(contracts.message).not.toMatch(/session|token/i)
  })
})

describe('a review\'s root span', () => {
  it('is named from the contract\'s id alone, so a step can name it as its parent before it exists, and two reviews never share one', () => {
    const a = rootSpanIdOf('11111111-1111-4111-8111-111111111111')
    const b = rootSpanIdOf('22222222-2222-4222-8222-222222222222')

    expect(a).toBe(rootSpanIdOf('11111111-1111-4111-8111-111111111111'))
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })
})
