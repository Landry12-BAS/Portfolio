// LB-04's review engine on a real Postgres, driven by hand: each golden case through the real
// extraction, the real pipeline and the real tables, with scripted models that answer as a correct
// reviewer would; what each way of failing does to a contract, its visitor's place and its saved work;
// retries that resume without paying again; and the trace a review leaves. The queue itself, with real
// waits, is tested in lb04-queue.test.ts.
import { GatewayCallError } from '@lb/common'
import type { Lb04State } from '@lb/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'

import type { JsonModel, ReviewModels } from '../../src/modules/lb04/analysis/model.ts'
import type { Guard } from '../../src/modules/lb04/analysis/pipeline.ts'
import { casePassed, gradeRefusal, gradeReport } from '../../src/modules/lb04/golden/grade.ts'
import { reviewJob } from '../../src/modules/lb04/engine/job.ts'
import { startContract } from '../../src/modules/lb04/engine/service.ts'
import { readContractView, readPagesView, readReportView } from '../../src/modules/lb04/engine/store.ts'
import { rootSpanIdOf } from '../../src/modules/lb04/engine/trace.ts'
import { ScriptedModel } from '../support/fake-model.ts'
import { drive, createLb04Harness, referenceReview, VISITOR_A } from '../support/lb04-engine.ts'
import type { Lb04Harness } from '../support/lb04-engine.ts'
import { extractedPages, loadGoldenSet } from '../support/lb04.ts'

let harness: Lb04Harness

beforeAll(async () => {
  harness = await createLb04Harness(inject('databaseUrl'))
})

afterAll(async () => {
  await harness.close()
})

beforeEach(async () => {
  harness.clock.set('2026-10-02T09:00:00.000Z')
  await harness.query('DELETE FROM lb04.contracts')
  await harness.query('DELETE FROM lb04.usage_counters')
  harness.scheduler.jobs.length = 0
  harness.scheduler.added.length = 0
  harness.retries.length = 0
  harness.spans.spans.length = 0
})

/** Starts a review of a sample as the first visitor, with the reference models for it, and returns the contract's id. */
async function startReference(sampleId: string): Promise<{ id: string, scripts: ReturnType<typeof referenceReview>['scripts'] }> {
  const { review, scripts } = referenceReview(sampleId)
  harness.deps.review = review
  const view = await startContract(harness.deps, VISITOR_A, { from: 'sample', sampleId })
  return { id: view.id, scripts }
}

/** A guard that finds nothing to flag. */
const QUIET_GUARD: Guard = { check: async () => ({ flagged: false, score: 0.01 }) }

/** A guard that flags nothing and counts how often it was asked. */
function countingGuard(): { guard: Guard, asked: { count: number } } {
  const asked = { count: 0 }
  const guard: Guard = {
    check: async () => {
      asked.count += 1
      return { flagged: false, score: 0.01 }
    },
  }
  return { guard, asked }
}

/** Starts a review of a sample with models (and a guard) of the test's own making. */
async function startWith(sampleId: string, models: ReviewModels, guard: Guard | undefined = QUIET_GUARD): Promise<string> {
  harness.deps.review = { models, guard }
  return (await startContract(harness.deps, VISITOR_A, { from: 'sample', sampleId })).id
}

/** What a visitor sees of a contract. */
async function viewOf(id: string) {
  const view = await readContractView(harness.deps.db, VISITOR_A, id, harness.clock.now())
  if (!view) throw new Error('The contract is gone.')
  return view
}

/** How many places of today's allowance the first visitor has used. */
async function placesUsed(): Promise<number> {
  const rows = await harness.query(`SELECT used FROM lb04.usage_counters WHERE session_key = $1 AND kind = 'contract'`, [VISITOR_A])
  return Number(rows[0]?.used ?? 0)
}

