// Tests for the mock's LB-10, held to what the service does (services/flask-systems/lb10): it lists the real packs,
// plays a run that moves on as it is polled and ends with a report of the documented shape, lists every problem of a
// refused prompt, counts one run a day with the service's ledger (the day's run before the one going, two refunds a
// day, a busy lab's run given back), shares one cache between visitors, writes spans as the calls end and never puts
// the prompt in one, and tells the story the board's samples rely on.
import { beforeEach, describe, expect, it } from 'vitest'

import { lb10BootstrapInterval, lb10PairedComparison, Lb10Mock, readLb10Seed } from '../src/testing/index.ts'

const seed = readLb10Seed()
const SESSION = 'session-of-sam-visitor-0001'
const OTHER = 'session-of-kim-visitor-0002'
let clock = Date.UTC(2026, 9, 5, 9, 0, 0)
let mock: Lb10Mock

/** Reads an answer's body as an object. */
function bodyOf(answer: { body?: unknown }): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return answer.body as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** The pack of a name, which the tests know is there. */
function pack(name: string) {
  const found = seed.packs.find(entry => entry.pack === name)
  if (!found) throw new Error(`no pack ${name}`)
  return found
}

/** Starts a run and polls it until it ends, returning its last state. */
function runToEnd(session: string, request: { target: string, prompt: string, providers: string[] }): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const started = mock.start(session, request)
  expect(started.status).toBe(202)
  const runId = bodyOf(started).run.run_id as string
  for (let poll = 0; poll < 10; poll += 1) {
    const view = bodyOf(mock.run(session, runId))
    if (view.state !== 'running') return view
  }
  throw new Error('the run did not end')
}

beforeEach(() => {
  clock = Date.UTC(2026, 9, 5, 9, 0, 0)
  mock = new Lb10Mock(seed, () => clock)
})

