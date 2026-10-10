// Tests of the schemas LB-10's board checks every answer with: the mock back end's answers pass (they are the shape
// the real service writes), a moment passes however the service writes it (Pydantic's `Z` with microseconds in a
// model, Python's `+00:00` in an error), an answer that strays (an unknown state, a score above one, a reply past its
// bound) is refused rather than shown, and a recorded exchange is read the way the live answer is.
import type { Exchange } from '@lb/contracts'
import { Lb10Mock, readLb10Seed } from '@lb/api-clients/testing'
import { describe, expect, it } from 'vitest'
import { factOf } from '~/boards/lb-10/exchange'
import { baselinesSchema, nightlySchema, quotaSchema, runSchema, runsSchema, startedSchema, targetsSchema } from '~/boards/lb-10/schemas'
import type { Lb10Run } from '~/boards/lb-10/schemas'

const NOW = Date.parse('2026-10-05T09:30:00.000Z')
const VISITOR = 'visitor-session'

/** A mock whose clock stands still, and a run of an edited drafter started on it. */
function started() {
  const mock = new Lb10Mock(readLb10Seed(), () => NOW)
  const targets = targetsSchema.parse(mock.targets().body)
  const drafter = targets.targets.find(target => target.pack === 'lb01-drafter')
  const answer = mock.start(VISITOR, { target: 'lb01-drafter', prompt: `${drafter?.system_prompt ?? ''}\nKeep it short.`, providers: ['groq', 'workers-ai'] })
  return { mock, targets, answer }
}

/** A running run as the service writes it, with what a test changes. */
function serviceRun(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: 'kQ2v9xYbR1cT0aZ8',
    state: 'running',
    pack: 'lb01-drafter',
    pack_version: '3f9a0c1b2d4e5f60',
    providers: ['groq'],
    calls_done: 3,
    calls_total: 20,
    cached_calls: 0,
    started_at: '2026-10-05T09:30:00.123456Z',
    finished_at: null,
    failure: null,
    report: null,
    ...changes,
  }
}

describe('LB-10\'s schemas against the mock back end', () => {
  it('accept the targets with their prompts, cases and providers, and the lab\'s limits', () => {
    const { targets } = started()
    expect(targets.targets.map(target => target.pack)).toEqual(['lb01-classifier', 'lb01-drafter', 'lb02-planner', 'lb05-sql-writer', 'lb08-generator'])
    expect(targets.targets.every(target => target.sample.length === 10)).toBe(true)
    expect(targets.limits).toMatchObject({ cases_per_run: 10, runs_per_day: 1, max_prompt_chars: 8_000, max_providers_per_run: 2 })
    expect(targets.can_run).toBe(true)
  })

  it('accept a run as it is taken, as it is read until it ends, and its report', () => {
    const { mock, answer } = started()
    expect(answer.status).toBe(202)
    const taken = startedSchema.parse(answer.body)
    expect(taken.run.state).toBe('running')
    expect(taken.remaining_runs).toBe(0)
    let run: Lb10Run = taken.run
    for (let read = 0; read < 10 && run.state === 'running'; read += 1) run = runSchema.parse(mock.run(VISITOR, run.run_id).body)
    expect(run.state).toBe('done')
    expect(run.report?.variants).toHaveLength(4)
    expect(run.report?.comparisons.map(comparison => comparison.provider)).toEqual(['groq', 'workers-ai'])
  })

  it('accept the visitor\'s runs of today, their count, the baselines and the nightly, empty or not', () => {
    const { mock } = started()
    expect(runsSchema.parse(mock.runsToday(VISITOR).body).runs).toHaveLength(1)
    expect(quotaSchema.parse(mock.quota(VISITOR).body)).toMatchObject({ used: 1, remaining: 0 })
    expect(baselinesSchema.parse(mock.baselines().body).baselines).toEqual([])
    expect(nightlySchema.parse(mock.nightly().body).results).toEqual([])
  })
})

describe('LB-10\'s schemas against what the service writes', () => {
  it('take a moment written with microseconds and Z, or with an offset, and refuse one that is not a moment', () => {
    expect(runSchema.safeParse(serviceRun()).success).toBe(true)
    expect(runSchema.safeParse(serviceRun({ started_at: '2026-10-05T09:30:00.123456+00:00' })).success).toBe(true)
    expect(runSchema.safeParse(serviceRun({ started_at: 'yesterday at noon' })).success).toBe(false)
  })

  it('refuse a run in a state the service has no word for, or counts past their ceiling', () => {
    expect(runSchema.safeParse(serviceRun({ state: 'paused' })).success).toBe(false)
    expect(runSchema.safeParse(serviceRun({ calls_done: -1 })).success).toBe(false)
    expect(runSchema.safeParse(serviceRun({ calls_done: 2.5 })).success).toBe(false)
    expect(runSchema.safeParse(serviceRun({ run_id: '../../etc' })).success).toBe(false)
  })

  it('refuse a report whose score is not a share, or whose reply is past twice the service\'s cut', () => {
    const { mock, answer } = started()
    const runId = startedSchema.parse(answer.body).run.run_id
    let body: unknown
    for (let read = 0; read < 10; read += 1) body = mock.run(VISITOR, runId).body
    const done = runSchema.parse(body)
    const variant = done.report?.variants[0]
    expect(variant).toBeDefined()
    const withScore = { ...done, report: { ...done.report, variants: [{ ...variant, score: { ...variant?.score, mean: 1.5 } }] } }
    expect(runSchema.safeParse(withScore).success).toBe(false)
    const longCase = { ...variant?.cases[0], output: 'x'.repeat(4_001) }
    const withReply = { ...done, report: { ...done.report, variants: [{ ...variant, cases: [longCase] }] } }
    expect(runSchema.safeParse(withReply).success).toBe(false)
  })
})

describe('a recorded exchange', () => {
  /** An exchange of a request and its answer. */
  function exchange(method: string, path: string, status: number, body: unknown): Exchange {
    return { request: { method, path }, response: { status, body } } as Exchange
  }

  it('is read into the fact the live answer gives: a run started, or a run read', () => {
    const { answer } = started()
    const taken = startedSchema.parse(answer.body)
    expect(factOf(exchange('POST', '/api/lb10/runs', 202, answer.body))).toEqual({ kind: 'started', started: taken })
    expect(factOf(exchange('GET', `/api/lb10/runs/${taken.run.run_id}`, 200, taken.run))).toEqual({ kind: 'view', run: taken.run })
  })

  it('is passed over when it is not a success, does not fit its schema, or is of another route', () => {
    const { answer } = started()
    const taken = startedSchema.parse(answer.body)
    expect(factOf(exchange('POST', '/api/lb10/runs', 429, { error: { code: 'daily_limit', message: 'Used.' } }))).toBeUndefined()
    expect(factOf(exchange('GET', `/api/lb10/runs/${taken.run.run_id}`, 200, { ...taken.run, state: 'paused' }))).toBeUndefined()
    expect(factOf(exchange('GET', '/api/lb10/runs', 200, { runs: [taken.run] }))).toBeUndefined()
    expect(factOf(exchange('GET', '/api/lb10/runs/../quota', 200, taken.run))).toBeUndefined()
  })
})
