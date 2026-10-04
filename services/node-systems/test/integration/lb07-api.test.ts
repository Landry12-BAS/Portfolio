// LB-07's HTTP API, end to end through the real app: visitor tokens, request checking, every route's answers
// and errors, the visitor's limits, the busy state, and what another visitor can and cannot see. The database
// is real, the queue is driven by hand, the runner and the model are scripts.
import { randomBytes } from 'node:crypto'

import { LB07_BUG_IDS, lb07BugViewSchema, lb07EvidenceViewSchema, lb07LimitsViewSchema, lb07ReportSchema, lb07RunViewSchema, lb07SampleViewSchema, lb07TestViewSchema } from '@lb/contracts'
import type { Lb07RunView } from '@lb/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { z } from 'zod'

import { SECURITY_HEADERS } from '../../src/core/security-headers.ts'
import type { GoldenCase } from '../../src/modules/lb07/golden/cases.ts'
import { loadGolden } from '../support/lb07.ts'
import { createLb07ApiHarness } from '../support/lb07-api.ts'
import type { Lb07ApiHarness } from '../support/lb07-api.ts'
import { drive, referenceModel } from '../support/lb07-engine.ts'
import { bugScript } from '../support/lb07-fake-runner.ts'

let api: Lb07ApiHarness
const coupon = loadGolden().find(entry => entry.id === 'coupon-double-discount') as GoldenCase

beforeAll(async () => {
  api = await createLb07ApiHarness(inject('databaseUrl'))
})

afterAll(() => api.close())

beforeEach(() => {
  api.engine.clock.set('2026-10-02T09:00:00.000Z')
  api.engine.runner.script = bugScript(coupon.bugs)
  api.engine.models.current = referenceModel(coupon)
})

/** A visitor session of its own. */
function newSession(): string {
  return `session-${randomBytes(8).toString('hex')}`
}

/** Starts the coupon sample and returns the run. */
async function startSample(session: string): Promise<Lb07RunView> {
  const response = await api.call('POST', '/runs', session, { from: 'sample', sampleId: coupon.id })
  expect(response.statusCode, response.body).toBe(201)
  return lb07RunViewSchema.parse(response.json())
}

describe('authentication', () => {
  it('refuses a missing token, one for another system and an expired one with the same 401', async () => {
    for (const headers of [{}, { authorization: `Bearer ${api.tokenFor('s', 'lb-08')}` }, { authorization: `Bearer ${api.tokenFor('s', 'lb-07', -10)}` }]) {
      const response = await api.app.inject({ method: 'GET', url: '/api/lb07/limits', headers })
      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } })
    }
  })

  it('answers with the platform\'s security headers', async () => {
    const response = await api.call('GET', '/limits', newSession())
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers[name.toLowerCase()]).toBe(value)
  })
})

describe('the catalogue', () => {
  it('lists the six bugs, the visitor\'s fresh day and the samples', async () => {
    const session = newSession()
    const bugs = z.array(lb07BugViewSchema).parse((await api.call('GET', '/bugs', session)).json())
    expect(bugs.map(bug => bug.id)).toEqual([...LB07_BUG_IDS])
    const limits = lb07LimitsViewSchema.parse((await api.call('GET', '/limits', session)).json())
    expect(limits.runs).toEqual({ limit: 2, used: 0, remaining: 2 })
    expect(limits.resetsAt).toBe('2026-10-03T00:00:00.000Z')
    const samples = z.array(lb07SampleViewSchema).parse((await api.call('GET', '/samples', session)).json())
    expect(samples.length).toBeGreaterThanOrEqual(6)
    expect(samples.some(sample => sample.id === coupon.id && sample.bugs.includes('coupon-twice'))).toBe(true)
  })
})