/** A model that throws the gateway's error every time it is asked. */
function failing(code: GatewayCallError['code'], status: number | undefined, retryAfter?: number): ScriptedModel {
  return new ScriptedModel(() => {
    throw new GatewayCallError(code, status, retryAfter)
  })
}

/** A model that gives an answer that is not an object at all, so it fails its schema however often it is asked. */
function nonsense(): ScriptedModel {
  return new ScriptedModel(() => ({ kind: 'text', text: 'I am unable to help with that.' }))
}

/** Models for a test that fails at one of the three, with the reference's answers for the others. */
function withModel(sampleId: string, which: keyof ReviewModels, replacement: JsonModel): ReviewModels {
  const { scripts } = referenceReview(sampleId)
  return { ...scripts.models, [which]: replacement }
}

describe('each golden case, through the real engine', () => {
  it.each(loadGoldenSet().cases.filter(entry => entry.kind === 'report').map(entry => [entry.contract]))('reviews %s to a report that passes its golden case', async (sampleId) => {
    const entry = loadGoldenSet().cases.find(candidate => candidate.contract === sampleId)
    if (entry?.kind !== 'report') throw new Error('Not a report case.')
    const { id } = await startReference(sampleId)

    await drive(harness)

    const view = await viewOf(id)
    expect(view.state).toBe('done')
    const report = await readReportView(harness.deps.db, VISITOR_A, id, harness.clock.now())
    const grade = gradeReport(entry, report, await extractedPages(sampleId))
    expect(grade.failures, grade.failures.join('; ')).toEqual([])
    expect(casePassed(grade)).toBe(true)
    expect(report.calls).toBeLessThanOrEqual(5)
    expect(report.notLegalAdvice).toBe('Not legal advice')
  })

  it.each(loadGoldenSet().cases.filter(entry => entry.kind === 'refused').map(entry => [entry.contract]))('refuses %s as its golden case says, and asks no model', async (sampleId) => {
    const entry = loadGoldenSet().cases.find(candidate => candidate.contract === sampleId)
    if (entry?.kind !== 'refused') throw new Error('Not a refusal case.')
    const asked: string[] = []
    const watcher = new ScriptedModel(() => {
      asked.push('asked')
      throw new Error('A refused file must not reach a model.')
    })
    const id = await startWith(sampleId, { long: watcher, reason: watcher, fast: watcher })

    await drive(harness)

    const view = await viewOf(id)
    expect(view.state).toBe('failed')
    const grade = gradeRefusal(entry, view.failure?.code, 0)
    expect(grade.failures, grade.failures.join('; ')).toEqual([])
    expect(asked).toEqual([])
  })
})

