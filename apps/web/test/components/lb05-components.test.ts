// Tests of the parts of LB-05's board one at a time: the SQL block that never makes markup from a
// query, the chain of steps, the wait with its clock, the question box, the result table with its
// thousand rows, the chart panel (which refuses what it does not trust and hands the rest to the
// drawing), the semantic layer browser and the answer in each way a question can end.
import { Lb05Mock, readLb05Seed } from '@lb/api-clients/testing'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_LIMITS } from '~/boards/lb-05/limits'
import type { PipelineStep } from '~/boards/lb-05/pipeline'
import { semanticLayerSchema } from '~/boards/lb-05/schemas'
import type { QueryResult } from '~/boards/lb-05/schemas'

import AnswerView from '~/boards/lb-05/components/AnswerView.vue'
import AskProgress from '~/boards/lb-05/components/AskProgress.vue'
import AttemptList from '~/boards/lb-05/components/AttemptList.vue'
import ChainSteps from '~/boards/lb-05/components/ChainSteps.vue'
import ChartPanel from '~/boards/lb-05/components/ChartPanel.vue'
import QuestionBox from '~/boards/lb-05/components/QuestionBox.vue'
import ResultTable from '~/boards/lb-05/components/ResultTable.vue'
import SemanticBrowser from '~/boards/lb-05/components/SemanticBrowser.vue'
import SqlBlock from '~/boards/lb-05/components/SqlBlock.vue'

import { answered, barChart, declined, lineChart, pointChart, refused, stopped, unavailable } from '../support/lb05'
import { mountWithSite } from '../support/mount'

// The drawing has its own tests; here the panel's part is checked. A test can make the drawing fail.
const drawing = vi.hoisted(() => ({
  calls: [] as unknown[][],
  fails: false,
  tokens: { sheet: 'sheet', ink: 'ink', graphite: 'graphite', rule: 'rule', fontSans: 'sans', fontMono: 'mono', series: ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'] },
}))

vi.mock('~/boards/lb-05/chart/render', () => ({
  drawChart: vi.fn((...args: unknown[]) => {
    drawing.calls.push(args)
    return drawing.fails ? Promise.reject(new Error('The drawing failed.')) : Promise.resolve({ resize: vi.fn(), destroy: vi.fn() })
  }),
}))

vi.mock('~/boards/lb-05/chart/theme', async (importOriginal) => {
  const original = await importOriginal<typeof import('~/boards/lb-05/chart/theme')>()
  return { ...original, readChartTokens: () => drawing.tokens }
})

const NOW = Date.parse('2026-10-02T09:30:00.000Z')

/** Writes the seven steps of the chain, all in one state. */
function stepsAll(state: PipelineStep['state']): PipelineStep[] {
  return Array.from({ length: 7 }, (_, index) => ({ index, state, runs: 1, layer: undefined, rule: undefined }))
}

beforeEach(() => {
  drawing.calls.length = 0
  drawing.fails = false
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the SQL block', () => {
  it('shows a query as text in spans and makes no markup from it, whatever the query says', () => {
    const sql = '-- </code></pre><script>alert(1)</script>\nSELECT \'<img src=x onerror=alert(1)>\' AS note, 42 AS answer'
    const wrapper = mountWithSite(SqlBlock, { props: { sql, label: 'The query that ran' } })
    expect(wrapper.get('[data-testid="sql-text"]').text()).toBe(sql)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.findAll('.tok--keyword').map(token => token.text())).toEqual(['SELECT', 'AS', 'AS'])
    expect(wrapper.findAll('.tok--comment')).toHaveLength(1)
    expect(wrapper.findAll('.tok--number').map(token => token.text())).toEqual(['42'])
  })

  it('is a region the keyboard can reach, named for what it holds', () => {
    const wrapper = mountWithSite(SqlBlock, { props: { sql: 'SELECT 1', label: 'The query that ran' } })
    const region = wrapper.get('[role="region"]')
    expect(region.attributes('tabindex')).toBe('0')
    expect(region.attributes('aria-label')).toBe('The query that ran')
  })

  it('copies the query exactly as it is and says it was copied', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const sql = 'SELECT products.name AS product\nFROM products'
    const wrapper = mountWithSite(SqlBlock, { props: { sql, label: 'The query that ran' } })
    await flushPromises()
    await wrapper.get('[data-testid="sql-copy"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(sql)
    expect(wrapper.get('[role="status"]').text()).toBe('SQL copied')
  })

  it('offers no copy button where there is no clipboard, and when asked to leave it out', async () => {
    vi.stubGlobal('navigator', {})
    const without = mountWithSite(SqlBlock, { props: { sql: 'SELECT 1', label: 'x' } })
    await flushPromises()
    expect(without.find('[data-testid="sql-copy"]').exists()).toBe(false)
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } })
    const asked = mountWithSite(SqlBlock, { props: { sql: 'SELECT 1', label: 'x', noCopy: true } })
    await flushPromises()
    expect(asked.find('[data-testid="sql-copy"]').exists()).toBe(false)
  })
})