describe('a run', () => {
  it('is started from a sample, followed while it waits and runs, and read as a report, a test and evidence', async () => {
    const session = newSession()
    const run = await startSample(session)
    expect(run).toMatchObject({ state: 'queued', queuePosition: 0 })
    expect((await api.call('GET', `/runs/${run.id}/report`, session)).statusCode).toBe(409)
    expect((await api.call('GET', `/runs/${run.id}/report`, session)).json().error.code).toBe('not_ready')
    await drive(api.engine)
    const view = lb07RunViewSchema.parse((await api.call('GET', `/runs/${run.id}`, session)).json())
    expect(view.state).toBe('done')
    expect(view.steps).toHaveLength(coupon.plan.length)
    const report = lb07ReportSchema.parse((await api.call('GET', `/runs/${run.id}/report`, session)).json())
    expect(report.verification.verdict).toBe('kept')
    expect(report.findings).toHaveLength(1)
    const test = lb07TestViewSchema.parse((await api.call('GET', `/runs/${run.id}/test`, session)).json())
    expect(test.filename).toMatch(/\.spec\.ts$/)
    const evidence = lb07EvidenceViewSchema.parse((await api.call('GET', `/runs/${run.id}/evidence/e1`, session)).json())
    expect(evidence.kind).toBe('screenshot')
    expect((await api.call('GET', `/runs/${run.id}/evidence/e99`, session)).statusCode).toBe(404)
    const mine = z.array(lb07RunViewSchema).parse((await api.call('GET', '/runs', session)).json())
    expect(mine.map(entry => entry.id)).toEqual([run.id])
  })

  it('is started from the visitor\'s own goal and bugs, and refuses a goal that is too long, a bug that does not exist, or a bug listed twice', async () => {
    const session = newSession()
    const started = await api.call('POST', '/runs', session, { from: 'custom', goal: 'Add one bag of Colombia Huila and check the cart says 1 item.', bugs: ['cart-off-by-one'] })
    expect(started.statusCode, started.body).toBe(201)
    expect(lb07RunViewSchema.parse(started.json())).toMatchObject({ origin: 'custom', sampleId: null, bugs: ['cart-off-by-one'] })
    for (const body of [{ from: 'custom', goal: 'x'.repeat(301), bugs: [] }, { from: 'custom', goal: 'Buy a bag.', bugs: ['sql-injection'] }, { from: 'custom', goal: 'Buy a bag.', bugs: ['missing-alt', 'missing-alt'] }, { from: 'custom', goal: 'Buy\u0007a bag.', bugs: [] }, { from: 'sample' }]) {
      const refused = await api.call('POST', '/runs', session, body)
      expect(refused.statusCode, refused.body).toBe(422)
      expect(JSON.stringify(refused.json())).not.toContain('sql-injection')
    }
    await drive(api.engine)
  })

  it('is another visitor\'s secret, can be deleted early, and is gone after its hour', async () => {
    const session = newSession()
    const run = await startSample(session)
    expect((await api.call('GET', `/runs/${run.id}`, newSession())).statusCode).toBe(404)
    expect((await api.call('DELETE', `/runs/${run.id}`, newSession())).statusCode).toBe(404)
    await drive(api.engine)
    const other = await startSample(session)
    expect((await api.call('DELETE', `/runs/${run.id}`, session)).statusCode).toBe(204)
    expect((await api.call('GET', `/runs/${run.id}`, session)).statusCode).toBe(404)
    api.engine.clock.advance(61 * 60_000)
    expect((await api.call('GET', `/runs/${other.id}`, session)).statusCode).toBe(404)
    api.engine.clock.set('2026-10-02T09:00:00.000Z')
    await drive(api.engine)
  })
})

describe('the limits', () => {
  it('refuses the third run of the day with 429, Retry-After and resets_at, and says busy with 503 when the queue is full', async () => {
    const session = newSession()
    await startSample(session)
    await startSample(session)
    const third = await api.call('POST', '/runs', session, { from: 'sample', sampleId: coupon.id })
    expect(third.statusCode).toBe(429)
    expect(third.json().error).toMatchObject({ code: 'daily_limit', resets_at: '2026-10-03T00:00:00.000Z' })
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0)
    for (const visitor of [newSession(), newSession()]) await startSample(visitor)
    const busy = await api.call('POST', '/runs', newSession(), { from: 'sample', sampleId: coupon.id })
    expect(busy.statusCode).toBe(503)
    expect(busy.json().error.code).toBe('busy')
    expect(busy.headers['retry-after']).toBe('60')
    await drive(api.engine)
  })
})