describe('a reviewed contract', () => {
  it('shows the visitor its states in order, and ends done with its text, its file and its report kept for the hour', async () => {
    const seen: [string, Lb04State][] = []
    const { scripts } = referenceReview('wholesale-supply')
    const observing = (label: string, model: JsonModel): JsonModel => ({
      ask: async (messages) => {
        const rows = await harness.query('SELECT state FROM lb04.contracts')
        seen.push([label, rows[0]?.state as Lb04State])
        return model.ask(messages)
      },
    })
    const id = await startWith('wholesale-supply', { long: observing('long', scripts.long), reason: observing('reason', scripts.reason), fast: scripts.fast })
    expect((await viewOf(id)).state).toBe('queued')

    await drive(harness)

    expect(seen).toEqual([['long', 'analysing'], ['reason', 'verifying']])
    const view = await viewOf(id)
    expect(view).toMatchObject({ state: 'done', pages: 11, failure: null, origin: 'sample', sampleId: 'wholesale-supply', redlinesLeft: 3, notLegalAdvice: 'Not legal advice' })
    expect(Date.parse(view.expiresAt) - Date.parse(view.createdAt)).toBe(60 * 60_000)
    const pages = await readPagesView(harness.deps.db, VISITOR_A, id, harness.clock.now())
    expect(pages.pages).toHaveLength(11)
    const stored = await harness.query(`SELECT (SELECT count(*) FROM lb04.contract_files)::int AS files, (SELECT count(*) FROM lb04.reports)::int AS reports, (SELECT working IS NULL FROM lb04.contracts) AS clean`)
    expect(stored[0]).toEqual({ files: 1, reports: 1, clean: true })
    expect(await placesUsed()).toBe(1)
  })

  it('asks the guard, the long model and the rating model once each for a contract that answers well, and counts those calls', async () => {
    const { id, scripts } = await startReference('wholesale-supply')

    await drive(harness)

    expect(scripts.long.conversations).toHaveLength(1)
    expect(scripts.reason.conversations).toHaveLength(1)
    expect(scripts.fast.conversations).toHaveLength(0)
    const report = await readReportView(harness.deps.db, VISITOR_A, id, harness.clock.now())
    expect(report.calls).toBe(3)
    const rows = await harness.query('SELECT model_calls, attempts FROM lb04.contracts')
    expect(rows[0]).toEqual({ model_calls: 3, attempts: 1 })
  })

  it('needs only two calls for a contract with nothing to rate: the guard and the reading', async () => {
    const { id, scripts } = await startReference('clean-supply')

    await drive(harness)

    expect(scripts.reason.conversations).toHaveLength(0)
    expect((await readReportView(harness.deps.db, VISITOR_A, id, harness.clock.now())).calls).toBe(2)
  })

  it('is not done twice: a second run of the same job asks no model and changes nothing', async () => {
    const { id, scripts } = await startReference('wholesale-supply')
    await drive(harness)
    const before = await harness.query('SELECT updated_at, attempts FROM lb04.contracts')

    await reviewJob(harness.deps, id, { number: 1, last: false })

    expect(scripts.long.conversations).toHaveLength(1)
    expect(await harness.query('SELECT updated_at, attempts FROM lb04.contracts')).toEqual(before)
  })

  it('does nothing for a contract that expired or was deleted while it waited', async () => {
    const { id, scripts } = await startReference('wholesale-supply')
    harness.clock.advance(61 * 60_000)

    await drive(harness)

    expect(scripts.long.conversations).toHaveLength(0)
    expect(await readContractView(harness.deps.db, VISITOR_A, id, harness.clock.now())).toBeUndefined()
  })
})

