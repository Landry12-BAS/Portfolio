// LB-07's engine on a real Postgres with a queue driven by hand, a scripted runner and a scripted model:
// a run from its start to its report, the states a visitor sees, the daily allowance and the busy
// state, a retry that keeps the plan and runs the browser again, the failures and what each gives back,
// the sweep, and the trace.
import { randomBytes } from 'node:crypto'

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'

import { startRun } from '../../src/modules/lb07/engine/service.ts'
import { readEvidenceView, readReportView, readRunView, readTestView } from '../../src/modules/lb07/engine/store.ts'
import { sweep } from '../../src/modules/lb07/engine/sweep.ts'
import { limitsOf } from '../../src/modules/lb07/engine/usage.ts'
import type { GoldenCase } from '../../src/modules/lb07/golden/cases.ts'
import { RunnerError } from '../../src/modules/lb07/runner/client.ts'
import { ScriptedModel } from '../support/fake-model.ts'
import { loadGolden } from '../support/lb07.ts'
import { createLb07Harness, drive, referenceModel, VISITOR_B } from '../support/lb07-engine.ts'
import type { Lb07Harness } from '../support/lb07-engine.ts'
import { bugScript } from '../support/lb07-fake-runner.ts'

let harness: Lb07Harness
const golden = loadGolden()
const coupon = golden.find(entry => entry.id === 'coupon-double-discount') as GoldenCase
const clean = golden.find(entry => entry.id === 'clean-shop') as GoldenCase

beforeAll(async () => {
  harness = await createLb07Harness(inject('databaseUrl'))
})

afterAll(() => harness.close())

beforeEach(() => {
  harness.clock.set('2026-10-02T09:00:00.000Z')
  harness.runner.script = bugScript(coupon.bugs)
  harness.models.current = referenceModel(coupon)
})

/** A visitor session of its own. */
function newSession(): string {
  return `session-${randomBytes(8).toString('hex')}`
}

describe('a run from a sample', () => {
  it('is queued at once, moves through its states, and ends done with its report, its test and its evidence kept for the hour', async () => {
    const session = newSession()
    const queued = await startRun(harness.deps, session, { from: 'sample', sampleId: coupon.id })
    expect(queued).toMatchObject({ state: 'queued', queuePosition: 0, origin: 'sample', sampleId: coupon.id, bugs: ['coupon-twice'], steps: [] })
    expect(harness.scheduler.jobs).toEqual([queued.id])
    await drive(harness)
    const view = await readRunView(harness.deps.db, session, queued.id, harness.clock.now())
    expect(view).toMatchObject({ state: 'done', failure: null, queuePosition: null, modelCalls: 2, replans: 0, findings: 1 })
    expect(view?.reading).toContain('Checking')
    expect(view?.steps.map(step => step.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'finding'])
    const report = await readReportView(harness.deps.db, session, queued.id, harness.clock.now())
    expect(report.verification.verdict).toBe('kept')
    expect(report.findings[0]).toMatchObject({ id: 'f1', kind: 'expectation_failed', evidenceIds: ['e1'] })
    expect(report.reports).toHaveLength(1)
    expect(report.engines).toEqual(['chromium', 'firefox-ua'])
    const test = await readTestView(harness.deps.db, session, queued.id, harness.clock.now())
    expect(test.verdict).toBe('kept')
    expect(test.source).toContain('getByLabel("Coupon code"')
    const evidence = await readEvidenceView(harness.deps.db, session, queued.id, 'e1', harness.clock.now())
    expect(evidence).toMatchObject({ kind: 'screenshot', contentType: 'image/png' })
    expect(await readRunView(harness.deps.db, VISITOR_B, queued.id, harness.clock.now())).toBeUndefined()
    expect((await limitsOf(harness.deps.db, session, harness.clock.now())).runs).toEqual({ limit: 2, used: 1, remaining: 1 })
    expect(harness.runner.sessions.filter(entry => !entry.closed)).toEqual([])
  })

  it('does nothing when its job runs twice, and nothing for a run that expired while it waited', async () => {
    const session = newSession()
    const run = await startRun(harness.deps, session, { from: 'sample', sampleId: clean.id })
    harness.models.current = referenceModel(clean)
    await drive(harness)
    const before = harness.models.current.conversations.length
    harness.scheduler.jobs.push(run.id)
    await drive(harness)
    expect(harness.models.current.conversations).toHaveLength(before)
    const late = await startRun(harness.deps, newSession(), { from: 'sample', sampleId: clean.id })
    harness.clock.advance(61 * 60_000)
    await drive(harness)
    expect(harness.models.current.conversations).toHaveLength(before)
    expect(await readRunView(harness.deps.db, session, late.id, harness.clock.now())).toBeUndefined()
    // The sweep removes it, as it would on the box; the clock then goes back for the next test.
    expect((await sweep(harness.deps)).deleted).toBeGreaterThanOrEqual(1)
  })
})

