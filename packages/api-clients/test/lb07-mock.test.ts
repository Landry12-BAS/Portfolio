// The mock's LB-07 over HTTP: a curated sample from the queue to the report, the generated test (the
// service's own template), the evidence (a real PNG, a snapshot), the trace (metadata only, its root
// last), the sample that re-plans, every golden case's verdict, a goal of the visitor's own planned by
// rules, the queue with its places and the busy refusal, the day's two runs, every failure code with the
// run given back exactly when the service gives it back, and every refusal (an unknown sample, someone
// else's run, a report asked for too early or of a failed run, evidence not made yet, a deleted run, a run
// past its hour). Every answer is also checked against the documents by the mock itself, so a drift from
// openapi.json fails here.
import { generateKeyPairSync } from 'node:crypto'

import { mintVisitorToken } from '@lb/common/visitors'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { LB07_FAILURE_CODES, lb07EvidenceViewSchema, lb07LimitsViewSchema, lb07ReportSchema, lb07RunViewSchema, lb07TestViewSchema, spanSchema } from '../../contracts/src/index.ts'
import type { Lb07FailureCode, Lb07RunView } from '../../contracts/src/index.ts'
import { generateTest } from '../../../services/node-systems/src/modules/lb07/agent/testgen.ts'
import { REFUNDED } from '../../../services/node-systems/src/modules/lb07/engine/failures.ts'
import { LB07_GIVEN_BACK, MOCK_REPLAN_SAMPLE, readLb07Seed, startMockBackend } from '../src/testing/index.ts'
import type { MockBackend } from '../src/testing/index.ts'

const site = generateKeyPairSync('ed25519')
const web = generateKeyPairSync('ed25519')
const TICK_MS = 100
const START = Date.parse('2026-10-05T10:00:00.000Z')
let mock: MockBackend
let clock = START
const seed = readLb07Seed()

const ANNA = 'session-anna-000000000000'
const BORIS = 'session-boris-00000000000'

beforeAll(async () => {
  mock = await startMockBackend({ siteKey: site.publicKey.export({ format: 'jwk' }).x ?? '', webKey: web.publicKey.export({ format: 'jwk' }).x ?? '', now: () => clock, lb07: { tickMs: TICK_MS } })
})
afterAll(async () => {
  await mock.close()
})
beforeEach(() => {
  mock.reset()
  clock = START
})

/** A visitor token for LB-07. */
function tokenFor(visitor: string): string {
  return mintVisitorToken(site.privateKey, { system: 'lb-07', sessionKey: visitor }, clock / 1000)
}

