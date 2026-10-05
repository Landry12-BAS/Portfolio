// Tests for the mock's LB-10: it lists the real packs, plays a run that moves on as it is polled
// and ends with a report of the documented shape, refuses what the real API refuses, and never
// puts the prompt in a span.
import { beforeEach, describe, expect, it } from 'vitest'

import { Lb10Mock, readLb10Seed } from '../src/testing/index.ts'

const seed = readLb10Seed()
const SESSION = 'session-of-sam-visitor-0001'
let clock = Date.UTC(2026, 9, 5, 9, 0, 0)
let mock: Lb10Mock

/** Reads an answer's body as an object. */
function bodyOf(answer: { body?: unknown }): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return answer.body as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeEach(() => {
  clock = Date.UTC(2026, 9, 5, 9, 0, 0)
  mock = new Lb10Mock(seed, () => clock)
})

describe('the mock LB-10', () => {
  it('lists every committed pack as a target, with its production prompt and ten sample cases', () => {
    const body = bodyOf(mock.targets())
    expect(body.targets.map((target: { pack: string }) => target.pack)).toEqual(['lb01-classifier', 'lb01-drafter', 'lb02-planner', 'lb05-sql-writer', 'lb08-generator'])
    const drafter = body.targets.find((target: { pack: string }) => target.pack === 'lb01-drafter')
    expect(drafter.variables).toEqual(['language'])
    expect(drafter.sample).toHaveLength(10)
    expect(drafter.providers.map((provider: { id: string }) => provider.id)).toEqual(['groq', 'workers-ai'])
  })

  it('plays a run that moves on with each poll and ends with a report and a trace without the prompt', () => {
    const pack = seed.packs[0]!
    const prompt = `${pack.systemPrompt}\nBe brief, zebrapotato.`
    const started = mock.start(SESSION, { target: pack.pack, prompt, providers: ['groq'] })
    expect(started.status).toBe(202)
    const runId = bodyOf(started).run.run_id as string
    const first = bodyOf(mock.run(SESSION, runId))
    expect(first.state).toBe('running')
    expect(first.calls_done).toBeGreaterThan(0)
    const second = bodyOf(mock.run(SESSION, runId))
    expect(second.state).toBe('done')
    expect(second.report.variants.map((variant: { variant: string }) => variant.variant)).toEqual(['production', 'edited'])
    expect(second.report.comparisons[0].verdict).toBe('no_detectable_difference')
    expect(second.report.comparisons[0].changed).toHaveLength(1)
    expect(second.report.total_model_calls).toBe(10)
    const spans = mock.spansOf(runId) ?? []
    expect(spans.filter(span => span.name === 'model call')).toHaveLength(20)
    expect(spans.at(-1)?.name).toBe('eval run')
    expect(JSON.stringify(spans)).not.toContain('zebrapotato')
    expect(bodyOf(mock.run('session-of-kim-visitor-0002', runId))).toMatchObject({ error: { code: 'not_found' } })
  })

  it('allows one run a day, refuses a second, and starts again the next day', () => {
    const pack = seed.packs[0]!
    const request = { target: pack.pack, prompt: pack.systemPrompt, providers: ['groq'] }
    const first = mock.start(SESSION, request)
    expect(first.status).toBe(202)
    expect(mock.start(SESSION, request).status).toBe(429)
    expect(bodyOf(mock.start(SESSION, request)).error.code).toBe('run_running')
    mock.run(SESSION, bodyOf(first).run.run_id)
    mock.run(SESSION, bodyOf(first).run.run_id)
    expect(bodyOf(mock.start(SESSION, request)).error.code).toBe('daily_limit')
    expect(bodyOf(mock.quota(SESSION)).remaining).toBe(0)
    clock += 24 * 60 * 60 * 1000
    expect(mock.start(SESSION, request).status).toBe(202)
  })

  it('refuses a prompt that drops or adds a variable, an unknown target, and a provider not offered', () => {
    const drafter = seed.packs.find(pack => pack.pack === 'lb01-drafter')!
    const dropped = mock.start(SESSION, { target: 'lb01-drafter', prompt: drafter.systemPrompt.replace('{{language}}', 'English'), providers: ['groq'] })
    expect(dropped.status).toBe(422)
    expect(bodyOf(dropped).problems[0].code).toBe('missing_variables')
    const unknown = mock.start(SESSION, { target: 'lb01-drafter', prompt: `${drafter.systemPrompt} {{today}}`, providers: ['groq'] })
    expect(bodyOf(unknown).problems[0].code).toBe('unknown_variables')
    expect(mock.start(SESSION, { target: 'lb99', prompt: 'x', providers: ['groq'] }).status).toBe(404)
    expect(bodyOf(mock.start(SESSION, { target: drafter.pack, prompt: drafter.systemPrompt, providers: ['openrouter'] })).error.code).toBe('invalid_providers')
    expect(bodyOf(mock.quota(SESSION)).used).toBe(0)
  })
})