describe('the allowances', () => {
  it('gives a visitor two runs a day, refuses the third with 429 and the day\'s reset, and starts again at midnight', async () => {
    const session = newSession()
    await startRun(harness.deps, session, { from: 'sample', sampleId: clean.id })
    await startRun(harness.deps, session, { from: 'custom', goal: 'Buy one bag.', bugs: [] })
    await expect(startRun(harness.deps, session, { from: 'custom', goal: 'Buy one bag.', bugs: [] })).rejects.toMatchObject({ status: 429, code: 'daily_limit', details: { resetsAt: '2026-10-03T00:00:00.000Z' } })
    await drive(harness)
    harness.clock.set('2026-10-03T00:00:01.000Z')
    expect((await limitsOf(harness.deps.db, session, harness.clock.now())).runs.remaining).toBe(2)
  })

  it('says busy, taking no place, when the queue is full, and refuses an unknown sample', async () => {
    const sessions = Array.from({ length: 4 }, newSession)
    for (const session of sessions) await startRun(harness.deps, session, { from: 'sample', sampleId: clean.id })
    const late = newSession()
    await expect(startRun(harness.deps, late, { from: 'sample', sampleId: clean.id })).rejects.toMatchObject({ status: 503, code: 'busy' })
    expect((await limitsOf(harness.deps.db, late, harness.clock.now())).runs.used).toBe(0)
    harness.models.current = referenceModel(clean)
    await drive(harness)
    await expect(startRun(harness.deps, late, { from: 'sample', sampleId: 'nothing' })).rejects.toMatchObject({ status: 404, code: 'unknown_sample' })
  })

  it('gives the place back when the job cannot be queued, and when the run fails through the system', async () => {
    const session = newSession()
    harness.scheduler.failNextEnqueue(new Error('redis is down'))
    await expect(startRun(harness.deps, session, { from: 'sample', sampleId: clean.id })).rejects.toMatchObject({ status: 503, code: 'queue_unavailable' })
    expect((await limitsOf(harness.deps.db, session, harness.clock.now())).runs.used).toBe(0)
  })
})

