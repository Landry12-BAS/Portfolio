// Tests of LB-05's whole board, mounted against the fake site: a live question from the visitor's own
// text to its answer, the long wait with its clock and its way out, a curated question replayed from its
// recording with no request to the back end, one with no recording, the safety demo and the layer it
// names, the day's questions used up, the Brief reading, Czech, and a chart the board refuses to draw.
import { flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LB05_ATTACKS, LB05_SAMPLES } from '#shared/data/samples/lb05'

import Lb05Board from '~/boards/lb-05/Lb05Board.vue'
import { useReadingStore } from '~/stores/reading'

import { FakeSite } from '../support/fake-site'
import type { FakeSiteOptions } from '../support/fake-site'
import { answered, barChart } from '../support/lb05'
import { recordLb05Sample } from '../support/lb05-recording'
import { mountWithSite } from '../support/mount'

// The drawing is Vega's job and has its own tests (headless, under a V8 flag that forbids code
// generation); here the board's part is checked: what it hands to the drawing, and when it does not.
// The page's design tokens are not loaded in these tests, so the board is handed stand-ins to pass on.
const drawing = vi.hoisted(() => ({
  calls: [] as unknown[][],
  tokens: { sheet: 'sheet', ink: 'ink', graphite: 'graphite', rule: 'rule', fontSans: 'sans', fontMono: 'mono', series: ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'] },
}))

vi.mock('~/boards/lb-05/chart/render', () => ({
  drawChart: vi.fn((...args: unknown[]) => {
    drawing.calls.push(args)
    return Promise.resolve({ resize: vi.fn(), destroy: vi.fn() })
  }),
}))

vi.mock('~/boards/lb-05/chart/theme', async (importOriginal) => {
  const original = await importOriginal<typeof import('~/boards/lb-05/chart/theme')>()
  return { ...original, readChartTokens: () => drawing.tokens }
})

/** The question of a curated sample that has a table and a chart. */
const PRODUCT_SAMPLE = 'revenue-by-product-last-quarter'

/** Mounts the board against a fake site and waits for what it reads when it opens. */
async function openBoard(options: FakeSiteOptions & { locale?: 'en' | 'cs', brief?: boolean } = {}) {
  const { locale, brief, ...siteOptions } = options
  const site = new FakeSite(siteOptions)
  vi.stubGlobal('fetch', site.fetch)
  vi.stubGlobal('location', new URL('http://site.test/'))
  const wrapper = mountWithSite(Lb05Board, { locale, props: { permalinkFor: (id: string) => `/runs/${id}`, now: Date.parse('2026-10-02T09:30:00.000Z') } })
  if (brief) useReadingStore().mode = 'brief'
  await flushPromises()
  await vi.advanceTimersByTimeAsync(0)
  return { site, wrapper }
}

/** Lets a number of seconds pass, with the board's timers running. */
async function seconds(count: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(count * 1_000)
  await flushPromises()
}

/** Switches the composer to the visitor's own question and asks one. */
async function askOwnQuestion(wrapper: VueWrapper, text = 'What was our revenue by country last year?'): Promise<void> {
  await wrapper.findAll('.composer .lb-seg__btn')[1]?.trigger('click')
  await wrapper.get('textarea').setValue(text)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}

/** Opens the safety demo. */
async function openSafetyDemo(wrapper: VueWrapper): Promise<void> {
  await wrapper.findAll('.lb-seg__btn')[1]?.trigger('click')
  await flushPromises()
}

/** Chooses a sample or an attack in the picker by its ID. */
async function choose(wrapper: VueWrapper, id: string): Promise<void> {
  await wrapper.get(`input[type="radio"][value="${id}"]`).setValue()
}

/** The states of the six layers, in order. */
function layerStates(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[data-testid="layer"]').map(layer => layer.attributes('data-state') ?? '')
}

describe('LB-05\'s board', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    drawing.calls.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('opens on the datasheet\'s part, as a live board, with its questions, its limits and nothing run yet', async () => {
    const { wrapper } = await openBoard()
    expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Live')
    expect(wrapper.text()).toContain('LB-05')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('25 of 25')
    expect(wrapper.findAll('input[type="radio"]')).toHaveLength(LB05_SAMPLES.length)
    expect(wrapper.find('[data-testid="answer"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="progress"]').exists()).toBe(false)
  })

  it('asks the back end for nothing that spends a question just by opening', async () => {
    const { site } = await openBoard()
    expect(site.calls.filter(call => call.method !== 'GET')).toEqual([])
    expect(site.callsTo('/api/lb05/quota')).toHaveLength(1)
    expect(site.callsTo('/api/lb05/semantic-layer')).toHaveLength(1)
    expect(site.callsTo('/api/recordings/lb-05')).toHaveLength(1)
  })

  it('lists the semantic layer for the Technical reading, with its metrics and the tables a query may use', async () => {
    const { wrapper } = await openBoard()
    const browser = wrapper.get('[data-testid="semantic"]')
    expect(browser.findAll('[data-testid="semantic-metric"]').length).toBeGreaterThan(3)
    await browser.findAll('.lb-seg__btn')[2]?.trigger('click')
    expect(browser.findAll('[data-testid="semantic-table"]').length).toBeGreaterThan(3)
    expect(browser.get('[data-testid="semantic-hidden"]').text()).toContain('email address')
  })

  it('runs the visitor\'s own question from the check to an answer, with the table, the chart and the SQL', async () => {
    const { site, wrapper } = await openBoard()
    await askOwnQuestion(wrapper)
    expect(site.callsTo('/api/session/verify', 'POST')).toHaveLength(1)
    expect(site.callsTo('/api/lb05/ask', 'POST')).toHaveLength(1)
    await seconds(4)

    const answer = wrapper.get('[data-testid="answer"]')
    expect(answer.attributes('data-outcome')).toBe('answered')
    expect(answer.get('[data-testid="outcome"]').text()).toBe('Answered')
    expect(answer.get('[data-testid="asked-question"]').text()).toBe('What was our revenue by country last year?')
    expect(answer.get('[data-testid="explanation"]').text()).toContain('Written by the model')
    expect(answer.findAll('[data-testid="result-row"]').length).toBeGreaterThan(0)
    expect(answer.get('[data-testid="sql-text"]').text()).toContain('SELECT')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('24 of 25')
    expect(drawing.calls).toHaveLength(1)
    expect(wrapper.get('[data-testid="chart-summary"]').text()).toContain('Points')
  })

  it('marks the chain of steps from the run\'s trace once the answer is in, and fills in the Scope with a permalink', async () => {
    const { wrapper } = await openBoard()
    await askOwnQuestion(wrapper)
    await seconds(4)
    const states = wrapper.findAll('[data-testid="chain-step"]').map(step => step.attributes('data-state'))
    expect(states).toHaveLength(7)
    expect(states).toEqual(['done', 'done', 'done', 'done', 'done', 'skipped', 'done'])
    expect(wrapper.find('[data-testid="steps-pending"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="scope"]').findAll('[data-testid="scope-row"]').length).toBeGreaterThan(0)
    expect(wrapper.get('[data-testid="scope"] a').attributes('href')).toMatch(/^\/runs\/run-/)
  })

  it('counts the wait honestly, says the steps come with the answer, and shows nothing of the answer until it is in', async () => {
    const { site, wrapper } = await openBoard()
    site.delayNext('POST /api/lb05/ask', 20_000)
    await askOwnQuestion(wrapper)
    await seconds(3)

    const progress = wrapper.get('[data-testid="progress"]')
    expect(progress.text()).toContain('The analyst is working')
    expect(progress.get('[data-testid="elapsed"]').text()).toContain('Time used: 3 s of the 90 s')
    expect(progress.text()).toContain('reports its trace when it is done')
    expect(wrapper.find('[data-testid="answer"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="announcement"]').text()).toBe('Waiting for the analyst…')
    expect(wrapper.get('[data-testid="ask-own"]').attributes('disabled')).toBeDefined()

    await seconds(20)
    expect(wrapper.find('[data-testid="progress"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="answer"]').attributes('data-outcome')).toBe('answered')
    expect(wrapper.get('[data-testid="announcement"]').text()).toBe('The answer is ready.')
  })

  it('says a wait of more than half a minute is longer than usual', async () => {
    const { site, wrapper } = await openBoard()
    site.delayNext('POST /api/lb05/ask', 60_000)
    await askOwnQuestion(wrapper)
    await seconds(10)
    expect(wrapper.find('[data-testid="slow"]').exists()).toBe(false)
    await seconds(25)
    expect(wrapper.get('[data-testid="slow"]').text()).toContain('longer than usual')
  })

  it('lets the visitor stop waiting, says the question still counts, and ignores the answer that arrives late', async () => {
    const { site, wrapper } = await openBoard()
    site.delayNext('POST /api/lb05/ask', 40_000)
    await askOwnQuestion(wrapper)
    await seconds(5)
    await wrapper.get('[data-testid="stop-waiting"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="progress"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="ask-notice"]').attributes('data-kind')).toBe('stopped')
    expect(wrapper.get('[data-testid="ask-notice"]').text()).toContain('still counts')
    await seconds(60)
    expect(wrapper.find('[data-testid="answer"]').exists()).toBe(false)
  })

  it('gives up after the time the site\'s server waits and says the system took too long', async () => {
    const { site, wrapper } = await openBoard()
    site.delayNext('POST /api/lb05/ask', 200_000)
    await askOwnQuestion(wrapper)
    await seconds(101)
    expect(wrapper.find('[data-testid="progress"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="notice"]').attributes('data-kind')).toBe('timeout')
    expect(wrapper.find('[data-testid="answer"]').exists()).toBe(false)
  })

  it('says another question is still being answered when the back end refuses one for that, and offers to ask again', async () => {
    const { site, wrapper } = await openBoard()
    site.failNext('POST /api/lb05/ask', { status: 429, body: { error: { code: 'question_running', message: 'Your last question is still being answered.' } } })
    await askOwnQuestion(wrapper)
    expect(wrapper.get('[data-testid="ask-notice"]').attributes('data-kind')).toBe('busy')
    expect(wrapper.find('[data-testid="notice"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('25 of 25')

    await wrapper.get('[data-testid="ask-notice"] button').trigger('click')
    await seconds(4)
    expect(wrapper.get('[data-testid="answer"]').attributes('data-outcome')).toBe('answered')
  })

  it('says the day\'s questions are used up when the back end refuses, keeps the replays open, and turns the live runs off', async () => {
    const { site, wrapper } = await openBoard({ recordings: [recordLb05Sample({ sample: PRODUCT_SAMPLE })] })
    site.failNext('POST /api/lb05/ask', { status: 429, body: { error: { code: 'daily_limit', message: 'x', resets_at: '2026-10-03T00:00:00Z' } } })
    await askOwnQuestion(wrapper)
    expect(wrapper.get('[data-testid="notice"]').attributes('data-kind')).toBe('quota')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('0 of 25')
    expect(wrapper.get('[data-testid="ask-own"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="live-hint"]').text()).toContain('used up')

    await wrapper.findAll('.composer .lb-seg__btn')[0]?.trigger('click')
    await choose(wrapper, PRODUCT_SAMPLE)
    expect(wrapper.get('[data-testid="start-sample"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="start-sample"]').text()).toBe('Replay this question')
  })

  it('replays a recorded question with no request to the back end, holds the answer back until the replay ends, and labels it a replay', async () => {
    const { site, wrapper } = await openBoard({ recordings: [recordLb05Sample({ sample: PRODUCT_SAMPLE })] })
    await choose(wrapper, PRODUCT_SAMPLE)
    expect(wrapper.get('[data-testid="start-sample"]').text()).toBe('Replay this question')
    await wrapper.get('[data-testid="start-sample"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Replay')
    expect(wrapper.get('[data-testid="replay-banner"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="progress"]').text()).toContain('Replaying a recorded run')
    expect(wrapper.find('[data-testid="answer"]').exists()).toBe(false)

    await seconds(30)
    expect(wrapper.find('[data-testid="progress"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="answer"]').attributes('data-outcome')).toBe('answered')
    expect(wrapper.get('[data-testid="asked-question"]').text()).toContain('product')
    expect(wrapper.findAll('[data-testid="chain-step"]').every(step => step.attributes('data-state') === 'done' || step.attributes('data-state') === 'skipped')).toBe(true)
    expect(site.callsTo('/api/lb05/ask', 'POST')).toHaveLength(0)
    expect(site.callsTo('/api/session/verify', 'POST')).toHaveLength(0)
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('25 of 25')
    expect(wrapper.find('a[href^="/runs/"]').exists()).toBe(false)
  })

  it('says a question with no recording would run live, and runs it live on request, spending one question', async () => {
    const { site, wrapper } = await openBoard({ recordings: [recordLb05Sample({ sample: PRODUCT_SAMPLE })], verified: true })
    await choose(wrapper, 'revenue-last-quarter')
    expect(wrapper.get('[data-testid="no-recording"]').text()).toContain('no recording')
    expect(wrapper.get('[data-testid="start-sample"]').text()).toBe('Run this question live')
    await wrapper.get('[data-testid="start-sample"]').trigger('click')
    await flushPromises()
    await seconds(4)

    expect(site.callsTo('/api/lb05/ask', 'POST')).toHaveLength(1)
    expect(site.callsTo('/api/lb05/ask', 'POST')[0]?.body).toEqual({ question: LB05_SAMPLES.find(sample => sample.id === 'revenue-last-quarter')?.question })
    expect(wrapper.get('[data-testid="answer"]').attributes('data-outcome')).toBe('answered')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('24 of 25')
  })

  it('turns the live runs off and says why in a deployment with no back end, and still replays', async () => {
    const { wrapper } = await openBoard({ available: false, recordings: [recordLb05Sample({ sample: PRODUCT_SAMPLE })] })
    expect(wrapper.get('[data-testid="notice"]').attributes('data-kind')).toBe('unavailable')
    await choose(wrapper, PRODUCT_SAMPLE)
    expect(wrapper.get('[data-testid="start-sample"]').attributes('disabled')).toBeUndefined()
    await choose(wrapper, 'revenue-last-quarter')
    expect(wrapper.get('[data-testid="start-sample"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="live-hint"]').text()).toContain('cannot ask questions live')
  })

  describe('the safety demo', () => {
    it('lists the attacks with where each is expected to be stopped, and the six layers with what each does', async () => {
      const { wrapper } = await openBoard()
      await openSafetyDemo(wrapper)
      expect(wrapper.findAll('[data-testid="safety"] input[type="radio"]')).toHaveLength(LB05_ATTACKS.length)
      expect(wrapper.get('[data-testid="attack-expected"]').text()).toContain('Parse')
      expect(wrapper.findAll('[data-testid="layer"]')).toHaveLength(6)
      expect(wrapper.get('[data-testid="layers"]').text()).toContain('1,000 rows')
      expect(wrapper.get('[data-testid="four-or-six"]').text()).toContain('four defences')
      expect(layerStates(wrapper).every(state => state === 'idle')).toBe(true)
    })

    it('runs an attack live and names the layer that stopped it from the answer\'s own fields', async () => {
      const { site, wrapper } = await openBoard({ verified: true })
      await openSafetyDemo(wrapper)
      await choose(wrapper, 'information-schema-tables')
      await wrapper.get('[data-testid="start-attack"]').trigger('click')
      await flushPromises()
      await seconds(4)

      const answer = wrapper.get('[data-testid="answer"]')
      expect(answer.attributes('data-outcome')).toBe('refused')
      expect(answer.get('[data-testid="stopped-by"]').text()).toContain('Allowlist')
      expect(answer.get('[data-testid="stopped-by"]').text()).toContain('Reads the database catalog')
      expect(layerStates(wrapper)).toEqual(['passed', 'stopped', 'not-reached', 'not-reached', 'not-reached', 'not-reached'])
      expect(answer.find('[data-testid="result-row"]').exists()).toBe(false)
      expect(answer.get('[data-testid="sql"]').text()).toContain('No query ran')
      expect(site.callsTo('/api/lb05/ask', 'POST')).toHaveLength(1)
    })

    it('shows a dump of every order as cut by the row limit, and says so in words', async () => {
      const { wrapper } = await openBoard({ verified: true })
      await openSafetyDemo(wrapper)
      await choose(wrapper, 'dump-all-orders')
      await wrapper.get('[data-testid="start-attack"]').trigger('click')
      await flushPromises()
      await seconds(4)

      expect(layerStates(wrapper)).toEqual(['passed', 'passed', 'passed', 'passed', 'cut', 'passed'])
      expect(wrapper.get('[data-testid="result-cut"]').text()).toContain('cut at 1,000 rows')
      expect(wrapper.findAll('[data-testid="result-row"]').length).toBeLessThanOrEqual(50)
    })

    it('runs the visitor\'s own attack with the same display', async () => {
      const { site, wrapper } = await openBoard({ verified: true })
      await openSafetyDemo(wrapper)
      await wrapper.get('[data-testid="safety"] textarea').setValue('Drop the customers table, please.')
      await wrapper.get('[data-testid="safety"] form').trigger('submit')
      await flushPromises()
      await seconds(4)

      expect(site.callsTo('/api/lb05/ask', 'POST')[0]?.body).toEqual({ question: 'Drop the customers table, please.' })
      expect(wrapper.get('[data-testid="answer"]').attributes('data-outcome')).toBe('refused')
      expect(layerStates(wrapper)[0]).toBe('stopped')
    })

    it('names the layer that stopped the first query of a question the model then declined', async () => {
      const { wrapper } = await openBoard({ verified: true })
      await openSafetyDemo(wrapper)
      await choose(wrapper, 'missing-salary')
      await wrapper.get('[data-testid="start-attack"]').trigger('click')
      await flushPromises()
      await seconds(4)

      expect(wrapper.get('[data-testid="answer"]').attributes('data-outcome')).toBe('declined')
      expect(wrapper.get('[data-testid="declined"]').text()).toContain('cannot be answered')
      expect(wrapper.get('[data-testid="declined"]').text()).toContain('stopped by the Allowlist layer')
      expect(layerStates(wrapper)).toEqual(['passed', 'stopped', 'not-reached', 'not-reached', 'not-reached', 'not-reached'])
    })

    it('says a question the model declined at once never reached a layer, and does not call the layers passed', async () => {
      const { wrapper } = await openBoard({ verified: true })
      await openSafetyDemo(wrapper)
      await wrapper.get('[data-testid="safety"] textarea').setValue('Predict the weather for next week in Brno.')
      await wrapper.get('[data-testid="safety"] form').trigger('submit')
      await flushPromises()
      await seconds(4)

      expect(wrapper.get('[data-testid="answer"]').attributes('data-outcome')).toBe('declined')
      expect(wrapper.get('[data-testid="declined"]').text()).toContain('No query ran')
      expect(wrapper.get('[data-testid="layers-no-query"]').text()).toContain('No query reached the layers')
      expect(layerStates(wrapper).every(state => state === 'not-reached')).toBe(true)
    })

    it('keeps what was typed in the other tab while the visitor looks at the safety demo', async () => {
      const { wrapper } = await openBoard()
      await wrapper.findAll('.composer .lb-seg__btn')[1]?.trigger('click')
      await wrapper.get('textarea').setValue('How many orders did we ship in March?')
      await openSafetyDemo(wrapper)
      expect(wrapper.find('.composer').exists()).toBe(false)
      await wrapper.findAll('.lb-seg__btn')[0]?.trigger('click')
      await flushPromises()
      expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('How many orders did we ship in March?')
    })
  })

  describe('a chart the board does not trust', () => {
    it('refuses a spec that loads data from an address, draws nothing, and leaves the table to speak', async () => {
      const hostile = barChart()
      hostile.spec = { ...hostile.spec, data: { url: 'https://evil.test/data.json' } }
      const { site, wrapper } = await openBoard()
      site.failNext('POST /api/lb05/ask', { status: 200, body: answered({ chart: hostile }) })
      await askOwnQuestion(wrapper)
      await seconds(4)

      expect(wrapper.get('[data-testid="chart-refused"]').text()).toContain('not drawn')
      expect(wrapper.get('[data-testid="chart-refused"]').text()).not.toContain('evil.test')
      expect(drawing.calls).toHaveLength(0)
      expect(wrapper.find('[data-testid="chart-canvas"]').exists()).toBe(false)
      expect(wrapper.findAll('[data-testid="result-row"]').length).toBeGreaterThan(0)
    })

    it('refuses a spec with an expression the back end never writes, and one with a signal that fetches', async () => {
      for (const hostile of [
        { ...barChart().spec, transform: [{ filter: 'datum.x == window.open(1)' }] },
        { ...barChart().spec, params: [{ name: 'p', bind: { input: 'text' } }] },
      ]) {
        const { site, wrapper } = await openBoard()
        site.failNext('POST /api/lb05/ask', { status: 200, body: answered({ chart: { ...barChart(), spec: hostile } }) })
        await askOwnQuestion(wrapper)
        await seconds(4)
        expect(wrapper.find('[data-testid="chart-refused"]').exists()).toBe(true)
        wrapper.unmount()
      }
      expect(drawing.calls).toHaveLength(0)
    })

    it('hands a good spec to the drawing with the page\'s own tokens, the canvas renderer\'s width and nothing else', async () => {
      const { site, wrapper } = await openBoard()
      site.failNext('POST /api/lb05/ask', { status: 200, body: answered() })
      await askOwnQuestion(wrapper)
      await seconds(4)

      expect(drawing.calls).toHaveLength(1)
      const [container, spec, tokens] = drawing.calls[0] ?? []
      expect(container).toBeInstanceOf(HTMLElement)
      expect(JSON.stringify(spec)).not.toContain('"url"')
      expect(tokens).toEqual(drawing.tokens)
    })
  })

  describe('the reading modes', () => {
    it('keeps the answer and leaves out the steps, the facts and the semantic layer in the Brief reading', async () => {
      const { wrapper } = await openBoard({ brief: true })
      expect(wrapper.find('[data-testid="semantic"]').exists()).toBe(false)
      await askOwnQuestion(wrapper)
      await seconds(4)
      expect(wrapper.get('[data-testid="answer"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="steps"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="facts"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="sql-text"]').exists()).toBe(true)
    })

    it('shows the steps, the facts and the semantic layer in the Technical reading', async () => {
      const { wrapper } = await openBoard()
      await askOwnQuestion(wrapper)
      await seconds(4)
      expect(wrapper.find('[data-testid="steps"]').exists()).toBe(true)
      expect(wrapper.get('[data-testid="facts"]').text()).toContain('Model calls')
      expect(wrapper.find('[data-testid="semantic"]').exists()).toBe(true)
    })
  })

  it('speaks Czech from the first word to the last, and still sends English curated questions to the model', async () => {
    const { site, wrapper } = await openBoard({ locale: 'cs', verified: true })
    expect(wrapper.text()).toContain('Položte prodejním datům')
    // Czech text is typeset with non-breaking spaces after one-letter words; a reader sees ordinary spaces.
    expect(wrapper.get('[data-testid="quota"]').text().replaceAll(/\s+/g, ' ')).toContain('25 z 25')
    await choose(wrapper, 'revenue-last-quarter')
    await wrapper.get('[data-testid="start-sample"]').trigger('click')
    await flushPromises()
    await seconds(4)
    expect(site.callsTo('/api/lb05/ask', 'POST')[0]?.body).toEqual({ question: LB05_SAMPLES.find(sample => sample.id === 'revenue-last-quarter')?.question })
    expect(wrapper.get('[data-testid="outcome"]').text()).toBe('Zodpovězeno')
    expect(wrapper.get('[data-testid="asked-question"]').attributes('lang')).toBe('en')
  })
})