describe('the mock LB-10', () => {
  it('lists every committed pack as a target, with its production prompt, its version and ten sample cases', () => {
    const body = bodyOf(mock.targets())
    expect(body.targets.map((target: { pack: string }) => target.pack)).toEqual(['lb01-classifier', 'lb01-drafter', 'lb02-planner', 'lb05-sql-writer', 'lb08-generator'])
    const drafter = body.targets.find((target: { pack: string }) => target.pack === 'lb01-drafter')
    expect(drafter.variables).toEqual(['language'])
    expect(drafter.version).toMatch(/^[0-9a-f]{16}$/)
    expect(drafter.sample).toHaveLength(10)
    expect(drafter.providers.map((provider: { id: string }) => provider.id)).toEqual(['groq', 'workers-ai'])
    expect(body.limits.max_prompt_chars).toBe(8_000)
    expect(body.can_run).toBe(true)
  })

  it('plays a run through the cache read and the calls to a report, writing spans as the calls end and never the prompt', () => {
    const classifier = pack('lb01-classifier')
    const prompt = `${classifier.systemPrompt}\nBe brief, zebrapotato.`
    const started = bodyOf(mock.start(SESSION, { target: classifier.pack, prompt, providers: ['groq'] }))
    const runId = started.run.run_id as string
    expect(runId).toMatch(/^[\w-]{22}$/)
    expect(started.run).toMatchObject({ state: 'running', calls_done: 0, calls_total: 20, cached_calls: 0 })
    expect(started.run.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{6})?Z$/)
    expect(mock.spansOf(runId)).toBeUndefined()

    const read = bodyOf(mock.run(SESSION, runId))
    expect(read).toMatchObject({ state: 'running', calls_done: 0 })
    expect(mock.spansOf(runId)?.map(span => span.name)).toEqual(['read cache'])
    const moving = bodyOf(mock.run(SESSION, runId))
    expect(moving.calls_done).toBeGreaterThan(0)
    expect(moving.calls_done).toBeLessThan(20)
    bodyOf(mock.run(SESSION, runId))
    const done = bodyOf(mock.run(SESSION, runId))
    expect(done.state).toBe('done')
    // As the service: once done, `calls_done` counts the calls made, not the cached ones.
    expect(done).toMatchObject({ calls_done: 20, cached_calls: 0 })
    expect(done.report.variants.map((variant: { variant: string }) => variant.variant)).toEqual(['production', 'edited'])
    expect(done.report.comparisons[0].verdict).toBe('no_detectable_difference')
    expect(done.report.total_model_calls).toBe(20)

    const spans = mock.spansOf(runId) ?? []
    expect(spans.filter(span => span.name === 'model call')).toHaveLength(20)
    expect(spans.filter(span => span.kind === 'gateway.call')).toHaveLength(20)
    expect(spans.at(-1)).toMatchObject({ name: 'eval run', kind: 'system.run', status: 'ok' })
    expect(JSON.stringify(spans)).not.toContain('zebrapotato')
    expect(bodyOf(mock.run(OTHER, runId))).toMatchObject({ error: { code: 'not_found' } })
  })

  it('computes the production baseline once: the next visitor finds it cached, with the latency and tokens it cost', () => {
    const classifier = pack('lb01-classifier')
    const first = runToEnd(SESSION, { target: classifier.pack, prompt: `${classifier.systemPrompt}\nOne.`, providers: ['groq'] })
    const firstProduction = first.report.variants[0]
    expect(firstProduction.model_calls).toBe(10)

    const second = runToEnd(OTHER, { target: classifier.pack, prompt: `${classifier.systemPrompt}\nTwo.`, providers: ['groq'] })
    const production = second.report.variants[0]
    expect(production).toMatchObject({ variant: 'production', model_calls: 0, cached_calls: 10 })
    expect(production.cases.every((outcome: { cached: boolean }) => outcome.cached)).toBe(true)
    expect(production.input_tokens).toBe(firstProduction.input_tokens)
    expect(production.latency_p50_ms).toBe(firstProduction.latency_p50_ms)
    expect(second.report).toMatchObject({ total_model_calls: 10, total_cached_calls: 10 })
    expect(second).toMatchObject({ calls_done: 10, cached_calls: 10, calls_total: 20 })
  })

  it('runs an unchanged prompt once, and counts only the calls it makes', () => {
    const writer = pack('lb05-sql-writer')
    const done = runToEnd(SESSION, { target: writer.pack, prompt: writer.systemPrompt, providers: ['groq', 'workers-ai'] })
    expect(done.calls_total).toBe(20)
    expect(done.report.edited_is_production).toBe(true)
    expect(done.report.variants.map((variant: { variant: string, provider: string }) => `${variant.variant} ${variant.provider}`)).toEqual(['production groq', 'production workers-ai'])
    expect(done.report.comparisons).toEqual([])
  })

  it('tells the samples\' story: a dropped JSON rule gets prose, every case fails and the verdict is worse', () => {
    const classifier = pack('lb01-classifier')
    const prompt = classifier.systemPrompt.replace('Reply with one JSON object and nothing else, with exactly these fields:', 'Describe the ticket under these headings:')
    const done = runToEnd(SESSION, { target: classifier.pack, prompt, providers: ['groq'] })
    const comparison = done.report.comparisons[0]
    expect(comparison.verdict).toBe('worse')
    expect(comparison.high).toBeLessThan(0)
    const edited = done.report.variants[1]
    expect(edited.score.mean).toBe(0)
    expect(edited.cases[0].output).not.toContain('{')
    expect(edited.cases[0].grades[0]).toMatchObject({ kind: 'json_schema', passed: false })
    expect(comparison.changed.every((entry: { change: string }) => entry.change === 'regressed')).toBe(true)
  })

  it('lists every problem of a refused prompt, as the service does, and counts nothing', () => {
    const planner = pack('lb02-planner')
    const prompt = `${planner.systemPrompt.replace('{{language}}', 'English')} {{tomorrow}}\u0007`
    const refused = mock.start(SESSION, { target: planner.pack, prompt, providers: ['groq'] })
    expect(refused.status).toBe(422)
    expect(bodyOf(refused).error.code).toBe('invalid_prompt')
    expect(bodyOf(refused).problems.map((problem: { code: string }) => problem.code)).toEqual(['not_text', 'missing_variables', 'unknown_variables'])
    expect(bodyOf(refused).problems[1].message).toContain('{{language}}')
    const tooLong = mock.start(SESSION, { target: planner.pack, prompt: `${planner.systemPrompt}${'é'.repeat(8_000)}`, providers: ['groq'] })
    expect(bodyOf(tooLong).problems[0]).toMatchObject({ code: 'too_long' })
    expect(bodyOf(tooLong).problems[0].message).toContain('10,492 characters')
    // A letter outside the basic plane is one character, as Python counts it, though it is two in JavaScript.
    const astral = mock.start(SESSION, { target: 'lb01-classifier', prompt: `${pack('lb01-classifier').systemPrompt}${'😀'.repeat(6_000)}`, providers: ['groq'] })
    expect(astral.status).toBe(202)
    expect(mock.start(OTHER, { target: 'lb99', prompt: 'x', providers: ['groq'] }).status).toBe(404)
    expect(bodyOf(mock.start(OTHER, { target: planner.pack, prompt: planner.systemPrompt, providers: ['openrouter'] })).error.code).toBe('invalid_providers')
    expect(bodyOf(mock.quota(OTHER)).used).toBe(0)
  })

  it('allows one run a day: a second while it runs is the day\'s limit, as the service\'s ledger says, with when it resets', () => {
    const classifier = pack('lb01-classifier')
    const request = { target: classifier.pack, prompt: classifier.systemPrompt, providers: ['groq'] }
    expect(mock.start(SESSION, request).status).toBe(202)
    const again = mock.start(SESSION, request)
    expect(again.status).toBe(429)
    expect(bodyOf(again).error).toMatchObject({ code: 'daily_limit', resets_at: '2026-10-06T00:00:00+00:00' })
    expect(bodyOf(mock.quota(SESSION))).toMatchObject({ used: 1, remaining: 0 })
    clock += 24 * 60 * 60 * 1000
    expect(mock.start(SESSION, request).status).toBe(202)
  })

  it('gives back a run the service failed, two a day at most', () => {
    const classifier = pack('lb01-classifier')
    const request = { target: classifier.pack, prompt: `${classifier.systemPrompt}\nShort.`, providers: ['groq'] }
    for (const code of ['no_answers', 'model_budget']) {
      expect(mock.control('fail', { code }).status).toBe(200)
      const failed = runToEnd(SESSION, request)
      expect(failed).toMatchObject({ state: 'failed', failure: code, report: null })
      expect(bodyOf(mock.quota(SESSION)).remaining).toBe(1)
    }
    mock.control('fail', { code: 'time_limit' })
    expect(runToEnd(SESSION, request)).toMatchObject({ state: 'failed', failure: 'time_limit' })
    expect(bodyOf(mock.quota(SESSION)).remaining).toBe(0)
  })

  it('ends a failed run\'s trace as the service does: failed calls and an error root, or no root when the worker died', () => {
    const classifier = pack('lb01-classifier')
    mock.control('fail', { code: 'no_answers' })
    const failed = runToEnd(SESSION, { target: classifier.pack, prompt: `${classifier.systemPrompt}\nA.`, providers: ['groq'] })
    const spans = mock.spansOf(failed.run_id) ?? []
    expect(spans.filter(span => span.name === 'model call').every(span => span.attrs.error_code === 'upstream_failed')).toBe(true)
    expect(spans.at(-1)).toMatchObject({ name: 'eval run', status: 'error', attrs: { outcome: 'no_answers' } })
    mock.control('fail', { code: 'interrupted' })
    const lost = runToEnd(OTHER, { target: classifier.pack, prompt: `${classifier.systemPrompt}\nB.`, providers: ['groq'] })
    expect(lost.failure).toBe('interrupted')
    expect(mock.spansOf(lost.run_id)?.some(span => span.kind === 'system.run')).toBe(false)
  })

  it('makes some calls fail with the gateway\'s code: failed cases in a finished run', () => {
    const drafter = pack('lb01-drafter')
    mock.control('fail-calls', { code: 'upstream_failed', count: 2 })
    const done = runToEnd(SESSION, { target: drafter.pack, prompt: `${drafter.systemPrompt}\nKeep it short.`, providers: ['groq'] })
    const edited = done.report.variants[1]
    expect(edited.failed_calls).toBe(2)
    expect(edited.cases[0]).toMatchObject({ passed: false, output: '', grades: [], error: 'upstream_failed' })
  })

  it('refuses a run when the lab is busy, leaving a failed run behind that is given back, and when it has no gateway', () => {
    const classifier = pack('lb01-classifier')
    const request = { target: classifier.pack, prompt: classifier.systemPrompt, providers: ['groq'] }
    // However often the full lab turns the visitor away, nothing is counted and no refund is spent.
    for (let time = 0; time < 3; time += 1) {
      mock.control('busy', {})
      const busy = mock.start(SESSION, request)
      expect([busy.status, bodyOf(busy).error.code]).toEqual([503, 'lab_busy'])
    }
    expect(bodyOf(mock.runsToday(SESSION)).runs[0]).toMatchObject({ state: 'failed', failure: 'busy' })
    expect(bodyOf(mock.quota(SESSION)).remaining).toBe(1)
    mock.control('unavailable', { on: true })
    expect(bodyOf(mock.targets()).can_run).toBe(false)
    expect(bodyOf(mock.start(SESSION, request)).error.code).toBe('unavailable')
    mock.control('unavailable', { on: false })
    expect(mock.start(SESSION, request).status).toBe(202)
  })

  it('stores the nightly results and baselines a test gives it, and forgets them on reset', () => {
    expect(bodyOf(mock.nightly()).results).toEqual([])
    expect(bodyOf(mock.baselines()).baselines).toEqual([])
    const row = { run_on: '2026-10-04', kind: 'judge', pack: 'lb01-drafter', pack_version: '0123456789abcdef', alias: 'lb-eval-groq-120b', report: { counts: false } }
    expect(mock.control('nightly', { results: [row] }).status).toBe(200)
    expect(bodyOf(mock.nightly()).results).toEqual([row])
    expect(mock.control('nightly', { results: 'no' }).status).toBe(422)
    expect(mock.control('fail', { code: 'nonsense' }).status).toBe(422)
    mock.reset()
    expect(bodyOf(mock.nightly()).results).toEqual([])
  })
})

describe('the mock\'s statistics', () => {
  it('draws an interval around the mean, the same for the same results', () => {
    const passes = [true, true, true, true, true, true, true, false, false, true]
    const interval = lb10BootstrapInterval(passes)
    expect(interval.mean).toBe(0.8)
    expect(interval.low).toBeLessThan(0.8)
    expect(interval.high).toBeGreaterThan(0.8)
    expect(lb10BootstrapInterval(passes)).toEqual(interval)
  })

  it('calls one changed case in ten no detectable difference, and four lost cases worse', () => {
    const production = Array.from({ length: 10 }, () => true)
    const oneLost = production.map((passed, index) => (index === 0 ? false : passed))
    expect(lb10PairedComparison(oneLost, production)).toMatchObject({ verdict: 'no_detectable_difference', regressed: 1, difference: -0.1 })
    const fourLost = production.map((passed, index) => (index < 4 ? false : passed))
    expect(lb10PairedComparison(fourLost, production)).toMatchObject({ verdict: 'worse', regressed: 4 })
    expect(lb10PairedComparison([], [])).toMatchObject({ verdict: 'not_comparable' })
  })
})
