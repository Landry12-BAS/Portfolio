// Unit tests for what LB-05's board accepts from its API: well-formed answers of every outcome,
// answers that contradict themselves (which are not shown), fields that are too long or of the wrong
// kind, and the quota and the semantic layer.
import { describe, expect, it } from 'vitest'

import { contradiction, answerSchema, quotaSchema, semanticLayerSchema } from '~/boards/lb-05/schemas'
import { quotaFrom } from '~/boards/lb-05/limits'

import { answered, declined, refused, stopped, unavailable } from '../support/lb05'

describe('an answer to a question', () => {
  it('is accepted when it is answered, declined, refused or unavailable', () => {
    for (const answer of [answered(), declined(), refused(), unavailable()]) {
      expect(answerSchema.safeParse(answer).success, answer.outcome).toBe(true)
    }
  })

  it('is accepted when it was answered after a correction, with the stopped query first', () => {
    const answer = answered()
    answer.attempts.unshift(stopped('SELECT nothing FROM nowhere', 'allowlist', 'unknown_table'))
    expect(answerSchema.safeParse(answer).success).toBe(true)
  })

  it('may leave the chart out, and the run unnamed', () => {
    expect(answerSchema.safeParse(answered({ chart: null })).success).toBe(true)
    expect(answerSchema.safeParse(answered({ with: { run_id: '' } })).success).toBe(true)
  })

  it('is refused when it has a field the board does not know the shape of', () => {
    expect(answerSchema.safeParse({ ...answered(), outcome: 'maybe' }).success).toBe(false)
    expect(answerSchema.safeParse({ ...answered(), as_of: 'yesterday' }).success).toBe(false)
    expect(answerSchema.safeParse({ ...answered(), run_id: '../etc/passwd' }).success).toBe(false)
    expect(answerSchema.safeParse({ ...answered(), remaining_questions: -1 }).success).toBe(false)
    expect(answerSchema.safeParse({ ...answered(), attempts: [{ sql: 'x', stopped_by: 'moat', rule: 'not_select', message: null }] }).success).toBe(false)
  })

  it('is refused when a row does not fit the columns or the count is not the rows', () => {
    const answer = answered()
    answer.result?.rows.push(['only one cell'])
    expect(answerSchema.safeParse(answer).success).toBe(false)
    const counted = answered()
    if (counted.result) counted.result.row_count = 7
    expect(answerSchema.safeParse(counted).success).toBe(false)
  })

  it('is refused when it is larger than the back end can make: too many rows, too long a text', () => {
    const wide = answered()
    if (wide.result) wide.result.rows = Array.from({ length: 1_001 }, () => ['a', 1])
    expect(answerSchema.safeParse(wide).success).toBe(false)
    expect(answerSchema.safeParse(answered({ with: { explanation: 'x'.repeat(2_001) } })).success).toBe(false)
    expect(answerSchema.safeParse(answered({ with: { message: 'x'.repeat(1_001) } })).success).toBe(false)
  })

  it('is refused when a layer comes without a rule or a rule without a layer', () => {
    const half = { sql: 'x', stopped_by: 'parse', rule: null, message: null }
    expect(answerSchema.safeParse({ ...refused(), attempts: [half] }).success).toBe(false)
  })
})

describe('an answer that contradicts itself', () => {
  it('is named as such: an answered question without its table, or ending on a stopped query', () => {
    expect(contradiction({ ...answered(), result: null })).toBeDefined()
    expect(contradiction({ ...answered(), attempts: [stopped('x', 'parse', 'not_select')] })).toBeDefined()
    expect(contradiction({ ...answered(), attempts: [] })).toBeDefined()
  })

  it('is named as such: a refused question without a stopped query, or a declined one with a table', () => {
    expect(contradiction({ ...refused(), attempts: [] })).toBeDefined()
    expect(contradiction({ ...declined(), explanation: 'Looks fine.' })).toBeDefined()
    expect(contradiction({ ...unavailable(), chart: answered().chart })).toBeDefined()
  })

  it('is not accepted by the answer schema', () => {
    expect(answerSchema.safeParse({ ...answered(), result: null }).success).toBe(false)
    expect(answerSchema.safeParse({ ...refused(), attempts: [] }).success).toBe(false)
  })

  it('does not name a consistent answer', () => {
    for (const answer of [answered(), declined(), refused(), unavailable()]) expect(contradiction(answer)).toBeUndefined()
  })
})

describe('the daily quota', () => {
  const quota = { used: 3, remaining: 22, resets_at: '2026-10-03T00:00:00+00:00', limits: { questions_per_day: 25, query_timeout_seconds: 5, row_cap: 1_000, max_model_calls_per_question: 5, question_deadline_seconds: 90 } }

  it('is read from the back end\'s account of the day, with its timezone offset', () => {
    expect(quotaSchema.safeParse(quota).success).toBe(true)
    expect(quotaFrom(quotaSchema.parse(quota))).toEqual({ limit: 25, used: 3, remaining: 22, resetsAt: '2026-10-03T00:00:00+00:00' })
  })

  it('is refused when a limit is missing or absurd', () => {
    expect(quotaSchema.safeParse({ ...quota, limits: { ...quota.limits, row_cap: 0 } }).success).toBe(false)
    expect(quotaSchema.safeParse({ ...quota, resets_at: 'soon' }).success).toBe(false)
  })
})

describe('the semantic layer', () => {
  const layer = {
    version: 1,
    as_of: '2026-10-01',
    tables: [{ name: 'orders', description: 'One row per order.', columns: [{ name: 'status', type: 'text', description: 'Where the order is.', values: ['shipped', 7], nullable: false }] }],
    joins: [{ left: 'orders.customer_id', right: 'customers.customer_id' }],
    metrics: [{ name: 'revenue', label: 'Revenue', description: 'Money in CZK.', kind: 'expression', definition: 'SUM(order_lines.line_total_czk)', needs: ['orders'], synonyms: ['sales'] }],
    dimensions: [{ name: 'month', description: 'Calendar month.', expression: 'DATE_TRUNC(\'month\', orders.ordered_at)', needs: ['orders'], synonyms: ['monthly'] }],
    ranges: [{ name: 'last_quarter', label: 'last quarter', start: '2026-07-01', end: '2026-09-30' }],
  }

  it('is accepted in the shape the back end serves it', () => {
    expect(semanticLayerSchema.safeParse(layer).success).toBe(true)
  })

  it('is refused when a metric is of a kind the board does not know', () => {
    const bad = { ...layer, metrics: [{ ...layer.metrics[0], kind: 'magic' }] }
    expect(semanticLayerSchema.safeParse(bad).success).toBe(false)
  })
})