/** Calls one of LB-07's routes as a visitor. */
async function call(method: 'GET' | 'POST' | 'DELETE', path: string, visitor = ANNA, body?: unknown): Promise<{ status: number, json: unknown, headers: Headers }> {
  const response = await fetch(`${mock.url}/api/lb07${path}`, { method, headers: { 'authorization': `Bearer ${tokenFor(visitor)}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  return { status: response.status, json: text === '' ? undefined : JSON.parse(text) as unknown, headers: response.headers }
}

/** Starts a sample as a visitor and returns the run as the API first shows it. */
async function startSample(sampleId: string, visitor = ANNA): Promise<Lb07RunView> {
  const started = await call('POST', '/runs', visitor, { from: 'sample', sampleId })
  expect(started.status).toBe(201)
  return lb07RunViewSchema.parse(started.json)
}

/** Reads a run. */
async function read(id: string, visitor = ANNA): Promise<Lb07RunView> {
  return lb07RunViewSchema.parse((await call('GET', `/runs/${id}`, visitor)).json)
}

/** Moves the clock a beat at a time until the run has ended, and returns every state it showed on the way. */
async function follow(id: string, visitor = ANNA): Promise<{ states: string[], last: Lb07RunView }> {
  const states: string[] = []
  for (let beat = 0; beat < 1_000; beat += 1) {
    const view = await read(id, visitor)
    if (states.at(-1) !== view.state) states.push(view.state)
    if (view.state === 'done' || view.state === 'failed') return { states, last: view }
    clock += TICK_MS
  }
  throw new Error('the run did not end')
}

/** Reads what is left of a visitor's day. */
async function runsLeft(visitor = ANNA): Promise<number> {
  return lb07LimitsViewSchema.parse((await call('GET', '/limits', visitor)).json).runs.remaining
}

describe('a curated sample', () => {
  it('goes from the planner to the report through every state, with the findings the bug makes and the verdict kept', async () => {
    const run = await startSample('coupon-double-discount')
    expect(run.queuePosition).toBe(null)
    expect(run.origin).toBe('sample')
    const { states, last } = await follow(run.id)

    expect(states).toEqual(['planning', 'running', 'cross_checking', 'reporting', 'verifying', 'done'])
    expect(last.modelCalls).toBe(2)
    expect(last.steps.every(step => step.durationMs !== null && step.plan === 0)).toBe(true)
    expect(last.steps.find(step => step.step.action === 'expectText' && step.step.text === 'Total €26.10')?.status).toBe('finding')
    const report = lb07ReportSchema.parse((await call('GET', `/runs/${run.id}/report`)).json)
    expect(report.verification.verdict).toBe('kept')
    expect(report.verification.red?.findings).toBeGreaterThan(0)
    expect(report.verification.green).toMatchObject({ bugsOn: false, stepsPassed: true, findings: 0 })
    expect(report.findings).toEqual([expect.objectContaining({ id: 'f1', kind: 'expectation_failed', path: '/cart', engine: 'chromium', evidenceIds: ['e1'] })])
    expect(report.findings[0]?.detail).toContain('Total')
    expect(report.reports).toEqual([expect.objectContaining({ findingIds: ['f1'], severity: 'high' })])
    expect(report.engines).toEqual(['chromium', 'firefox-ua'])
    expect(mock.violations).toEqual([])
  })

  it('answers the generated test written by the service\'s own template from the plan that ran, and keeps it', async () => {
    const run = await startSample('coupon-double-discount')
    await follow(run.id)
    const test = lb07TestViewSchema.parse((await call('GET', `/runs/${run.id}/test`)).json)
    const sample = seed.samples.find(entry => entry.id === 'coupon-double-discount')
    expect(test.verdict).toBe('kept')
    expect(test.filename).toBe('buy-two-bags-of-ethiopia-guji-with-the-c.spec.ts')
    expect(test.source).toBe(generateTest({ goal: sample?.goal ?? '', steps: sample?.plan ?? [], shopOrigin: 'http://127.0.0.1:8007' }))
  })

  it('hands out a valid PNG for each screenshot, the page\'s tree as text, and nothing it has not made yet', async () => {
    const run = await startSample('coupon-double-discount')
    expect((await call('GET', `/runs/${run.id}/evidence/e1`)).status).toBe(404)
    await follow(run.id)
    const shot = lb07EvidenceViewSchema.parse((await call('GET', `/runs/${run.id}/evidence/e1`)).json)
    expect(shot.kind).toBe('screenshot')
    const bytes = Buffer.from(shot.kind === 'screenshot' ? shot.base64 : '', 'base64')
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    expect(bytes.length).toBeLessThan(2_000)
    expect(shot.stepIndex).toBe(8)
    const closing = lb07EvidenceViewSchema.parse((await call('GET', `/runs/${run.id}/evidence/e2`)).json)
    expect(closing).toMatchObject({ kind: 'screenshot', stepIndex: null })
    const tree = lb07EvidenceViewSchema.parse((await call('GET', `/runs/${run.id}/evidence/e3`)).json)
    expect(tree.kind === 'snapshot' ? tree.text : '').toContain('- heading "Your cart" [level=1]')
    expect((await call('GET', `/runs/${run.id}/evidence/e4`)).status).toBe(404)
  })

  it('writes a trace of metadata as the run goes, with the root span last', async () => {
    const run = await startSample('coupon-double-discount')
    expect(mock.lb07.spansOf(run.id)).toBeUndefined()
    clock += TICK_MS * 3
    const early = mock.lb07.spansOf(run.id) ?? []
    expect(early.map(span => span.name)).toContain('plan the test')
    expect(early.some(span => span.kind === 'system.run')).toBe(false)
    await follow(run.id)
    const spans = mock.lb07.spansOf(run.id) ?? []
    for (const span of spans) spanSchema.parse(span)
    expect(spans.at(-1)).toMatchObject({ kind: 'system.run', name: 'qa run', status: 'ok' })
    expect(spans.filter(span => span.kind === 'gateway.call')).toHaveLength(2)
    expect(JSON.stringify(spans)).not.toContain('Ethiopia')
  })

  it('plans the re-plan sample wrong once and puts it right with one re-plan, the new steps marked with the second plan', async () => {
    const run = await startSample(MOCK_REPLAN_SAMPLE)
    const { states, last } = await follow(run.id)
    expect(states).toContain('replanning')
    expect(last.replans).toBe(1)
    expect(last.modelCalls).toBe(3)
    const failed = last.steps.find(step => step.status === 'failed')
    expect(failed).toMatchObject({ plan: 0, outcome: 'not_found', step: { action: 'click', name: 'Add to basket' } })
    expect(last.steps.filter(step => step.plan === 1).map(step => step.step.action)).toEqual(['click', 'expectText', 'expectText'])
    const report = lb07ReportSchema.parse((await call('GET', `/runs/${run.id}/report`)).json)
    expect(report.verification.verdict).toBe('kept')
  })

  it('comes to the verdict the golden set expects for every case, sample or not', async () => {
    for (const entry of seed.golden) {
      mock.reset()
      const body = entry.sample ? { from: 'sample', sampleId: entry.id } : { from: 'custom', goal: entry.goal, bugs: entry.bugs }
      const started = lb07RunViewSchema.parse((await call('POST', '/runs', ANNA, body)).json)
      const { last } = await follow(started.id)
      expect(last.state, entry.id).toBe('done')
      const report = lb07ReportSchema.parse((await call('GET', `/runs/${started.id}/report`)).json)
      expect(report.verification.verdict, entry.id).toBe(entry.expect.verdict)
      expect(report.modelCalls, entry.id).toBeLessThanOrEqual(8)
    }
    expect(mock.violations).toEqual([])
  })

  it('stops a link out of the shop at the sandbox, skips the rest of the plan and proves nothing', async () => {
    const run = await startSample('partner-link')
    const { states, last } = await follow(run.id)
    expect(states).not.toContain('cross_checking')
    expect(last.steps.map(step => step.status)).toEqual(['passed', 'blocked', 'skipped'])
    const report = lb07ReportSchema.parse((await call('GET', `/runs/${run.id}/report`)).json)
    expect(report.findings).toEqual([expect.objectContaining({ kind: 'blocked_navigation', path: null })])
    expect(report.reports).toEqual([])
    expect(report.verification).toEqual({ verdict: 'not_verified', red: null, cross: null, green: null })
  })
})

describe('a goal of the visitor\'s own', () => {
  it('is guarded while the run still says it is queued, planned by rules from its words, and run to a verdict', async () => {
    const goal = 'Buy two bags of Brazil Cerrado and check the cart says 2 items and the right total.'
    const started = await call('POST', '/runs', ANNA, { from: 'custom', goal, bugs: [] })
    expect(started.status).toBe(201)
    const run = lb07RunViewSchema.parse(started.json)
    expect(run).toMatchObject({ origin: 'custom', sampleId: null, goal, state: 'queued', queuePosition: 0 })
    const { states, last } = await follow(run.id)
    expect(states[0]).toBe('queued')
    expect(last.reading).toContain('add 2 bags')
    expect(last.steps.map(step => step.step)).toContainEqual({ action: 'expectText', text: 'Total €21.80' })
    const report = lb07ReportSchema.parse((await call('GET', `/runs/${run.id}/report`)).json)
    expect(report.verification.verdict).toBe('passing')
    expect(report.modelCalls).toBe(2)
  })

  it('is refused before anything runs when it has a control character, as the service refuses it', async () => {
    const answer = await call('POST', '/runs', ANNA, { from: 'custom', goal: 'Buy a bag\u0007 of coffee', bugs: [] })
    expect(answer.status).toBe(422)
    expect(await runsLeft()).toBe(2)
  })
})

describe('the queue', () => {
  it('says how many runs are ahead and counts down, then starts the run', async () => {
    mock.lb07.occupy(2, 1_000)
    const run = await startSample('cart-count')
    expect(run).toMatchObject({ state: 'queued', queuePosition: 2, startedAt: null })
    clock += 1_000
    expect(await read(run.id)).toMatchObject({ state: 'queued', queuePosition: 1 })
    clock += 1_000
    const started = await read(run.id)
    expect(started.state).toBe('planning')
    expect(started.queuePosition).toBe(null)
    expect(started.startedAt).not.toBe(null)
  })

  it('tells the fifth visitor the browser is busy, takes nothing from their day, and lets them in once a run is over', async () => {
    mock.lb07.occupy(4, 2_000)
    const refused = await call('POST', '/runs', ANNA, { from: 'sample', sampleId: 'cart-count' })
    expect(refused.status).toBe(503)
    expect(refused.json).toMatchObject({ error: { code: 'busy' } })
    expect(refused.headers.get('retry-after')).toBe('60')
    expect(await runsLeft()).toBe(2)
    clock += 2_000
    expect((await call('POST', '/runs', ANNA, { from: 'sample', sampleId: 'cart-count' })).status).toBe(201)
  })
})

describe('the visitor\'s day', () => {
  it('allows two runs, counts a sample, and refuses the third with when the day starts again', async () => {
    await startSample('cart-count')
    expect(await runsLeft()).toBe(1)
    clock += 60_000
    await call('POST', '/runs', ANNA, { from: 'custom', goal: 'Open the shop front.', bugs: [] })
    clock += 60_000
    const third = await call('POST', '/runs', ANNA, { from: 'sample', sampleId: 'cart-count' })
    expect(third.status).toBe(429)
    expect(third.json).toMatchObject({ error: { code: 'daily_limit', resets_at: '2026-10-06T00:00:00.000Z' } })
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(40_000)
    expect(await runsLeft(BORIS)).toBe(2)
    clock = Date.parse('2026-10-06T00:00:01.000Z')
    expect(await runsLeft()).toBe(2)
  })

  it('lists the visitor\'s runs of the hour, newest first, and no one else\'s', async () => {
    const first = await startSample('cart-count')
    clock += 1_000
    const second = await startSample('pictures-have-alt-text')
    await startSample('hostile-goal', BORIS)
    const listed = (await call('GET', '/runs')).json as Lb07RunView[]
    expect(listed.map(run => run.id)).toEqual([second.id, first.id])
    clock += 3_600_000
    expect((await call('GET', '/runs')).json).toEqual([])
    expect((await call('GET', `/runs/${first.id}`)).status).toBe(404)
  })
})

describe('a run that fails', () => {
  it('gives the day\'s run back exactly for the failures the service gives back', () => {
    expect([...LB07_GIVEN_BACK].sort()).toEqual([...REFUNDED].sort())
  })

  for (const code of LB07_FAILURE_CODES) {
    it(`ends with ${code} where the service would, and ${LB07_GIVEN_BACK.has(code) ? 'gives the run back' : 'keeps the run spent'}`, async () => {
      const goal = `Check the shop front for ${code.replaceAll('_', ' ')}.`
      mock.lb07.failNext(code, goal)
      const started = await call('POST', '/runs', ANNA, { from: 'custom', goal, bugs: ['missing-alt'] })
      const run = lb07RunViewSchema.parse(started.json)
      const { last } = await follow(run.id)
      expect(last.state).toBe('failed')
      expect(last.failure?.code).toBe(code)
      expect(last.endedAt).not.toBe(null)
      expect(await runsLeft()).toBe(LB07_GIVEN_BACK.has(code) ? 2 : 1)
      expect((await call('GET', `/runs/${run.id}/report`)).json).toMatchObject({ error: { code: 'run_failed' } })
      expect((await call('GET', `/runs/${run.id}/test`)).status).toBe(409)
      expect(mock.lb07.spansOf(run.id)?.at(-1)).toMatchObject({ kind: 'system.run', status: 'error', attrs: { outcome: code } })
    })
  }

  it('makes the failure a test asks for only on the run with that goal', async () => {
    mock.lb07.failNext('planning_unavailable', 'A goal nobody sends.')
    const run = await startSample('cart-count')
    expect((await follow(run.id)).last.state).toBe('done')
  })
})

describe('what the service refuses', () => {
  it('answers 404 for a sample there is not, and takes nothing for it', async () => {
    const answer = await call('POST', '/runs', ANNA, { from: 'sample', sampleId: 'no-such-sample' })
    expect(answer.status).toBe(404)
    expect(answer.json).toMatchObject({ error: { code: 'unknown_sample' } })
    expect(await runsLeft()).toBe(2)
  })

  it('hides a run from everyone but its visitor', async () => {
    const run = await startSample('cart-count')
    await follow(run.id)
    for (const path of [`/runs/${run.id}`, `/runs/${run.id}/report`, `/runs/${run.id}/test`, `/runs/${run.id}/evidence/e1`]) {
      const answer = await call('GET', path, BORIS)
      expect(answer.status, path).toBe(404)
      expect(answer.json).toMatchObject({ error: { code: 'run_not_found' } })
    }
    expect((await call('DELETE', `/runs/${run.id}`, BORIS)).status).toBe(404)
  })

  it('says the report and the test are not ready while the run goes', async () => {
    const run = await startSample('cart-count')
    clock += TICK_MS * 3
    expect((await call('GET', `/runs/${run.id}/report`)).json).toMatchObject({ error: { code: 'not_ready' } })
    expect((await call('GET', `/runs/${run.id}/test`)).status).toBe(409)
  })

  it('deletes a run at once on request, without giving back the day\'s run', async () => {
    const run = await startSample('cart-count')
    await follow(run.id)
    expect((await call('DELETE', `/runs/${run.id}`)).status).toBe(204)
    expect((await call('GET', `/runs/${run.id}`)).status).toBe(404)
    expect((await call('DELETE', `/runs/${run.id}`)).status).toBe(404)
    expect(await runsLeft()).toBe(1)
  })
})

describe('the controls', () => {
  it('take a failure for the next run with a goal over HTTP, and refuse what is not JSON', async () => {
    const goal = 'Open the shop front and check it.'
    const set = await fetch(`${mock.url}/__mock/lb07/fail`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'run_timeout', goal }) })
    expect(set.status).toBe(200)
    expect((await fetch(`${mock.url}/__mock/lb07/fail`, { method: 'POST', body: 'code=x' })).status).toBe(415)
    expect((await fetch(`${mock.url}/__mock/lb07/fail`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'nonsense' }) })).status).toBe(422)
    const run = lb07RunViewSchema.parse((await call('POST', '/runs', ANNA, { from: 'custom', goal, bugs: [] })).json)
    expect((await follow(run.id)).last.failure?.code).toBe('run_timeout' satisfies Lb07FailureCode)
  })
})