describe('the attempts', () => {
  it('lists every query with what became of it, and shows the layer\'s message as text', () => {
    const attempts = [stopped('SELECT 1; DROP TABLE orders', 'parse', 'multiple_statements', 'Only one <b>statement</b> is accepted.'), { sql: 'SELECT 1', stopped_by: null, rule: null, message: null }]
    const wrapper = mountWithSite(AttemptList, { props: { attempts } })
    const verdicts = wrapper.findAll('[data-testid="attempt-verdict"]').map(verdict => verdict.text())
    expect(verdicts[0]).toBe('Stopped by the Parse layer: More than one statement')
    expect(verdicts[1]).toBe('Ran')
    expect(wrapper.get('[data-testid="attempt-message"]').text()).toBe('Only one <b>statement</b> is accepted.')
    expect(wrapper.find('b').exists()).toBe(false)
  })
})

describe('the chain of steps', () => {
  it('marks every step from the trace and names the steps in the visitor\'s language', () => {
    const labels = ['one', 'two', 'three', 'four', 'five', 'six', 'seven']
    const steps = stepsAll('done')
    steps[5] = { ...steps[5]!, state: 'skipped', runs: 0 }
    const wrapper = mountWithSite(ChainSteps, { props: { steps, labels, blind: false } })
    expect(wrapper.findAll('[data-testid="chain-step"]').map(step => step.attributes('data-state'))).toEqual(['done', 'done', 'done', 'done', 'done', 'skipped', 'done'])
    expect(wrapper.text()).toContain('one')
    expect(wrapper.text()).toContain('skipped')
  })

  it('calls no step done, running or skipped while the trace has not arrived', () => {
    const wrapper = mountWithSite(ChainSteps, { props: { steps: stepsAll('done'), labels: Array.from({ length: 7 }, () => 'x'), blind: true } })
    expect(wrapper.findAll('[data-testid="chain-step"]').every(step => step.attributes('data-state') === 'waiting')).toBe(true)
  })

  it('says which layer and rule stopped the query at a step, that self-correct followed a stop, and how often a step ran', () => {
    const steps = stepsAll('done')
    steps[2] = { index: 2, state: 'failed', runs: 1, layer: 'parse', rule: 'not_select' }
    steps[1] = { ...steps[1]!, runs: 2 }
    steps[5] = { index: 5, state: 'done', runs: 1, layer: 'allowlist', rule: 'unknown_column' }
    const wrapper = mountWithSite(ChainSteps, { props: { steps, labels: Array.from({ length: 7 }, (_, index) => `step ${index}`), blind: false } })
    const text = wrapper.findAll('[data-testid="chain-step"]').map(step => step.text())
    expect(text[2]).toContain('stopped by Parse: Not a SELECT')
    expect(text[1]).toContain('ran 2 times')
    expect(text[5]).toContain('after Allowlist: Column not in the layer')
  })

  it('does not trust a layer or rule in the trace that the board has no words for', () => {
    const steps = stepsAll('done')
    steps[2] = { index: 2, state: 'failed', runs: 1, layer: '<b>bogus</b>', rule: 'made_up' }
    const wrapper = mountWithSite(ChainSteps, { props: { steps, labels: Array.from({ length: 7 }, () => 'x'), blind: false } })
    expect(wrapper.text()).not.toContain('bogus')
    expect(wrapper.text()).not.toContain('made_up')
  })
})