describe('a run that is retried', () => {
  it('keeps the plan it paid for, runs the browser passes again, and ends done on the second attempt', async () => {
    const session = newSession()
    harness.runner.openFailures.push(new RunnerError('unreachable', 'down'))
    const run = await startRun(harness.deps, session, { from: 'sample', sampleId: coupon.id })
    await drive(harness)
    const view = await readRunView(harness.deps.db, session, run.id, harness.clock.now())
    expect(view?.state).toBe('done')
    // The plan was asked once; the second attempt resumed it.
    expect(harness.models.current.conversations.filter(conversation => conversation[0]?.content.startsWith('You are a QA engineer writing a browser test'))).toHaveLength(1)
    expect(view?.modelCalls).toBe(2)
  })

  it('fails as runner_unavailable after its attempts when the browser never answers, and gives the place back', async () => {
    const session = newSession()
    for (let index = 0; index < 4; index += 1) harness.runner.openFailures.push(new RunnerError('unreachable', 'down'))
    const run = await startRun(harness.deps, session, { from: 'sample', sampleId: coupon.id })
    await drive(harness)
    expect(await readRunView(harness.deps.db, session, run.id, harness.clock.now())).toMatchObject({ state: 'failed', failure: { code: 'runner_unavailable' } })
    expect((await limitsOf(harness.deps.db, session, harness.clock.now())).runs.used).toBe(0)
    harness.runner.openFailures.length = 0
  })

  it('fails as plan_invalid, once, when the model never writes a plan the schema accepts, and gives the place back', async () => {
    const session = newSession()
    harness.models.current = new ScriptedModel(() => ({ kind: 'json', value: { steps: 'no' } }))
    const run = await startRun(harness.deps, session, { from: 'sample', sampleId: coupon.id })
    await drive(harness)
    expect(await readRunView(harness.deps.db, session, run.id, harness.clock.now())).toMatchObject({ state: 'failed', failure: { code: 'plan_invalid' }, modelCalls: 0 })
    expect(harness.models.current.conversations).toHaveLength(2)
    expect((await limitsOf(harness.deps.db, session, harness.clock.now())).runs.used).toBe(0)
  })

  it('fails as run_timeout, keeping the place, when the browser says the session expired', async () => {
    const session = newSession()
    harness.runner.script = () => {
      throw new RunnerError('expired', 'expired')
    }
    const run = await startRun(harness.deps, session, { from: 'sample', sampleId: coupon.id })
    await drive(harness)
    expect(await readRunView(harness.deps.db, session, run.id, harness.clock.now())).toMatchObject({ state: 'failed', failure: { code: 'run_timeout' } })
    expect((await limitsOf(harness.deps.db, session, harness.clock.now())).runs.used).toBe(1)
  })
})

describe('the sweep', () => {
  it('deletes runs past their hour, queues again a run that lost its worker, and removes old counters', async () => {
    const session = newSession()
    const stale = await startRun(harness.deps, session, { from: 'sample', sampleId: clean.id })
    harness.scheduler.jobs.length = 0
    harness.clock.advance(2 * 60_000)
    const first = await sweep(harness.deps)
    expect(first.requeued).toBe(1)
    expect(harness.scheduler.requeued).toContain(stale.id)
    harness.models.current = referenceModel(clean)
    await drive(harness)
    harness.clock.advance(61 * 60_000)
    const second = await sweep(harness.deps)
    expect(second.deleted).toBeGreaterThanOrEqual(1)
    expect(await readRunView(harness.deps.db, session, stale.id, harness.clock.now())).toBeUndefined()
    harness.clock.advance(3 * 86_400_000)
    expect((await sweep(harness.deps)).counters).toBeGreaterThan(0)
  })
})

describe('the trace of a run', () => {
  it('is one tree: the root written once when the run ends, every step and model call under it, counts and labels only and never the goal', async () => {
    harness.recorder.spans.length = 0
    const session = newSession()
    const run = await startRun(harness.deps, session, { from: 'custom', goal: 'Buy two bags of Ethiopia Guji with WELCOME10 and check Total €26.10 and 2 items.', bugs: ['coupon-twice'] })
    await drive(harness)
    const spans = harness.recorder.spans.filter(span => span.runId === run.id)
    const roots = spans.filter(span => span.kind === 'system.run')
    expect(roots).toHaveLength(1)
    expect(roots[0]).toMatchObject({ name: 'qa run', status: 'ok', attrs: { outcome: 'done', origin: 'custom', bugs_on: 1 } })
    // Every other span hangs from the root, directly or through the span of the pass it ran in.
    const ids = new Set(spans.map(span => span.spanId))
    expect(roots[0]?.parentId).toBeUndefined()
    for (const span of spans.filter(span => span.kind !== 'system.run')) expect(span.parentId !== undefined && ids.has(span.parentId)).toBe(true)
    expect(spans.filter(span => span.parentId === roots[0]?.spanId).length).toBeGreaterThan(3)
    expect(spans.map(span => span.name)).toContain('guard the goal')
    expect(spans.map(span => span.name)).toContain('plan the test')
    const text = JSON.stringify(spans)
    expect(text).not.toContain('Ethiopia')
    expect(text).not.toContain('WELCOME10')
    expect(text).not.toContain(session)
  })
})
