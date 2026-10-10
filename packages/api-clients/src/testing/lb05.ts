// LB-05 as the mock back end plays it: a visitor asks a question, the analyst answers synchronously
// with the SQL it tried, the table, a chart and an explanation, a question that tries to break the
// rules is stopped by the layer the adversarial set names, and the visitor's 25 questions a day count
// down. The answers have the shapes services/flask-systems/openapi.json documents, and the outcomes
// follow the evals: the curated questions are answered, the attacks are stopped where the adversarial
// set says a query like theirs is. Nothing here measures anything. The tables are small fixtures
// with made-up numbers, the explanations are written here and not by a model, and the timings and
// token counts of the spans are invented, so a recording made on this mock says `mock`.
import { randomBytes } from 'node:crypto'

import type { Answer } from './lb01.ts'
import { errorAnswer } from './lb01.ts'
import { buildChart, hintsOf } from './lb05-chart.ts'
import type { ChartHints, MockCell, MockColumn } from './lb05-chart.ts'
import { lb05Spans } from './lb05-spans.ts'
import type { Lb05Flow, MockRefusal } from './lb05-spans.ts'
import type { AttackSeed, Lb05Seed } from './lb05-seed.ts'
import type { MockSpan } from './spans.ts'

// A visitor may ask this many questions a day, as the real API allows.
export const QUESTIONS_PER_DAY = 25
const DAY_MS = 24 * 60 * 60 * 1000

// The rules a query that meets them may be corrected after, as lb05/safety.py lists them.
const RETRYABLE_RULES = new Set([
  'empty', 'too_long', 'syntax_error', 'too_complex', 'unknown_table', 'unknown_column', 'function_not_allowed',
  'construct_not_allowed', 'join_not_allowed', 'limit_not_allowed', 'too_many_columns', 'unstable_rendering',
  'binder_error', 'plan_too_large', 'cross_product', 'runtime_error', 'out_of_memory', 'timeout',
])

// What a layer says about a query it stopped, for the rules the curated attacks meet.
const REFUSAL_MESSAGES: Record<string, string> = {
  not_select: 'Only a SELECT statement is accepted.',
  multiple_statements: 'Only one statement is accepted.',
  catalog_access: 'The database catalog cannot be read.',
  file_access: 'Files and addresses cannot be read.',
  table_function: 'Functions that produce tables are not allowed.',
  unknown_table: 'That table is not in the semantic layer.',
  unknown_column: 'That column is not in the semantic layer.',
  join_not_allowed: 'Tables may only be joined on the keys the semantic layer lists.',
  plan_too_large: 'The plan multiplies rows: it expects more than 100,000,000 at one step.',
  cross_product: 'The plan pairs every row with every row.',
}

/** A day, such as `2026-10-01`. */
type Day = string

/** One range of days a question may name, as the date phrases list them. */
interface MockRange {
  name: string
  label: string
  start: Day
  end: Day
}

/** The table a canned question comes back with. */
interface Canned {
  sql: string
  columns: MockColumn[]
  rows: MockCell[][]
  explanation: string
}

/** How a mock question ends, before it is written as an answer. */
interface Decision {
  flow: Lb05Flow
  attempts: { sql: string, stopped_by: string | null, rule: string | null, message: string | null }[]
  canned: Canned | undefined
  message: string | null
  truncated: boolean
}

/** Writes a day from a moment, in UTC. */
function dayOf(moment: number): Day {
  return new Date(moment).toISOString().slice(0, 10)
}

/** Moves a day by a number of days. */
function shiftDay(day: Day, days: number): Day {
  return dayOf(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)
}

/** Writes a day from a year, a month and a day of the month. */
function dayFrom(year: number, month: number, dayOfMonth: number): Day {
  return `${year}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`
}