describe('a review that is retried', () => {
  it('resumes where it stopped: the guard\'s verdict and the reading are kept, and only the rating is asked again', async () => {
    const { scripts } = referenceReview('wholesale-supply')
    let attempts = 0
    const flaky = new ScriptedModel((messages, call) => {
      attempts += 1
      if (call === 1) throw new GatewayCallError('upstream_failed', 502, 7)
      return scripts.reason.ask(messages)
    })
    const { guard, asked } = countingGuard()
    const id = await startWith('wholesale-supply', { long: scripts.long, reason: flaky, fast: scripts.fast }, guard)

    const runs = await drive(harness)

    expect(runs).toBe(2)
    expect(harness.retries).toEqual([7])
    expect(attempts).toBe(2)
    expect(scripts.long.conversations).toHaveLength(1)
    expect(asked.count).toBe(1)
    const view = await viewOf(id)
    expect(view.state).toBe('done')
    const report = await readReportView(harness.deps.db, VISITOR_A, id, harness.clock.now())
    expect(report.calls).toBe(3)
  })

  it.each([
    ['the model is out of quota', 'quota_exceeded', 429],
    ['every model is out of budget', 'budget_exhausted', 503],
    ['the provider refused the request', 'upstream_rejected', 502],
  ] as const)('is not retried when %s: the contract fails at once with the model unavailable, and the visitor\'s place comes back', async (_what, code, status) => {
    const long = failing(code, status)
    const id = await startWith('wholesale-supply', withModel('wholesale-supply', 'long', long))

    const runs = await drive(harness)

    expect(runs).toBe(1)
    expect(long.conversations).toHaveLength(1)
    expect(await viewOf(id)).toMatchObject({ state: 'failed', failure: { code: 'analysis_unavailable' } })
    expect(await placesUsed()).toBe(0)
  })

  it.each([
    ['this service may not make calls for the system', 'system_not_allowed', 403],
    ['the prompt is too long for the alias', 'input_too_large', 413],
    ['the service token is refused', 'invalid_service_token', 401],
  ] as const)('is not retried when %s: it is this deploy\'s fault and no visitor\'s, so the contract fails as internal', async (_what, code, status) => {
    const long = failing(code, status)
    const id = await startWith('wholesale-supply', withModel('wholesale-supply', 'long', long))

    const runs = await drive(harness)

    expect(runs).toBe(1)
    expect(await viewOf(id)).toMatchObject({ state: 'failed', failure: { code: 'internal' } })
    expect(await placesUsed()).toBe(0)
  })

  it('is tried three times when the provider keeps failing, then fails as unavailable and gives the place back; the guard was asked once', async () => {
    const long = failing('upstream_failed', 502, 3)
    const { guard, asked } = countingGuard()
    const id = await startWith('wholesale-supply', withModel('wholesale-supply', 'long', long), guard)

    const runs = await drive(harness)

    expect(runs).toBe(3)
    expect(harness.retries).toEqual([3, 3])
    expect(long.conversations).toHaveLength(3)
    expect(asked.count).toBe(1)
    const view = await viewOf(id)
    expect(view).toMatchObject({ state: 'failed', failure: { code: 'analysis_unavailable' } })
    expect(await placesUsed()).toBe(0)
    // Nothing the visitor sent is kept for a failed review.
    const kept = await harness.query('SELECT (SELECT count(*) FROM lb04.contract_files)::int AS files, (SELECT count(*) FROM lb04.contract_pages)::int AS pages, (SELECT working IS NULL FROM lb04.contracts) AS clean')
    expect(kept[0]).toEqual({ files: 0, pages: 0, clean: true })
  })

  it('fails the contract when the long model answers in no usable form twice: the one repair is all it gets', async () => {
    const long = nonsense()
    const id = await startWith('wholesale-supply', withModel('wholesale-supply', 'long', long))

    const runs = await drive(harness)

    expect(runs).toBe(1)
    expect(long.conversations).toHaveLength(2)
    expect(await viewOf(id)).toMatchObject({ state: 'failed', failure: { code: 'analysis_invalid' } })
    expect(await placesUsed()).toBe(0)
  })

  it('still finishes when the rating model answers in no usable form: the playbook\'s own severities stand in, uncalibrated, and the failed answers are not retried', async () => {
    const reason = nonsense()
    const id = await startWith('wholesale-supply', withModel('wholesale-supply', 'reason', reason))

    const runs = await drive(harness)

    expect(runs).toBe(1)
    expect(reason.conversations).toHaveLength(2)
    const report = await readReportView(harness.deps.db, VISITOR_A, id, harness.clock.now())
    expect(report.calibrated).toBe(false)
    expect(report.findings.length).toBeGreaterThan(0)
    expect(report.calls).toBe(4)
    expect(await viewOf(id)).toMatchObject({ state: 'done' })
  })

  it('degrades on its last attempt when only the rating model cannot be reached: the report is made without it', async () => {
    const reason = failing('upstream_failed', 502)
    const id = await startWith('wholesale-supply', withModel('wholesale-supply', 'reason', reason))

    const runs = await drive(harness)

    expect(runs).toBe(3)
    expect(reason.conversations).toHaveLength(3)
    const report = await readReportView(harness.deps.db, VISITOR_A, id, harness.clock.now())
    expect(report.calibrated).toBe(false)
    expect(report.findings.length).toBeGreaterThan(0)
  })

  it('ends a contract that has been started more often than the queue and the sweep between them should ever need, and does not try it for ever', async () => {
    const long = failing('upstream_failed', 502)
    const id = await startWith('wholesale-supply', withModel('wholesale-supply', 'long', long))

    // A queue that never says "last": the sweep keeps putting the job back.
    const runs = await drive(harness, { attempts: 100 })

    expect(runs).toBe(harness.deps.config.maxAttempts * 2 + 1)
    expect(long.conversations).toHaveLength(harness.deps.config.maxAttempts * 2)
    expect(await viewOf(id)).toMatchObject({ state: 'failed', failure: { code: 'internal' } })
    expect(await placesUsed()).toBe(0)
  })

  it('fails a contract that reaches a process with no gateway as internal, rather than leaving it queued for ever', async () => {
    const id = await startWith('wholesale-supply', referenceReview('wholesale-supply').scripts.models)
    harness.deps.review = undefined

    await drive(harness)

    expect(await viewOf(id)).toMatchObject({ state: 'failed', failure: { code: 'internal' } })
    expect(await placesUsed()).toBe(0)
  })
})

