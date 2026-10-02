// Tests for the mock's LB-05: it plays like the real one at the level a board can see. The curated
// questions are answered with a table, a chart and an explanation; an attack from the adversarial set
// is stopped by the layer and rule that set names (or held another way); the visitor's 25 questions a
// day count down and then say when they start again; the semantic layer is the real file's; a run's
// spans are the pipeline's, with the root last; and every answer fits the OpenAPI document.
import { generateKeyPairSync } from 'node:crypto'

import { mintServiceToken } from '@lb/common/tokens'
import { mintVisitorToken } from '@lb/common/visitors'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { buildChart, readLb05Seed, startMockBackend } from '../src/testing/index.ts'
import type { MockBackend } from '../src/testing/index.ts'

const site = generateKeyPairSync('ed25519')
const web = generateKeyPairSync('ed25519')
const seed = readLb05Seed()
// The clock the mock and the tokens share, in Unix milliseconds. Tests move it.
let clock = Date.UTC(2026, 9, 5, 9, 0, 0)
let mock: MockBackend

beforeAll(async () => {
  mock = await startMockBackend({
    siteKey: site.publicKey.export({ format: 'jwk' }).x ?? '',
    webKey: web.publicKey.export({ format: 'jwk' }).x ?? '',
    now: () => clock,
  })
})

afterAll(async () => {
  await mock.close()
})

beforeEach(() => {
  mock.reset()
  clock = Date.UTC(2026, 9, 5, 9, 0, 0)
})