describe('the wait', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('counts the seconds used of the seconds a question is given, as a clock and not an estimate', async () => {
    const wrapper = mountWithSite(AskProgress, { props: { startedAt: NOW, totalSeconds: 90, replaying: false, now: NOW } })
    expect(wrapper.get('[data-testid="elapsed"]').text()).toBe('Time used: 0 s of the 90 s a question is given')
    await vi.advanceTimersByTimeAsync(7_000)
    expect(wrapper.get('[data-testid="elapsed"]').text()).toBe('Time used: 7 s of the 90 s a question is given')
    expect(wrapper.find('[data-testid="slow"]').exists()).toBe(false)
  })

  it('says a wait of half a minute is longer than usual, and never counts past the seconds a question is given', async () => {
    const wrapper = mountWithSite(AskProgress, { props: { startedAt: NOW, totalSeconds: 90, replaying: false, now: NOW } })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(wrapper.find('[data-testid="slow"]').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(wrapper.get('[data-testid="elapsed"]').text()).toContain('Time used: 90 s of the 90 s')
  })

  it('offers to stop waiting', async () => {
    const wrapper = mountWithSite(AskProgress, { props: { startedAt: NOW, totalSeconds: 90, replaying: false, now: NOW } })
    await wrapper.get('[data-testid="stop-waiting"]').trigger('click')
    expect(wrapper.emitted('stop')).toHaveLength(1)
  })

  it('says it is waiting for the check before the question is sent, with no clock running', () => {
    const wrapper = mountWithSite(AskProgress, { props: { startedAt: undefined, totalSeconds: 90, replaying: false } })
    expect(wrapper.text()).toContain('Checking that you are a person')
    expect(wrapper.find('[data-testid="elapsed"]').exists()).toBe(false)
  })

  it('has no clock and no stop for a replay, and says the steps are recorded', () => {
    const wrapper = mountWithSite(AskProgress, { props: { startedAt: undefined, totalSeconds: 90, replaying: true } })
    expect(wrapper.text()).toContain('Replaying a recorded run')
    expect(wrapper.find('[data-testid="elapsed"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="stop-waiting"]').exists()).toBe(false)
  })
})