describe('the trace of a review', () => {
  it('is one tree: the root span written once when the review ends, and every step under it, with counts and labels only', async () => {
    const { id } = await startReference('wholesale-supply')

    await drive(harness)

    const spans = harness.spans.spans
    const root = spans.filter(span => span.name === 'contract review')
    expect(root).toHaveLength(1)
    expect(root[0]).toMatchObject({ kind: 'system.run', status: 'ok', spanId: rootSpanIdOf(id), runId: id, system: 'lb-04', attrs: { outcome: 'done', origin: 'sample', pages: 11, model_calls: 3 } })
    const steps = spans.filter(span => span.name !== 'contract review')
    expect(steps.map(span => span.name)).toEqual(expect.arrayContaining(['extract text', 'split clauses', 'screen for injection', 'cited analysis', 'verify quotes', 'structured report', 'assemble report']))
    for (const step of steps) expect(step.parentId, step.name).toBe(rootSpanIdOf(id))
    expect(spans.every(span => span.runId === id)).toBe(true)
  })

  it('carries nothing the contract says, nor the visitor\'s file name, nor a quote', async () => {
    const { id } = await startReference('hostile-supply')

    await drive(harness)

    const text = JSON.stringify(harness.spans.spans)
    const report = await readReportView(harness.deps.db, VISITOR_A, id, harness.clock.now())
    expect(report.findings.some(finding => finding.kind === 'risk')).toBe(true)
    for (const finding of report.findings) {
      if (finding.kind === 'risk') expect(text).not.toContain(finding.quote.slice(0, 40))
    }
    const entry = loadGoldenSet().cases.find(candidate => candidate.contract === 'hostile-supply')
    if (entry?.kind !== 'report') throw new Error('The hostile case is missing.')
    expect(entry.instructions.length).toBeGreaterThan(0)
    for (const instruction of entry.instructions) expect(text).not.toContain(instruction)
    expect(text).not.toContain('Supply agreement with instructions')
  })

  it('ends a failed review with an error root span that names the code and nothing else about the file', async () => {
    const id = await startWith('scanned-supply', referenceReview('wholesale-supply').scripts.models)

    await drive(harness)

    const root = harness.spans.spans.find(span => span.name === 'contract review')
    expect(root).toMatchObject({ status: 'error', spanId: rootSpanIdOf(id), attrs: { outcome: 'no_text_layer', origin: 'sample', model_calls: 0 } })
  })

  it('writes the root span once however many times a failed job is run', async () => {
    const id = await startWith('master-supply-31', referenceReview('wholesale-supply').scripts.models)

    await drive(harness)
    harness.scheduler.jobs.push(id)
    await drive(harness)

    expect(harness.spans.spans.filter(span => span.name === 'contract review')).toHaveLength(1)
  })
})