/** What the mock answered: a status and a JSON body. */
interface Reply {
  status: number
  json: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Calls the mock as a visitor of LB-05. */
async function call(method: string, path: string, body?: unknown, visitor = 'visitor-aaaaaaaaaaaaaaaa'): Promise<Reply> {
  const token = mintVisitorToken(site.privateKey, { system: 'lb-05', sessionKey: visitor }, clock / 1000)
  const response = await fetch(`${mock.url}${path}`, {
    method,
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, json: text === '' ? undefined : JSON.parse(text) }
}

/** Asks a question as a visitor. */
function ask(question: string, visitor?: string): Promise<Reply> {
  return call('POST', '/api/lb05/ask', { question }, visitor)
}

/** Reads a run's spans from the mock's Scope route as the `web` service. */
async function spansOf(runId: string): Promise<{ status: number, json: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const authorization = `Bearer ${mintServiceToken('web', web.privateKey, clock / 1000)}`
  const response = await fetch(`${mock.url}/v1/runs/${runId}/spans`, { headers: { authorization } })
  return { status: response.status, json: await response.json() }
}

/** The question of a golden case, by its ID. */
function curated(id: string): string {
  return seed.questions.find(item => item.id === id)?.question ?? ''
}

/** The attempt of the adversarial set, by its ID. */
function attack(id: string) {
  const found = seed.attacks.find(item => item.id === id)
  if (!found) throw new Error(`No attack ${id}.`)
  return found
}

describe('the curated questions', () => {
  const expected: [string, string][] = [
    ['revenue-last-quarter', 'none'],
    ['revenue-by-product-last-quarter', 'bar'],
    ['active-subscriptions-by-frequency', 'point'],
    ['monthly-revenue-last-year', 'line'],
    ['top-5-products-last-year', 'bar'],
    ['cancellation-rate-last-quarter', 'none'],
    ['lost-repeat-buyers-last-quarter', 'bar'],
  ]

  it.each(expected)('are answered with the table, the SQL and an explanation: %s', async (id, chart) => {
    const answer = await ask(curated(id))

    expect(answer.status).toBe(200)
    expect(answer.json).toMatchObject({ outcome: 'answered', explanation_source: 'model' })
    expect(answer.json.result.rows.length).toBe(answer.json.result.row_count)
    expect(answer.json.result.sql).toMatch(/^(SELECT|WITH) /)
    expect(answer.json.attempts.at(-1)).toMatchObject({ stopped_by: null, rule: null })
    expect(answer.json.explanation.length).toBeGreaterThan(20)
    expect(answer.json.chart?.kind ?? 'none').toBe(chart)
    expect(mock.violations).toEqual([])
  })

  it('shows the model\'s query apart from the one the checks rendered and ran', async () => {
    const answer = (await ask(curated('revenue-by-product-last-quarter'))).json

    expect(answer.attempts[0].sql).not.toBe(answer.result.sql)
    expect(answer.result.sql).toMatch(/LIMIT 1000$/)
    expect(answer.result.tables).toEqual(['order_lines', 'orders'])
  })

  it('counts a year back from the day the mock is on, so "last year" is a year with sales', async () => {
    const answer = (await ask(curated('monthly-revenue-last-year'))).json

    expect(answer.result.rows[0][0]).toBe('2025-01-01')
    expect(answer.result.rows).toHaveLength(12)
    expect(answer.as_of).toBe('2026-10-04')
  })
})

describe('the attacks', () => {
  it('are stopped at the layer and for the rule the adversarial set names, when a model that obeyed would write the query and the rule is not one the model may correct', async () => {
    for (const id of ['drop-orders-table', 'stacked-drop', 'read-csv-passwd', 'information-schema-tables', 'inject-ignore-instructions']) {
      const expected = attack(id)
      const answer = (await ask(expected.question)).json

      expect(answer.outcome, id).toBe('refused')
      expect(answer.attempts, id).toHaveLength(1)
      expect(answer.attempts[0], id).toMatchObject({ sql: expected.sql, stopped_by: expected.stoppedBy, rule: expected.rule })
      expect(answer.message, id).toContain(`Stopped by the ${expected.stoppedBy} check (${expected.rule})`)
      expect(answer.result, id).toBeNull()
      expect(answer.chart, id).toBeNull()
    }
    expect(mock.violations).toEqual([])
  })

  it('has a model that is told its query used a column the layer does not have decline, naming the first attempt', async () => {
    const expected = attack('hidden-email')
    const answer = (await ask(expected.question)).json

    expect(answer.outcome).toBe('declined')
    expect(answer.attempts).toHaveLength(1)
    expect(answer.attempts[0]).toMatchObject({ stopped_by: 'allowlist', rule: 'unknown_column' })
    expect(answer.message).toContain('nothing under that name')
  })

  it('has a model that is told its join or plan was refused write another query that runs, so the question is answered after one correction', async () => {
    const answer = (await ask(attack('cte-join-on-constant').question)).json

    expect(answer.outcome).toBe('answered')
    expect(answer.attempts).toHaveLength(2)
    expect(answer.attempts[0]).toMatchObject({ stopped_by: 'explain', rule: 'plan_too_large' })
    expect(answer.attempts[1]).toMatchObject({ stopped_by: null, rule: null })
    expect(answer.model_calls).toBe(3)
  })

  it('holds a dump of every order by answering with the thousand rows the cap allows, and saying it cut them', async () => {
    const answer = (await ask(attack('dump-all-orders').question)).json

    expect(answer.outcome).toBe('answered')
    expect(answer.result).toMatchObject({ row_count: 1_000, truncated: true })
    expect(answer.result.rows).toHaveLength(1_000)
    expect(answer.chart.omitted_rows).toBe(800)
    expect(mock.violations).toEqual([])
  })

  it('answers every attempt of the adversarial set in the shape its document says', async () => {
    for (const item of seed.attacks) {
      const answer = await ask(item.question, `visitor-${item.id.slice(0, 16).padEnd(16, 'x')}`)
      expect(answer.status, item.id).toBe(200)
      expect(['answered', 'declined', 'refused']).toContain(answer.json.outcome)
    }
    expect(mock.violations).toEqual([])
  })

  it('refuses a destructive question of the visitor\'s own at the parse layer, and declines one about what the data does not hold', async () => {
    const dropped = (await ask('Please delete all the cancelled orders now')).json
    expect(dropped).toMatchObject({ outcome: 'refused' })
    expect(dropped.attempts[0]).toMatchObject({ stopped_by: 'parse', rule: 'not_select' })

    const outside = (await ask('What is the average salary of our team?')).json
    expect(outside).toMatchObject({ outcome: 'declined', attempts: [] })
  })
})

describe('the visitor\'s questions a day', () => {
  it('counts down from 25 with each question', async () => {
    expect((await call('GET', '/api/lb05/quota')).json).toMatchObject({ used: 0, remaining: 25, limits: { questions_per_day: 25, row_cap: 1_000, query_timeout_seconds: 5, question_deadline_seconds: 90, max_model_calls_per_question: 5 } })

    const answer = (await ask(curated('revenue-last-quarter'))).json
    expect(answer.remaining_questions).toBe(24)
    expect((await call('GET', '/api/lb05/quota')).json).toMatchObject({ used: 1, remaining: 24 })
  })

  it('refuses the twenty-sixth question with the time the count starts again, and counts each visitor on their own', async () => {
    for (let count = 0; count < 25; count += 1) expect((await ask(curated('revenue-last-quarter'))).status).toBe(200)

    const twentySixth = await ask(curated('revenue-last-quarter'))
    expect(twentySixth.status).toBe(429)
    expect(twentySixth.json.error).toMatchObject({ code: 'daily_limit', resets_at: '2026-10-06T00:00:00+00:00' })
    expect((await ask(curated('revenue-last-quarter'), 'visitor-bbbbbbbbbbbbbbbb')).status).toBe(200)
    expect(mock.violations).toEqual([])
  })

  it('starts the count again at midnight, UTC', async () => {
    for (let count = 0; count < 25; count += 1) await ask(curated('revenue-last-quarter'))
    clock = Date.UTC(2026, 9, 6, 0, 0, 1)

    expect((await call('GET', '/api/lb05/quota')).json).toMatchObject({ used: 0, remaining: 25 })
    expect((await ask(curated('revenue-last-quarter'))).status).toBe(200)
  })
})

describe('the semantic layer', () => {
  it('is the real file\'s: five tables, twelve metrics, fourteen slices, and not the two columns it leaves out', async () => {
    const layer = (await call('GET', '/api/lb05/semantic-layer')).json

    expect(layer.tables.map((table: { name: string }) => table.name)).toEqual(['customers', 'products', 'orders', 'order_lines', 'subscriptions'])
    expect(layer.metrics).toHaveLength(12)
    expect(layer.dimensions).toHaveLength(14)
    expect(layer.joins).toHaveLength(6)
    const columns = layer.tables.flatMap((table: { name: string, columns: { name: string }[] }) => table.columns.map(column => `${table.name}.${column.name}`))
    expect(columns).not.toContain('customers.email')
    expect(columns).not.toContain('orders.payment_reference')
    expect(layer.metrics.find((metric: { name: string }) => metric.name === 'revenue')).toMatchObject({ kind: 'expression', label: 'Revenue' })
    expect(layer.metrics.find((metric: { name: string }) => metric.name === 'repeat_buyers').kind).toBe('worked_example')
    expect(mock.violations).toEqual([])
  })

  it('counts its date phrases from the last day of the data', async () => {
    const layer = (await call('GET', '/api/lb05/semantic-layer')).json
    const range = (name: string) => layer.ranges.find((item: { name: string }) => item.name === name)

    expect(layer.as_of).toBe('2026-10-04')
    expect(range('last_quarter')).toMatchObject({ start: '2026-07-01', end: '2026-09-30' })
    expect(range('last_year')).toMatchObject({ start: '2025-01-01', end: '2025-12-31' })
    expect(range('last_month')).toMatchObject({ start: '2026-09-01', end: '2026-09-30' })
  })
})

describe('a run\'s trace', () => {
  it('is complete when the answer arrives: the pipeline\'s steps in order, the model calls under them and the root span last', async () => {
    const answer = (await ask(curated('revenue-by-product-last-quarter'))).json
    const page = await spansOf(answer.run_id)

    expect(page.status).toBe(200)
    expect(page.json.finished).toBe(true)
    const names = page.json.spans.map((span: { name: string }) => span.name)
    expect(names.at(-1)).toBe('data question')
    for (const step of ['resolve metrics', 'write SQL', 'parse and allowlist', 'explain plan', 'run read-only', 'build chart', 'explain result']) expect(names).toContain(step)
    expect(names).not.toContain('self-correct')
    const calls = page.json.spans.filter((span: { kind: string }) => span.kind === 'gateway.call')
    expect(calls.map((span: { name: string }) => span.name)).toEqual(['lb-reason', 'lb-fast'])
    expect(page.json.spans.every((span: { system: string }) => span.system === 'lb-05')).toBe(true)
    expect(answer.model_calls).toBe(2)
  })

  it('holds the correction inside self-correct, and marks the step a layer stopped as failed with its layer and rule', async () => {
    const answer = (await ask(attack('cte-join-on-constant').question)).json
    const spans = (await spansOf(answer.run_id)).json.spans as { name: string, status: string, spanId: string, parentId?: string, attrs: Record<string, unknown> }[]

    const correct = spans.find(span => span.name === 'self-correct')
    expect(correct).toBeDefined()
    expect(spans.find(span => span.name === 'write SQL again')?.parentId).toBe(correct?.spanId)
    const stoppedPlan = spans.find(span => span.name === 'explain plan' && span.status === 'error')
    expect(stoppedPlan?.attrs).toMatchObject({ layer: 'explain', rule: 'plan_too_large', retryable: true })
    expect(spans.filter(span => span.name === 'parse and allowlist')).toHaveLength(2)
  })

  it('shows a stopped query\'s trace ending at the step that stopped it', async () => {
    const answer = (await ask(attack('drop-orders-table').question)).json
    const spans = (await spansOf(answer.run_id)).json.spans as { name: string, kind: string }[]

    expect(spans.filter(span => span.kind.startsWith('system.')).map(span => span.name)).toEqual(['resolve metrics', 'write SQL', 'parse and allowlist', 'data question'])
  })
})

describe('the chart the mock builds', () => {
  it('follows the real rules: a date and a number make a line, a label and a number bars, two numbers points, one row nothing', () => {
    expect(buildChart([{ name: 'month', kind: 'date' }, { name: 'revenue', kind: 'integer' }], [['2025-01-01', 1], ['2025-02-01', 2]])?.kind).toBe('line')
    expect(buildChart([{ name: 'product', kind: 'text' }, { name: 'revenue', kind: 'integer' }], [['a', 1], ['b', 2]])?.kind).toBe('bar')
    expect(buildChart([{ name: 'a', kind: 'integer' }, { name: 'b', kind: 'number' }], [[1, 2], [3, 4]])?.kind).toBe('point')
    expect(buildChart([{ name: 'revenue', kind: 'integer' }], [[1]])).toBeUndefined()
    expect(buildChart([{ name: 'product', kind: 'text' }], [['a'], ['b']])).toBeUndefined()
  })

  it('colours bars by a second label when it has two to eight values, and calls a year an ordered label', () => {
    const coloured = buildChart([{ name: 'product', kind: 'text' }, { name: 'country', kind: 'text' }, { name: 'revenue', kind: 'integer' }], [['a', 'CZ', 1], ['a', 'SK', 2], ['b', 'CZ', 3]])
    expect(coloured?.spec.encoding).toHaveProperty('color')
    const yearly = buildChart([{ name: 'year', kind: 'integer' }, { name: 'orders', kind: 'integer' }], [[2024, 10], [2025, 12]])
    expect(yearly?.kind).toBe('bar')
    expect(yearly?.spec.encoding).toMatchObject({ x: { type: 'ordinal' } })
  })

  it('writes only the closed subset: no url, transform, params or signal', () => {
    const chart = buildChart([{ name: 'product', kind: 'text' }, { name: 'revenue', kind: 'integer' }], [['a', 1], ['b', 2]])
    const text = JSON.stringify(chart?.spec)
    for (const forbidden of ['"url"', '"transform"', '"params"', '"signal"', '"expr"', '"calculate"']) expect(text).not.toContain(forbidden)
  })
})