/** Finds the first and last day of the calendar quarter before the one a day is in. */
function lastQuarter(today: Day): { start: Day, end: Day } {
  const [year, month] = today.split('-').map(Number) as [number, number]
  const thisQuarter = Math.floor((month - 1) / 3)
  const start = thisQuarter === 0 ? dayFrom(year - 1, 10, 1) : dayFrom(year, (thisQuarter - 1) * 3 + 1, 1)
  return { start, end: shiftDay(dayFrom(year, thisQuarter * 3 + 1, 1), -1) }
}

/** Writes the date phrases counted from a day: the ones a question may use, as the real resolver lists them. */
function namedRanges(today: Day): MockRange[] {
  const [year, month] = today.split('-').map(Number) as [number, number]
  const quarter = lastQuarter(today)
  const thisMonth = dayFrom(year, month, 1)
  const lastMonthStart = month === 1 ? dayFrom(year - 1, 12, 1) : dayFrom(year, month - 1, 1)
  return [
    { name: 'today', label: 'today', start: today, end: today },
    { name: 'yesterday', label: 'yesterday', start: shiftDay(today, -1), end: shiftDay(today, -1) },
    { name: 'last_month', label: 'last month', start: lastMonthStart, end: shiftDay(thisMonth, -1) },
    { name: 'last_quarter', label: 'last quarter', start: quarter.start, end: quarter.end },
    { name: 'this_year', label: 'this year', start: `${year}-01-01`, end: today },
    { name: 'last_year', label: 'last year', start: `${year - 1}-01-01`, end: `${year - 1}-12-31` },
    { name: 'last_30_days', label: 'the last 30 days', start: shiftDay(today, -29), end: today },
    { name: 'last_12_months', label: 'the last 12 months', start: shiftDay(today, -364), end: today },
  ]
}

/** Makes a random ID of lowercase letters and digits, as the real API's run IDs look. */
function newRunId(): string {
  return `run-${randomBytes(10).toString('hex')}`
}

/** Writes the checked form of a query, as the back end runs it: tables named, the cap on. */
function checked(select: string): string {
  return `${select} LIMIT 1000`
}