describe('the question box', () => {
  /** Mounts the box with the usual words. */
  function mountBox(overrides: Record<string, unknown> = {}) {
    return mountWithSite(QuestionBox, { props: { idBase: 'test', label: 'Your question', hint: 'Five to 300 characters.', submitLabel: 'Ask the analyst', busy: false, disabled: false, ...overrides } })
  }

  it('does not let a question of fewer than five characters be asked', async () => {
    const wrapper = mountBox()
    await wrapper.get('textarea').setValue('Why?')
    expect(wrapper.get('[data-testid="ask-own"]').attributes('disabled')).toBeDefined()
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('reports the question without the spaces around it, and counts the characters', async () => {
    const wrapper = mountBox()
    await wrapper.get('textarea').setValue('  What was our revenue last quarter?  ')
    expect(wrapper.get('[data-testid="ask-own"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('submit')).toEqual([['What was our revenue last quarter?']])
    expect(wrapper.text()).toContain('of 300')
  })

  it('holds a long question to 300 characters', () => {
    expect(mountBox().get('textarea').attributes('maxlength')).toBe('300')
  })

  it('asks nothing while a question is being asked or when live questions are off', async () => {
    for (const overrides of [{ busy: true }, { disabled: true }]) {
      const wrapper = mountBox(overrides)
      await wrapper.get('textarea').setValue('What was our revenue last quarter?')
      await wrapper.get('form').trigger('submit')
      expect(wrapper.emitted('submit')).toBeUndefined()
      expect(wrapper.get('[data-testid="ask-own"]').attributes('disabled')).toBeDefined()
    }
  })
})

/** Writes a result of a number of orders, each a row of an ID, a status, an amount and a flag. */
function ordersResult(count: number, truncated: boolean): QueryResult {
  return {
    sql: 'SELECT orders.order_id AS order_id FROM orders LIMIT 1000',
    columns: [{ name: 'order_id', kind: 'integer' }, { name: 'status', kind: 'text' }, { name: 'total', kind: 'number' }, { name: 'gift', kind: 'boolean' }],
    rows: Array.from({ length: count }, (_, index) => [index + 1, index === 1 ? '<img src=x onerror=alert(1)>' : 'delivered', index === 2 ? null : 1234.5, index % 2 === 0]),
    row_count: count,
    truncated,
    elapsed_ms: 38,
    tables: ['orders'],
    joins: 0,
  }
}

describe('the result table', () => {
  it('shows fifty rows of a thousand, says how many are shown, and shows more or all on request', async () => {
    const wrapper = mountWithSite(ResultTable, { props: { result: ordersResult(1_000, true), limits: DEFAULT_LIMITS } })
    expect(wrapper.findAll('[data-testid="result-row"]')).toHaveLength(50)
    expect(wrapper.get('[data-testid="result-shown"]').text()).toBe('Rows shown: 50 of 1,000')
    await wrapper.get('[data-testid="show-more"]').trigger('click')
    expect(wrapper.findAll('[data-testid="result-row"]')).toHaveLength(100)
    await wrapper.get('[data-testid="show-all"]').trigger('click')
    expect(wrapper.findAll('[data-testid="result-row"]')).toHaveLength(1_000)
    expect(wrapper.find('[data-testid="show-more"]').exists()).toBe(false)
  })

  it('says plainly that the row cap cut the result, and quotes the cap and the timeout', () => {
    const wrapper = mountWithSite(ResultTable, { props: { result: ordersResult(1_000, true), limits: DEFAULT_LIMITS } })
    expect(wrapper.get('[data-testid="result-cut"]').text()).toContain('cut at 1,000 rows')
    expect(wrapper.get('[data-testid="result-cut"]').attributes('data-cut')).toBe('true')
    expect(wrapper.text()).toContain('stopped after 5 seconds')
  })

  it('says nothing was cut when nothing was, and shows a small result whole with no paging', () => {
    const wrapper = mountWithSite(ResultTable, { props: { result: ordersResult(3, false), limits: DEFAULT_LIMITS } })
    expect(wrapper.get('[data-testid="result-cut"]').text()).toContain('Nothing was cut')
    expect(wrapper.findAll('[data-testid="result-row"]')).toHaveLength(3)
    expect(wrapper.find('[data-testid="result-shown"]').exists()).toBe(false)
  })

  it('shows every cell as text: a missing value in words, numbers in the visitor\'s language, and no markup', () => {
    const wrapper = mountWithSite(ResultTable, { props: { result: ordersResult(3, false), limits: DEFAULT_LIMITS } })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>')
    expect(wrapper.text()).toContain('no value')
    expect(wrapper.text()).toContain('1,234.5')
    const czech = mountWithSite(ResultTable, { locale: 'cs', props: { result: ordersResult(3, false), limits: DEFAULT_LIMITS } })
    // Czech groups digits with a non-breaking space; a reader sees an ordinary one.
    expect(czech.text().replaceAll(/\s+/g, ' ')).toContain('1 234,5')
  })

  it('is a table with column headers and a region the keyboard can scroll', () => {
    const wrapper = mountWithSite(ResultTable, { props: { result: ordersResult(3, false), limits: DEFAULT_LIMITS } })
    expect(wrapper.findAll('thead th[scope="col"]')).toHaveLength(4)
    expect(wrapper.get('[role="region"]').attributes('tabindex')).toBe('0')
    expect(wrapper.get('caption').text()).toBe('The table the query returned')
  })

  it('says a query that returned no rows returned none', () => {
    const wrapper = mountWithSite(ResultTable, { props: { result: ordersResult(0, false), limits: DEFAULT_LIMITS } })
    expect(wrapper.text()).toContain('The query returned no rows')
    expect(wrapper.find('table').exists()).toBe(false)
  })
})

describe('the chart panel', () => {
  it('says there is no chart when the result had no honest one, and draws nothing', async () => {
    const wrapper = mountWithSite(ChartPanel, { props: { chart: null } })
    await flushPromises()
    expect(wrapper.get('[data-testid="chart-none"]').text()).toContain('No chart')
    expect(drawing.calls).toHaveLength(0)
  })

  it('draws a chart the back end writes, with a text alternative that names the extremes', async () => {
    const wrapper = mountWithSite(ChartPanel, { props: { chart: barChart() } })
    await flushPromises()
    expect(drawing.calls).toHaveLength(1)
    expect(wrapper.get('[data-testid="chart-canvas"]').attributes('data-status')).toBe('ready')
    const summary = wrapper.get('[data-testid="chart-summary"]').text()
    expect(summary).toContain('Bar chart of revenue by product. Points: 3.')
    expect(summary).toContain('Highest: Basalt Blend, 182,400.')
    expect(summary).toContain('Lowest: Kenya Nyeri, 96,300.')
  })

  it('shows the points the chart draws as a table on request, and hides it again', async () => {
    const wrapper = mountWithSite(ChartPanel, { props: { chart: lineChart() } })
    await flushPromises()
    expect(wrapper.find('[data-testid="chart-table"]').exists()).toBe(false)
    await wrapper.get('[data-testid="chart-table-toggle"]').trigger('click')
    expect(wrapper.get('[data-testid="chart-table"]').findAll('tbody tr').length).toBeGreaterThan(2)
    expect(wrapper.get('[data-testid="chart-table-toggle"]').attributes('aria-expanded')).toBe('true')
    await wrapper.get('[data-testid="chart-table-toggle"]').trigger('click')
    expect(wrapper.find('[data-testid="chart-table"]').exists()).toBe(false)
  })

  it('draws a point chart, and says when it left points out', async () => {
    const chart = { ...pointChart(), omitted_rows: 40 }
    const wrapper = mountWithSite(ChartPanel, { props: { chart } })
    await flushPromises()
    expect(drawing.calls).toHaveLength(1)
    expect(wrapper.get('[data-testid="chart-omitted"]').text()).toContain('first 3 points')
  })

  it('refuses a spec that is not in the subset, names no value from it, and draws nothing', async () => {
    const hostile = { ...barChart(), spec: { ...barChart().spec, data: { url: 'https://evil.test/steal.json' } } }
    const wrapper = mountWithSite(ChartPanel, { props: { chart: hostile } })
    await flushPromises()
    expect(wrapper.get('[data-testid="chart-refused"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('evil.test')
    expect(drawing.calls).toHaveLength(0)
    expect(wrapper.find('[data-testid="chart-canvas"]').exists()).toBe(false)
  })

  it('says the chart could not be drawn when the drawing fails, and points to the table', async () => {
    drawing.fails = true
    const wrapper = mountWithSite(ChartPanel, { props: { chart: barChart() } })
    await flushPromises()
    expect(wrapper.get('[data-testid="chart-failed"]').text()).toContain('could not be drawn')
  })

  it('draws again when the answer changes to another chart', async () => {
    const wrapper = mountWithSite(ChartPanel, { props: { chart: barChart() } })
    await flushPromises()
    await wrapper.setProps({ chart: lineChart() })
    await flushPromises()
    expect(drawing.calls).toHaveLength(2)
  })
})

describe('the semantic layer browser', () => {
  const layer = semanticLayerSchema.parse(new Lb05Mock(readLb05Seed(), () => NOW).semanticLayer().body)

  it('lists the metrics first, each with its exact definition as SQL text, and what it needs', async () => {
    const wrapper = mountWithSite(SemanticBrowser, { props: { layer, status: 'ready' } })
    const metrics = wrapper.findAll('[data-testid="semantic-metric"]')
    expect(metrics).toHaveLength(layer.metrics.length)
    expect(metrics[0]?.text()).toContain(layer.metrics[0]?.name)
    expect(metrics[0]?.find('[data-testid="sql-text"]').exists()).toBe(true)
  })

  it('moves between the parts with the keyboard-reachable switch', async () => {
    const wrapper = mountWithSite(SemanticBrowser, { props: { layer, status: 'ready' } })
    const buttons = wrapper.findAll('.lb-seg__btn')
    expect(buttons).toHaveLength(5)
    await buttons[1]?.trigger('click')
    expect(wrapper.findAll('[data-testid="semantic-dimension"]')).toHaveLength(layer.dimensions.length)
    await buttons[2]?.trigger('click')
    expect(wrapper.findAll('[data-testid="semantic-table"]')).toHaveLength(layer.tables.length)
    await buttons[3]?.trigger('click')
    expect(wrapper.get('[data-testid="semantic-joins"]').findAll('li')).toHaveLength(layer.joins.length)
    await buttons[4]?.trigger('click')
    expect(wrapper.get('[data-testid="semantic-ranges"]').findAll('tbody tr')).toHaveLength(layer.ranges.length)
  })

  it('says what the layer leaves out on purpose', () => {
    const wrapper = mountWithSite(SemanticBrowser, { props: { layer, status: 'ready' } })
    expect(wrapper.get('[data-testid="semantic-hidden"]').text()).toContain('email address')
  })

  it('says it is reading, and says it failed and offers to try again', async () => {
    const reading = mountWithSite(SemanticBrowser, { props: { layer: undefined, status: 'loading' } })
    expect(reading.text()).toContain('Reading the semantic layer')
    const failed = mountWithSite(SemanticBrowser, { props: { layer: undefined, status: 'failed' } })
    expect(failed.get('[data-testid="semantic-failed"]').text()).toContain('could not be read')
    await failed.get('button').trigger('click')
    expect(failed.emitted('retry')).toHaveLength(1)
  })
})

describe('the answer', () => {
  /** The props every answer needs. */
  function propsFor(answer: ReturnType<typeof answered>, overrides: Record<string, unknown> = {}) {
    return {
      answer,
      asked: { question: 'What was the revenue of each product last quarter?', source: 'sample', sampleId: 'revenue-by-product-last-quarter' },
      steps: stepsAll('done'),
      stepLabels: ['resolve metrics', 'write SQL', 'parse + allowlist', 'EXPLAIN', 'run read-only', 'self-correct', 'chart + explain'],
      stepsBlind: false,
      traceLost: false,
      limits: DEFAULT_LIMITS,
      brief: false,
      ...overrides,
    }
  }

  it('leads with the question and how it ended, then the explanation, the chart, the table and the SQL that ran', async () => {
    const wrapper = mountWithSite(AnswerView, { props: propsFor(answered()) })
    await flushPromises()
    expect(wrapper.get('[data-testid="outcome"]').text()).toBe('Answered')
    expect(wrapper.get('[data-testid="asked-question"]').text()).toBe('What was the revenue of each product last quarter?')
    expect(wrapper.get('[data-testid="explanation"]').text()).toContain('Basalt Blend earned the most')
    expect(wrapper.find('[data-testid="chart"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="result-table"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="sql"]').text()).toContain('What ran')
  })

  it('says an explanation the model did not write is a fixed sentence built from the numbers', () => {
    const wrapper = mountWithSite(AnswerView, { props: propsFor(answered({ with: { explanation_source: 'fallback' } })) })
    expect(wrapper.get('[data-testid="explanation"]').text()).toContain('A fixed sentence built from the numbers')
  })

  it('shows both queries after a correction, and says which layer sent the first one back', () => {
    const attempts = [stopped('SELECT bogus FROM orders', 'allowlist', 'unknown_column', 'That column is not in the semantic layer.'), answered().attempts[0]!]
    const wrapper = mountWithSite(AnswerView, { props: propsFor(answered({ with: { attempts } })) })
    expect(wrapper.get('[data-testid="corrected"]').text()).toContain('Allowlist')
    expect(wrapper.get('[data-testid="corrected"]').text()).toContain('Column not in the layer')
    expect(wrapper.findAll('[data-testid="attempt"]')).toHaveLength(2)
  })

  it('shows a query a layer stopped as stopped, names the layer and the rule, and says nothing ran', () => {
    const wrapper = mountWithSite(AnswerView, { props: propsFor(refused()) })
    expect(wrapper.get('[data-testid="outcome"]').text()).toBe('Stopped by a safety layer')
    expect(wrapper.get('[data-testid="stopped-by"]').text()).toBe('Stopped by the Parse layer: Not a SELECT')
    expect(wrapper.get('[data-testid="refused"]').text()).toContain('Nothing ran')
    expect(wrapper.get('[data-testid="refused"]').text()).toContain('no second try')
    expect(wrapper.find('[data-testid="result-table"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="chart"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="sql"]').text()).toContain('No query ran')
    expect(wrapper.get('[data-testid="attempts"]').text()).toContain('DROP TABLE orders')
  })

  it('shows a question the model declined in the model\'s words, and says no layer saw anything', () => {
    const wrapper = mountWithSite(AnswerView, { props: propsFor(declined('The data has no salaries.')) })
    expect(wrapper.get('[data-testid="outcome"]').text()).toBe('The analyst declined')
    expect(wrapper.get('[data-testid="declined-reason"]').text()).toBe('The data has no salaries.')
    expect(wrapper.get('[data-testid="declined"]').text()).toContain('No query ran')
  })

  it('says a question the service could not answer was not counted', () => {
    const wrapper = mountWithSite(AnswerView, { props: propsFor(unavailable()) })
    expect(wrapper.get('[data-testid="ask-notice"]').attributes('data-kind')).toBe('unavailable')
    expect(wrapper.get('[data-testid="ask-notice"]').text()).toContain('not counted')
  })

  it('shows a curated question in English and leaves a visitor\'s own question to the language of the page', () => {
    const curated = mountWithSite(AnswerView, { locale: 'cs', props: propsFor(answered()) })
    expect(curated.get('[data-testid="asked-question"]').attributes('lang')).toBe('en')
    const own = mountWithSite(AnswerView, { locale: 'cs', props: propsFor(answered(), { asked: { question: 'Jaké byly tržby?', source: 'own' } }) })
    expect(own.get('[data-testid="asked-question"]').attributes('lang')).toBeUndefined()
  })

  it('says when the steps wait for the trace, and when the trace is gone for good', () => {
    const waiting = mountWithSite(AnswerView, { props: propsFor(answered(), { stepsBlind: true }) })
    expect(waiting.get('[data-testid="steps-pending"]').text()).toContain('marked when the answer arrives')
    const gone = mountWithSite(AnswerView, { props: propsFor(answered(), { stepsBlind: true, traceLost: true }) })
    expect(gone.get('[data-testid="steps-missing"]').text()).toContain('not available')
  })

  it('leaves out the steps, the facts and what the model wrote in the Brief reading, and keeps the answer', () => {
    const attempts = [stopped('SELECT bogus FROM orders', 'allowlist', 'unknown_column'), answered().attempts[0]!]
    const wrapper = mountWithSite(AnswerView, { props: propsFor(answered({ with: { attempts } }), { brief: true }) })
    expect(wrapper.find('[data-testid="steps"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="facts"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="attempts"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="result-table"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sql-text"]').exists()).toBe(true)
  })

  it('shows the facts of the run in the visitor\'s language', () => {
    const wrapper = mountWithSite(AnswerView, { locale: 'cs', props: propsFor(answered()) })
    const facts = wrapper.get('[data-testid="facts"]').text()
    expect(facts).toContain('Volání modelu')
    expect(facts).toContain('order_lines, products')
  })
})
