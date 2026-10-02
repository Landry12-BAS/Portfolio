// Builders for the answers and charts LB-05's tests need, shaped as the back end shapes them
// (services/flask-systems/lb05/api.py and chart.py): a bar, a line and a point chart in the subset the
// back end writes, an answered question with its table, and the ways a question can end otherwise.
// They are test data, not recordings: nothing here was measured.
import type { Answer, Attempt, ChartEnvelope } from '~/boards/lb-05/schemas'

/** The address of the one schema the back end writes. */
const SCHEMA_URL = 'https://vega.github.io/schema/vega-lite/v5.json'

/** Writes a bar chart of three products' revenue. */
export function barChart(): ChartEnvelope {
  return {
    kind: 'bar',
    omitted_rows: 0,
    spec: {
      $schema: SCHEMA_URL,
      description: 'A bar chart of revenue by product.',
      data: { values: [{ x: 'Basalt Blend', y: 182400 }, { x: 'Ethiopia Guji', y: 141200 }, { x: 'Kenya Nyeri', y: 96300 }] },
      mark: { type: 'bar', tooltip: true },
      encoding: {
        x: { field: 'x', type: 'nominal', title: 'product', sort: ['Basalt Blend', 'Ethiopia Guji', 'Kenya Nyeri'] },
        y: { field: 'y', type: 'quantitative', title: 'revenue' },
      },
      width: 'container',
      height: 280,
    },
  }
}

/** Writes a line chart of two countries' revenue by month. */
export function lineChart(): ChartEnvelope {
  const months = ['2025-01-01', '2025-02-01', '2025-03-01', '2025-04-01']
  return {
    kind: 'line',
    omitted_rows: 0,
    spec: {
      $schema: SCHEMA_URL,
      description: 'A line chart of revenue by month.',
      data: {
        values: months.flatMap((month, index) => [
          { x: month, y: 120000 + index * 9000, series: 'CZ' },
          { x: month, y: 40000 + index * 3000, series: 'SK' },
        ]),
      },
      mark: { type: 'line', tooltip: true },
      encoding: {
        x: { field: 'x', type: 'temporal', title: 'month' },
        y: { field: 'y', type: 'quantitative', title: 'revenue' },
        color: { field: 'series', type: 'nominal', title: 'country' },
      },
      width: 'container',
      height: 280,
    },
  }
}

/** Writes a point chart of two quantities. */
export function pointChart(): ChartEnvelope {
  return {
    kind: 'point',
    omitted_rows: 0,
    spec: {
      $schema: SCHEMA_URL,
      description: 'A point chart of orders by revenue.',
      data: { values: [{ x: 10, y: 1200 }, { x: 24, y: 2600 }, { x: 31, y: 3300 }] },
      mark: { type: 'point', tooltip: true },
      encoding: {
        x: { field: 'x', type: 'quantitative', title: 'orders' },
        y: { field: 'y', type: 'quantitative', title: 'revenue' },
      },
      width: 'container',
      height: 280,
    },
  }
}

/** What a test may change about an answered question. */
export interface AnsweredOptions {
  // The chart the answer carries: a bar chart by default, or none.
  chart?: ChartEnvelope | null
  // Fields to replace in the answer.
  with?: Partial<Answer>
}

/** Writes the answer to a question that ran: three products' revenue, with a bar chart and an explanation. */
export function answered(options: AnsweredOptions = {}): Answer {
  return {
    run_id: 'run-0123456789abcdef0123',
    outcome: 'answered',
    as_of: '2026-10-01',
    model_calls: 2,
    elapsed_ms: 4200,
    attempts: [{ sql: 'SELECT products.name AS product, SUM(order_lines.line_total_czk) AS revenue FROM order_lines JOIN products ON products.product_id = order_lines.product_id GROUP BY products.name', stopped_by: null, rule: null, message: null }],
    message: null,
    result: {
      sql: 'SELECT products.name AS product, SUM(order_lines.line_total_czk) AS revenue FROM order_lines AS order_lines JOIN products AS products ON products.product_id = order_lines.product_id GROUP BY products.name LIMIT 1000',
      columns: [{ name: 'product', kind: 'text' }, { name: 'revenue', kind: 'integer' }],
      rows: [['Basalt Blend', 182400], ['Ethiopia Guji', 141200], ['Kenya Nyeri', 96300]],
      row_count: 3,
      truncated: false,
      elapsed_ms: 38,
      tables: ['order_lines', 'products'],
      joins: 1,
    },
    chart: options.chart === undefined ? barChart() : options.chart,
    explanation: 'Basalt Blend earned the most, 182,400 CZK, followed by Ethiopia Guji and Kenya Nyeri.',
    explanation_source: 'model',
    remaining_questions: 24,
    ...options.with,
  }
}

/** Writes one attempt a layer stopped. */
export function stopped(sql: string, layer: NonNullable<Attempt['stopped_by']>, rule: NonNullable<Attempt['rule']>, message = 'Only a SELECT is accepted.'): Attempt {
  return { sql, stopped_by: layer, rule, message }
}

/** Writes the answer to a question whose query a layer stopped for good. */
export function refused(attempt: Attempt = stopped('DROP TABLE orders', 'parse', 'not_select')): Answer {
  return {
    run_id: 'run-0123456789abcdef0123',
    outcome: 'refused',
    as_of: '2026-10-01',
    model_calls: 1,
    elapsed_ms: 1800,
    attempts: [attempt],
    message: `Stopped by the ${attempt.stopped_by} check (${attempt.rule}): ${attempt.message}`,
    result: null,
    chart: null,
    explanation: null,
    explanation_source: null,
    remaining_questions: 23,
  }
}

/** Writes the answer to a question the model said the data cannot answer. */
export function declined(reason = 'The data has no salaries.'): Answer {
  return { ...refused(), outcome: 'declined', attempts: [], message: reason, model_calls: 1 }
}

/** Writes the answer to a question the service could not answer right now, which is not counted. */
export function unavailable(): Answer {
  return {
    ...refused(),
    outcome: 'unavailable',
    attempts: [],
    message: 'The language models are not answering right now, so this question was not counted.',
    model_calls: 1,
    remaining_questions: 25,
  }
}