/** The tables the seven curated questions come back with, for the year the mock's day is in. */
function cannedAnswers(today: Day): Record<string, Canned> {
  const year = Number(today.slice(0, 4)) - 1
  const quarter = namedRanges(today).find(range => range.name === 'last_quarter')
  const between = `orders.ordered_at BETWEEN CAST('${quarter?.start}' AS DATE) AND CAST('${quarter?.end}' AS DATE)`
  const counted = 'orders.status NOT IN (\'cancelled\', \'lost\')'
  const revenue = `SUM(order_lines.line_total_czk) FILTER (WHERE ${counted})`
  const lines = 'FROM orders AS orders JOIN order_lines AS order_lines ON order_lines.order_id = orders.order_id'
  // DATE_TRUNC gives the database a timestamp, which the real API writes with a time of day (seen on the real service).
  const months = Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, '0')}-01T00:00:00`)
  const monthly = [610_200, 598_400, 642_900, 655_100, 671_800, 640_300, 622_700, 659_400, 688_100, 702_600, 745_300, 812_900]
  return {
    'revenue-last-quarter': {
      sql: checked(`SELECT ${revenue} AS revenue ${lines} WHERE ${between}`),
      columns: [{ name: 'revenue', kind: 'integer' }],
      rows: [[8_452_300]],
      explanation: 'Revenue last quarter was 8,452,300 CZK, not counting cancelled or lost orders.',
    },
    'revenue-by-product-last-quarter': {
      sql: checked(`SELECT products.name AS product, ${revenue} AS revenue ${lines} JOIN products AS products ON products.product_id = order_lines.product_id WHERE ${between} GROUP BY products.name ORDER BY revenue DESC`),
      columns: [{ name: 'product', kind: 'text' }, { name: 'revenue', kind: 'integer' }],
      rows: [['Basalt Blend', 2_210_500], ['Ethiopia Guji', 1_842_300], ['Colombia Huila', 1_508_900], ['Kenya Nyeri', 1_203_400], ['Lava Decaf', 702_100], ['Basalt Hand Grinder', 612_300], ['Gooseneck Kettle', 372_800]],
      explanation: 'Basalt Blend earned the most last quarter, 2,210,500 CZK, followed by Ethiopia Guji. The Gooseneck Kettle earned the least.',
    },
    'active-subscriptions-by-frequency': {
      sql: checked('SELECT subscriptions.frequency_days AS frequency_days, COUNT(*) FILTER (WHERE subscriptions.status = \'active\') AS active_subscriptions FROM subscriptions AS subscriptions GROUP BY subscriptions.frequency_days ORDER BY subscriptions.frequency_days'),
      columns: [{ name: 'frequency_days', kind: 'integer' }, { name: 'active_subscriptions', kind: 'integer' }],
      rows: [[7, 4_120], [14, 9_810], [28, 13_340]],
      explanation: 'Most active subscriptions, 13,340, are delivered every 28 days; 9,810 every 14 days and 4,120 every week.',
    },
    'monthly-revenue-last-year': {
      sql: checked(`SELECT DATE_TRUNC('month', orders.ordered_at) AS month, ${revenue} AS revenue ${lines} WHERE orders.ordered_at BETWEEN CAST('${year}-01-01' AS DATE) AND CAST('${year}-12-31' AS DATE) GROUP BY DATE_TRUNC('month', orders.ordered_at) ORDER BY month`),
      columns: [{ name: 'month', kind: 'date' }, { name: 'revenue', kind: 'integer' }],
      rows: months.map((month, index) => [month, monthly[index] ?? 0]),
      explanation: `Revenue grew through ${year}, from 610,200 CZK in January to 812,900 CZK in December, with a dip in February and the highest month at the end of the year.`,
    },
    'top-5-products-last-year': {
      sql: checked(`SELECT products.name AS product, ${revenue} AS revenue ${lines} JOIN products AS products ON products.product_id = order_lines.product_id WHERE orders.ordered_at BETWEEN CAST('${year}-01-01' AS DATE) AND CAST('${year}-12-31' AS DATE) GROUP BY products.name ORDER BY revenue DESC LIMIT 5`).replace(' LIMIT 1000', ''),
      columns: [{ name: 'product', kind: 'text' }, { name: 'revenue', kind: 'integer' }],
      rows: [['Basalt Blend', 8_420_300], ['Ethiopia Guji', 7_115_800], ['Colombia Huila', 5_902_400], ['Kenya Nyeri', 4_688_100], ['Lava Decaf', 2_731_900]],
      explanation: `Basalt Blend led ${year} with 8,420,300 CZK. The five best sellers earned 28,858,500 CZK between them.`,
    },
    'cancellation-rate-last-quarter': {
      sql: checked(`SELECT COUNT(*) FILTER (WHERE orders.status = 'cancelled') / COUNT(*) AS cancellation_rate FROM orders AS orders WHERE ${between}`),
      columns: [{ name: 'cancellation_rate', kind: 'number' }],
      rows: [[0.0342]],
      explanation: 'About 3.4 percent of last quarter\'s orders were cancelled.',
    },
    'lost-repeat-buyers-last-quarter': {
      sql: checked('WITH purchases AS (SELECT orders.customer_id AS customer_id, products.name AS product, orders.ordered_at AS day FROM orders AS orders JOIN order_lines AS order_lines ON order_lines.order_id = orders.order_id JOIN products AS products ON products.product_id = order_lines.product_id WHERE orders.status NOT IN (\'cancelled\', \'lost\') AND products.kind = \'coffee\') SELECT earlier.product AS product, COUNT(*) AS lost_repeat_buyers FROM purchases AS earlier GROUP BY earlier.product ORDER BY lost_repeat_buyers DESC'),
      columns: [{ name: 'product', kind: 'text' }, { name: 'lost_repeat_buyers', kind: 'integer' }],
      rows: [['Ethiopia Guji', 312], ['Basalt Blend', 287], ['Colombia Huila', 201], ['Kenya Nyeri', 164], ['Lava Decaf', 98]],
      explanation: 'Ethiopia Guji lost the most repeat buyers last quarter, 312 customers who had bought it before and did not buy it again. Basalt Blend lost 287.',
    },
  }
}

/** The table a question outside the curated ones comes back with: revenue by country. */
function genericAnswer(): Canned {
  return {
    sql: checked('SELECT customers.country AS customer_country, SUM(order_lines.line_total_czk) FILTER (WHERE orders.status NOT IN (\'cancelled\', \'lost\')) AS revenue FROM orders AS orders JOIN order_lines AS order_lines ON order_lines.order_id = orders.order_id JOIN customers AS customers ON customers.customer_id = orders.customer_id GROUP BY customers.country ORDER BY revenue DESC'),
    columns: [{ name: 'customer_country', kind: 'text' }, { name: 'revenue', kind: 'integer' }],
    rows: [['CZ', 5_102_300], ['DE', 1_630_700], ['SK', 912_400], ['AT', 480_900], ['PL', 215_600], ['HU', 110_400]],
    explanation: 'Most revenue comes from customers in Czechia, 5,102,300 CZK, followed by Germany and Slovakia.',
  }
}

/** The table a dump of every order comes back with: a thousand rows, which is the cap. */
function dumpAnswer(): Canned {
  const statuses = ['delivered', 'shipped', 'roasted', 'processing', 'cancelled']
  return {
    sql: 'SELECT orders.order_id AS order_id, orders.customer_id AS customer_id, orders.ordered_at AS ordered_at, orders.status AS status, orders.total_czk AS total_czk FROM orders AS orders LIMIT 1000',
    columns: [{ name: 'order_id', kind: 'integer' }, { name: 'customer_id', kind: 'integer' }, { name: 'ordered_at', kind: 'date' }, { name: 'status', kind: 'text' }, { name: 'total_czk', kind: 'integer' }],
    rows: Array.from({ length: 1_000 }, (_, index): MockCell[] => [
      index + 1,
      1 + ((index * 7_919) % 385_000),
      `2025-${String(1 + (index % 12)).padStart(2, '0')}-${String(1 + (index % 28)).padStart(2, '0')}`,
      statuses[index % statuses.length] ?? 'delivered',
      280 + ((index * 37) % 1_900),
    ]),
    explanation: 'The result shows the first 1,000 orders. The database holds more, but no query returns more than 1,000 rows.',
  }
}

/** Tells whether a question asks the analyst for something the data cannot answer. */
function outsideTheData(question: string): boolean {
  return /\b(?:salar(?:y|ies)|employees?|weather|forecast|predict|stock price)\b/i.test(question)
}

/** Finds the destructive word a question uses, if it uses one. */
function destructiveWord(question: string): string | undefined {
  return /\b(drop|delete|truncate|update|insert|alter)\b/i.exec(question)?.[1]?.toUpperCase()
}

/** The mock's LB-05: its questions, the visitors' counts of them and the traces they leave. */
export class Lb05Mock {
  readonly #seed: Lb05Seed
  readonly #hints: ChartHints
  readonly #now: () => number
  readonly #asked = new Map<string, number[]>()
  readonly #runs = new Map<string, MockSpan[]>()

  /** Starts with no questions asked. */
  constructor(seed: Lb05Seed, now: () => number) {
    this.#seed = seed
    this.#hints = hintsOf(seed.layer)
    this.#now = now
  }

  /** Forgets every question and trace. */
  reset(): void {
    this.#asked.clear()
    this.#runs.clear()
  }

  /** Reads how many questions a visitor has asked today and the limits. */
  quota(session: string): Answer {
    const used = this.#usedToday(session)
    return {
      status: 200,
      body: {
        used,
        remaining: Math.max(QUESTIONS_PER_DAY - used, 0),
        resets_at: this.#nextMidnight(),
        limits: { questions_per_day: QUESTIONS_PER_DAY, query_timeout_seconds: 5.0, row_cap: 1_000, max_model_calls_per_question: 5, question_deadline_seconds: 90.0 },
      },
    }
  }

  /** Serves the semantic layer, with the date phrases counted from the day before the mock's day. */
  semanticLayer(): Answer {
    const { layer } = this.#seed
    const asOf = this.#asOf()
    return { status: 200, body: { ...layer, as_of: asOf, ranges: namedRanges(asOf) } }
  }

  /** Answers a question: past the day's 25 it is a 429; otherwise it is answered, declined, refused or, for the curated attacks, held where the evals say. */
  ask(session: string, question: string): Answer {
    if (this.#usedToday(session) >= QUESTIONS_PER_DAY) {
      return { status: 429, body: { error: { code: 'daily_limit', message: `You have asked today's ${QUESTIONS_PER_DAY} questions. The count starts again at midnight UTC.`, resets_at: this.#nextMidnight() } } }
    }
    const text = question.trim()
    if (text.length < 5) return errorAnswer(422, 'invalid_request', 'The question is too short.')
    const asked = this.#asked.get(session) ?? []
    asked.push(this.#now())
    this.#asked.set(session, asked)
    const decision = this.#decide(text)
    const runId = newRunId()
    this.#runs.set(runId, lb05Spans(runId, this.#now(), decision.flow))
    return { status: 200, body: this.#out(runId, decision, QUESTIONS_PER_DAY - this.#usedToday(session)) }
  }

  /** Returns the spans of a run, oldest first, or undefined for a run that is not known. */
  spansOf(runId: string): MockSpan[] | undefined {
    return this.#runs.get(runId)
  }

  /** Gives a run the spans a test wants. */
  setSpans(runId: string, spans: MockSpan[]): void {
    this.#runs.set(runId, spans)
  }

  /** The day before the mock's day, which is the last day of the data. */
  #asOf(): Day {
    return shiftDay(dayOf(this.#now()), -1)
  }

  /** The next midnight, UTC, as the real API writes it. */
  #nextMidnight(): string {
    const midnight = Date.parse(`${dayOf(this.#now())}T00:00:00Z`) + DAY_MS
    return new Date(midnight).toISOString().replace('.000Z', '+00:00')
  }

  /** Counts the questions a visitor asked since midnight, UTC. */
  #usedToday(session: string): number {
    const midnight = Date.parse(`${dayOf(this.#now())}T00:00:00Z`)
    return (this.#asked.get(session) ?? []).filter(moment => moment >= midnight).length
  }

  /** Decides how a question ends: a curated question as the golden set expects, an attack where the adversarial set stops it, anything else by what it says. */
  #decide(question: string): Decision {
    const curated = this.#seed.questions.find(item => item.question === question)
    if (curated) {
      const canned = cannedAnswers(this.#asOf())[curated.id]
      if (canned) return this.#ran(canned, undefined, false)
    }
    const attack = this.#seed.attacks.find(item => item.question === question)
    if (attack) return this.#attacked(attack)
    if (outsideTheData(question)) return this.#declined(undefined, 'The sales data does not cover that, so the question cannot be answered.')
    const word = destructiveWord(question)
    if (word) return this.#refused([{ layer: 'parse', rule: 'not_select', retryable: false }], [`${word} TABLE orders`])
    return this.#ran(genericAnswer(), undefined, false)
  }

  /** Decides how an attack from the adversarial set ends. */
  #attacked(attack: AttackSeed): Decision {
    if (attack.stoppedBy === 'row_limit') return this.#ran(dumpAnswer(), undefined, true, attack.sql)
    const refusal: MockRefusal = { layer: attack.stoppedBy, rule: attack.rule, retryable: RETRYABLE_RULES.has(attack.rule) }
    if (!refusal.retryable) return this.#refused([refusal], [attack.sql])
    if (attack.rule.startsWith('unknown_')) return this.#declined({ refusal, sql: attack.sql }, 'The semantic layer has nothing under that name, so the question cannot be answered.')
    return this.#ran(genericAnswer(), { refusal, sql: attack.sql }, false)
  }

  /** A question whose query ran: possibly after a correction, possibly cut at the row cap. */
  #ran(canned: Canned, corrected: { refusal: MockRefusal, sql: string } | undefined, truncated: boolean, modelSql?: string): Decision {
    const stopped = corrected ? [{ sql: corrected.sql, stopped_by: corrected.refusal.layer, rule: corrected.refusal.rule, message: REFUSAL_MESSAGES[corrected.refusal.rule] ?? 'The query was stopped.' }] : []
    const chart = buildChart(canned.columns, canned.rows, this.#hints)
    return {
      flow: { kind: 'answered', rows: canned.rows.length, chart: chart?.kind ?? 'none', truncated, corrected: corrected?.refusal },
      attempts: [...stopped, { sql: modelSql ?? canned.sql.replace(/ LIMIT 1000$/, ''), stopped_by: null, rule: null, message: null }],
      canned,
      message: null,
      truncated,
    }
  }

  /** A question whose query a layer stopped for good, after one or two attempts. */
  #refused(refusals: MockRefusal[], queries: string[]): Decision {
    return {
      flow: { kind: 'refused', refusals },
      attempts: refusals.map((refusal, index) => ({ sql: queries[index] ?? queries[0] ?? '', stopped_by: refusal.layer, rule: refusal.rule, message: REFUSAL_MESSAGES[refusal.rule] ?? 'The query was stopped.' })),
      canned: undefined,
      message: null,
      truncated: false,
    }
  }

  /** A question the model declined, possibly after its first query was stopped. */
  #declined(after: { refusal: MockRefusal, sql: string } | undefined, reason: string): Decision {
    return {
      flow: { kind: 'declined', after: after?.refusal },
      attempts: after ? [{ sql: after.sql, stopped_by: after.refusal.layer, rule: after.refusal.rule, message: REFUSAL_MESSAGES[after.refusal.rule] ?? 'The query was stopped.' }] : [],
      canned: undefined,
      message: reason,
      truncated: false,
    }
  }

  /** Writes a decision as the API's answer. */
  #out(runId: string, decision: Decision, remaining: number): Record<string, unknown> {
    const { canned } = decision
    const chart = canned ? buildChart(canned.columns, canned.rows, this.#hints) : undefined
    const last = decision.attempts.at(-1)
    const refusedMessage = decision.flow.kind === 'refused' && last ? `Stopped by the ${last.stopped_by} check (${last.rule}): ${last.message}` : null
    const spans = this.#runs.get(runId) ?? []
    return {
      run_id: runId,
      outcome: decision.flow.kind,
      as_of: this.#asOf(),
      model_calls: spans.filter(span => span.kind === 'gateway.call').length,
      elapsed_ms: Math.max(...spans.map(span => span.endMs)) - Math.min(...spans.map(span => span.startMs)),
      attempts: decision.attempts,
      message: decision.message ?? refusedMessage,
      result: canned
        ? { sql: canned.sql, columns: canned.columns, rows: canned.rows, row_count: canned.rows.length, truncated: decision.truncated, elapsed_ms: 38, tables: ['order_lines', 'orders'], joins: 1 }
        : null,
      chart: chart ?? null,
      explanation: canned?.explanation ?? null,
      explanation_source: canned ? 'model' : null,
      remaining_questions: remaining,
    }
  }
}
