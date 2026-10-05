// Tests for the plain functions over a run and its report: where a run stands, how far its calls have got (a finished
// run's count of calls made leaves out the cached ones, as the service writes it), which failures are given back, the
// report grouped by provider, where marks go on the figures, and whether a reply holds the JSON object the graders
// read, the way the service looks for one.
import { describe, expect, it } from 'vitest'
import { byProvider, differenceAt, holdsJsonObject, intervalsOverlap, isGivenBack, isMalformed, passedCount, progressOf, scoreAt, stageOf, unansweredByProvider } from '~/boards/lb-10/report'
import type { Lb10Outcome, Lb10Report, Lb10Run, Lb10VariantReport } from '~/boards/lb-10/schemas'

/** A run as the service writes it, with what a test changes. */
function run(changes: Partial<Lb10Run> = {}): Lb10Run {
  return {
    run_id: 'run-0000000001',
    state: 'running',
    pack: 'lb01-drafter',
    pack_version: '0123456789abcdef',
    providers: ['groq'],
    calls_done: 0,
    calls_total: 20,
    cached_calls: 0,
    started_at: '2026-10-05T09:30:00.123456Z',
    finished_at: null,
    failure: null,
    report: null,
    ...changes,
  }
}

/** One case's outcome. */
function outcome(caseId: string, passed: boolean, output = '{}', error: string | null = null): Lb10Outcome {
  return { case_id: caseId, passed, output, grades: [], error, latency_ms: 500, model: 'openai/gpt-oss-120b', cached: false }
}

/** One prompt on one provider. */
function variant(provider: string, which: 'production' | 'edited', passes: boolean[]): Lb10VariantReport {
  return {
    variant: which,
    provider,
    alias: provider === 'groq' ? 'lb-eval-groq-120b' : 'lb-eval-cf-120b',
    score: { mean: 0.5, low: 0.2, high: 0.8, cases: passes.length },
    latency_p50_ms: 500,
    latency_p95_ms: 900,
    input_tokens: 100,
    output_tokens: 20,
    model_calls: passes.length,
    cached_calls: 0,
    failed_calls: 0,
    cases: passes.map((passed, index) => outcome(`c${index}`, passed)),
  }
}

describe('a run on the board', () => {
  it('says where a run stands from what the service counts', () => {
    expect(stageOf(run())).toBe('starting')
    expect(stageOf(run({ calls_done: 10, cached_calls: 10 }))).toBe('calling')
    expect(stageOf(run({ calls_done: 20, cached_calls: 10 }))).toBe('writing')
    expect(stageOf(run({ state: 'done' }))).toBe('done')
    expect(stageOf(run({ state: 'failed', failure: 'no_answers' }))).toBe('failed')
  })

  it('counts a finished run\'s calls as all accounted for, though the service then counts only the calls it made', () => {
    expect(progressOf(run({ calls_done: 7, cached_calls: 10 }))).toEqual({ done: 7, total: 20, cached: 10 })
    expect(progressOf(run({ state: 'done', calls_done: 10, cached_calls: 10 }))).toEqual({ done: 20, total: 20, cached: 10 })
    expect(progressOf(run({ calls_done: 40, cached_calls: 40 }))).toEqual({ done: 20, total: 20, cached: 20 })
  })

  it('knows which failures the service gives back: those of the service, not of the prompt', () => {
    for (const failure of ['model_budget', 'no_answers', 'time_limit', 'interrupted', 'call_limit', 'busy']) expect(isGivenBack(failure)).toBe(true)
    expect(isGivenBack(null)).toBe(false)
    expect(isGivenBack('something_new')).toBe(false)
  })
})

describe('the report', () => {
  it('groups the prompts by provider, each with its comparison', () => {
    const report: Lb10Report = {
      pack: 'lb01-drafter',
      pack_version: '0123456789abcdef',
      sample_size: 2,
      case_ids: ['c0', 'c1'],
      edited_is_production: false,
      variants: [variant('groq', 'production', [true, true]), variant('groq', 'edited', [true, false]), variant('workers-ai', 'production', [true, false])],
      comparisons: [{ provider: 'groq', alias: 'lb-eval-groq-120b', difference: -0.5, low: -1, high: 0, verdict: 'no_detectable_difference', improved: 0, regressed: 1, cases: 2, changed: [] }],
      total_model_calls: 6,
      total_cached_calls: 0,
      total_input_tokens: 300,
      total_output_tokens: 60,
      sample_note: 'Ten cases is a small sample.',
    }
    const groups = byProvider(report)
    expect(groups.map(group => group.provider)).toEqual(['groq', 'workers-ai'])
    expect(groups[0]?.edited?.variant).toBe('edited')
    expect(groups[0]?.comparison?.verdict).toBe('no_detectable_difference')
    expect(groups[1]?.edited).toBeUndefined()
    expect(groups[1]?.comparison).toBeUndefined()
    expect(passedCount(report.variants[1]!)).toBe(1)
  })

  it('counts the calls of each provider that got no answer, of either prompt, with each of the gateway\'s codes once', () => {
    const production = variant('groq', 'production', [true, false, false])
    production.cases[1] = outcome('c1', false, '', 'budget_exhausted')
    production.cases[2] = outcome('c2', false, '', 'budget_exhausted')
    const edited = variant('groq', 'edited', [true, false])
    edited.cases[1] = outcome('c1', false, '', 'upstream_failed')
    const other = variant('workers-ai', 'production', [true, false])
    const report = { variants: [production, edited, other] } as unknown as Lb10Report
    const found = unansweredByProvider(report)
    expect(found.get('groq')).toEqual({ count: 3, codes: ['budget_exhausted', 'upstream_failed'] })
    expect(found.has('workers-ai')).toBe(false)
  })

  it('places marks on the figures as shares of their width, and tells overlapping intervals', () => {
    expect(scoreAt(0.9)).toBeCloseTo(90)
    expect(scoreAt(1.2)).toBe(100)
    expect(differenceAt(-1)).toBe(0)
    expect(differenceAt(0)).toBe(50)
    expect(differenceAt(0.3)).toBeCloseTo(65)
    expect(intervalsOverlap({ low: 0.5, high: 0.9 }, { low: 0.8, high: 1 })).toBe(true)
    expect(intervalsOverlap({ low: 0.7, high: 1 }, { low: 0, high: 0 })).toBe(false)
  })

  it('finds the JSON object a reply holds as the service\'s graders do: whole, fenced, or between its first and last brace', () => {
    expect(holdsJsonObject('{"category": "late"}')).toBe(true)
    expect(holdsJsonObject('```json\n{"category": "late"}\n```')).toBe(true)
    expect(holdsJsonObject('Here it is: {"category": "late"} as asked.')).toBe(true)
    expect(holdsJsonObject('The ticket is about a late parcel.')).toBe(false)
    expect(holdsJsonObject('{"category": "late",}')).toBe(false)
  })

  it('calls a failed JSON reply with no JSON object malformed, but not a call that got no answer or a text reply', () => {
    expect(isMalformed(outcome('a', false, 'The ticket is late.'), 'json')).toBe(true)
    expect(isMalformed(outcome('a', false, '{"category": "other"}'), 'json')).toBe(false)
    expect(isMalformed(outcome('a', false, '', 'upstream_failed'), 'json')).toBe(false)
    expect(isMalformed(outcome('a', false, 'prose'), 'text')).toBe(false)
    expect(isMalformed(outcome('a', true, 'prose'), 'json')).toBe(false)
  })
})
