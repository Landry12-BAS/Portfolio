// Tests of LB-07's whole board, mounted against the fake site and the mock back end's LB-07: the board on
// opening, a curated run live from the queue to the report with its steps in words, its findings, the bug
// reports labelled as a model's, the red-then-green verdict, the generated test in its code view with the
// copy, and the evidence with its text alternatives; the run that re-plans; the queue and the busy browser;
// the day's two runs; the failures in their own words; a run of the visitor's own with its goal checked; a
// replay with no request that could change anything; the Brief reading; a deployment with no back end; and
// the whole of it in Czech.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordingSchema } from '@lb/contracts'
import type { Recording } from '@lb/contracts'
import { flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LB07_SAMPLES } from '#shared/data/samples/lb07'
import Lb07Board from '~/boards/lb-07/Lb07Board.vue'
import { useReadingStore } from '~/stores/reading'
import type { FakeLb07Options } from '../support/lb07-site'
import { FakeLb07Site } from '../support/lb07-site'
import { mountWithSite } from '../support/mount'

const FIXTURES = join(import.meta.dirname, '../../e2e/fixtures/recordings/lb-07')

/** One of the committed recordings, made to look like a real one (the site shows only those). */
function liveRecording(sample: string): Recording {
  return recordingSchema.parse({ ...JSON.parse(readFileSync(join(FIXTURES, `${sample}.json`), 'utf8')) as object, origin: 'live' })
}

/** Answers the page's questions about its screen: a narrow one, with motion. */
function stubScreen(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }))
}

/** Mounts the board against a fake site and waits for what it reads when it opens. */
async function openBoard(options: FakeLb07Options & { locale?: 'en' | 'cs', brief?: boolean } = {}) {
  const { locale, brief, ...siteOptions } = options
  stubScreen()
  const site = new FakeLb07Site({ verified: true, ...siteOptions })
  vi.stubGlobal('fetch', site.fetch)
  vi.stubGlobal('location', new URL('http://site.test/'))
  const wrapper = mountWithSite(Lb07Board, { locale, props: { permalinkFor: (id: string) => `/runs/${id}`, now: Date.parse('2026-10-05T09:30:00.000Z') } })
  if (brief) useReadingStore().mode = 'brief'
  await flushPromises()
  await vi.advanceTimersByTimeAsync(0)
  await flushPromises()
  return { site, wrapper }
}

/** Lets a number of milliseconds pass, with the board's timers running. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}

/** Lets time pass in small steps until a condition holds, or fails after a while. */
async function until(condition: () => boolean, what: string, limitMs = 40_000): Promise<void> {
  for (let waited = 0; waited < limitMs && !condition(); waited += 100) await advance(100)
  expect(condition(), `waited for ${what}`).toBe(true)
}

/** Picks a curated run by its id. */
async function choose(wrapper: VueWrapper, id: string): Promise<void> {
  await wrapper.get(`input[type="radio"][value="${id}"]`).setValue(true)
}

/** Runs a curated run live. */
async function runLive(wrapper: VueWrapper, id = 'coupon-double-discount'): Promise<void> {
  await choose(wrapper, id)
  await wrapper.get('[data-testid="live-sample"]').trigger('click')
  await advance(300)
}

/** The text of an element, with its spaces folded. */
function textOf(wrapper: VueWrapper, selector: string): string {
  return wrapper.get(selector).text().replace(/\s+/g, ' ')
}

/** Tells whether the run on the board has ended and what it leaves has been read. */
function finished(wrapper: VueWrapper): boolean {
  const state = wrapper.find('[data-testid="run-state"]')
  return state.exists() && ['done', 'failed'].includes(state.attributes('data-state') ?? '') && !wrapper.text().includes('Reading the')
}

describe('LB-07\'s board', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-05T09:30:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('opens on the curated runs, with the chosen one\'s goal in English, its bugs, its verdict and the day\'s two runs', async () => {
    const { wrapper } = await openBoard({ recordings: [liveRecording('coupon-double-discount')] })
    expect(wrapper.findAll('[data-testid^="sample-"] input[type="radio"]')).toHaveLength(LB07_SAMPLES.length)
    expect(wrapper.get('[data-testid="sample-goal"]').attributes('lang')).toBe('en')
    expect(textOf(wrapper, '[data-testid="sample-details"]')).toContain('The coupon counts twice')
    expect(textOf(wrapper, '[data-testid="sample-details"]')).toContain('Kept')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('2 of 2')
    expect(wrapper.get('[data-testid="replay-sample"]').attributes('disabled')).toBeUndefined()
    await choose(wrapper, 'clean-shop')
    expect(wrapper.find('[data-testid="no-recording"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="replay-sample"]').attributes('disabled')).toBeDefined()
    expect(textOf(wrapper, '[data-testid="sample-details"]')).toContain('None: the shop is clean.')
    expect(wrapper.find('[data-testid="run-panel"]').exists()).toBe(false)
  })

  it('runs a curated run live and shows the run, its steps, findings, reports, verdict, test and evidence', async () => {
    const { wrapper } = await openBoard()
    await runLive(wrapper)
    expect(wrapper.find('[data-testid="run-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="stepper"] [aria-current="step"]').exists()).toBe(true)
    await until(() => finished(wrapper) && wrapper.find('[data-testid="evidence"] img').exists(), 'the run to end')

    expect(textOf(wrapper, '[data-testid="run-state"]')).toBe('Done')
    expect(wrapper.get('[data-testid="model-calls"]').text()).toBe('2 of 8')
    expect(wrapper.get('[data-testid="replans"]').text()).toBe('0 of 2')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('1 of 2')
    const steps = wrapper.findAll('[data-testid="step"]').map(step => step.text().replace(/\s+/g, ' '))
    expect(steps[0]).toContain('Go to /')
    expect(steps[1]).toContain('Click the button “Add Ethiopia Guji to cart”')
    expect(steps[8]).toContain('Expect the page to say “Total €26.10”')
    expect(steps[8]).toContain('Finding')
    expect(textOf(wrapper, '[data-testid="finding"]')).toContain('expected "Total €26.10"; the page says "Total Total €23.20"')
    expect(textOf(wrapper, '[data-testid="by-model"]')).toContain('Written by a model from the findings above')
    expect(wrapper.findAll('[data-testid="report"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="verdict"]').attributes('data-verdict')).toBe('kept')
    // The second engine is red too: the expectation does not hold there either, though the finding is not news (it was made in Chromium).
    expect(wrapper.findAll('[data-testid="passes"] tbody tr').map(row => row.attributes('data-result'))).toEqual(['red', 'red', 'green'])
    expect(textOf(wrapper, '[data-testid="second-engine-note"]')).toContain('Chromium wearing Firefox\'s user agent')
    expect(textOf(wrapper, '[data-testid="never-runs"]')).toContain('This service never runs it')
    expect(wrapper.findAll('[data-testid="test-code"] .line').length).toBeGreaterThan(20)
    expect(wrapper.get('[data-testid="test-filename"]').text()).toMatch(/\.spec\.ts$/)
    const picture = wrapper.get('[data-testid="evidence"] img')
    expect(picture.attributes('src')).toMatch(/^\/api\/lb07\/runs\/[\w-]+\/evidence\/e1\/image$/)
    expect(picture.attributes('alt')).toBe('Screenshot of /cart after step 9, Expect the page to say “Total €26.10”, in Chromium')
    expect(wrapper.find('[data-testid="snapshot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="html"]').exists()).toBe(false)
  })

  it('shows a re-plan as its own plan, introduced by the step whose failure asked for it', async () => {
    const { wrapper } = await openBoard()
    await runLive(wrapper, 'cart-count')
    await until(() => finished(wrapper), 'the run to end')
    const plans = wrapper.findAll('[data-testid="plan"]')
    expect(plans.map(plan => plan.attributes('data-plan'))).toEqual(['0', '1'])
    expect(plans[1]?.text()).toContain('Re-plan 1')
    expect(textOf(wrapper, '[data-testid="replan-intro"]')).toBe('Step 2 failed, so the agent asked the model for new steps from there.')
    expect(wrapper.get('[data-testid="replans"]').text()).toBe('1 of 2')
    expect(wrapper.findAll('[data-testid="step"]')[1]?.text()).toContain('nothing with that name on the page')
  })

  it('says how many runs are ahead while the run waits, and counts down', async () => {
    const { site, wrapper } = await openBoard()
    site.lb07.occupy(2, 8_000)
    await runLive(wrapper, 'hostile-goal')
    expect(textOf(wrapper, '[data-testid="queue"]')).toContain('2 runs are ahead of yours.')
    expect(wrapper.get('[data-testid="run-state"]').attributes('data-state')).toBe('queued')
    await advance(10_500)
    expect(textOf(wrapper, '[data-testid="queue"]')).toContain('1 run is ahead of yours.')
    await until(() => finished(wrapper), 'the run to end')
  })

  it('says the browser is busy when the queue is full, in its own words', async () => {
    const { site, wrapper } = await openBoard()
    site.lb07.occupy(4, 60_000)
    await runLive(wrapper)
    expect(wrapper.get('[data-testid="own-notice"]').attributes('data-notice')).toBe('busy')
    expect(wrapper.text()).toContain('The browser is busy')
    expect(wrapper.find('[data-testid="run-panel"]').exists()).toBe(false)
  })

  it('says the day\'s two runs are used, and keeps the replays open', async () => {
    const { wrapper } = await openBoard({ recordings: [liveRecording('partner-link')] })
    await runLive(wrapper, 'hostile-goal')
    await until(() => finished(wrapper), 'the first run to end')
    await runLive(wrapper, 'clean-shop')
    await until(() => finished(wrapper), 'the second run to end')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('0 of 2')
    expect(wrapper.find('[data-testid="allowance-used"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="live-sample"]').attributes('disabled')).toBeDefined()
    await choose(wrapper, 'partner-link')
    expect(wrapper.get('[data-testid="replay-sample"]').attributes('disabled')).toBeUndefined()
  })

  it('says why a run failed, and that a failure of the system gives the run back', async () => {
    const { site, wrapper } = await openBoard()
    site.lb07.failNext('planning_unavailable')
    await runLive(wrapper, 'hostile-goal')
    await until(() => finished(wrapper), 'the run to fail')
    expect(wrapper.get('[data-testid="failure"]').attributes('data-code')).toBe('planning_unavailable')
    expect(textOf(wrapper, '[data-testid="failure-text"]')).toBe('The model could not be reached, or its free quota for today is spent.')
    expect(textOf(wrapper, '[data-testid="failure-day"]')).toContain('the run is given back')
    expect(wrapper.find('[data-testid="verification"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="stepper"] [data-status="failed"]').attributes('data-stage')).toBe('plan')
    await advance(500)
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('2 of 2')

    site.lb07.failNext('run_timeout')
    await runLive(wrapper, 'hostile-goal')
    await until(() => finished(wrapper), 'the second run to fail')
    expect(textOf(wrapper, '[data-testid="failure-text"]')).toBe('The run used its three minutes of browser time and was stopped.')
    expect(textOf(wrapper, '[data-testid="failure-day"]')).toBe('It still counts as one of your runs today.')
  })

  it('checks the visitor\'s own goal before sending it, then runs it with the bugs they switched on and shows both back', async () => {
    const { site, wrapper } = await openBoard()
    await wrapper.get('[data-testid="own-details"] summary').trigger('click')
    const goal = wrapper.get('[data-testid="own-goal"]')
    await goal.setValue('ab')
    await goal.trigger('blur')
    expect(goal.attributes('aria-invalid')).toBe('true')
    expect(textOf(wrapper, '[data-testid="goal-problem"]')).toBe('Write at least 3 characters.')
    expect(wrapper.get('[data-testid="own-submit"]').attributes('disabled')).toBeDefined()
    await goal.setValue('Buy a bag​ of Decaf Mexico.')
    expect(textOf(wrapper, '[data-testid="goal-problem"]')).toBe('Use plain text only, with no control or formatting characters.')
    await goal.setValue('Buy two bags of Brazil Cerrado and check the cart says 2 items.')
    expect(wrapper.get('[data-testid="goal-count"]').text()).toBe('63 of 300 characters')
    await wrapper.get('[data-testid="bug-cart-off-by-one"] input').setValue(true)
    await wrapper.get('[data-testid="own-submit"]').trigger('click')
    await advance(300)
    expect(site.callsTo('/api/lb07/runs', 'POST')[0]?.body).toEqual({ from: 'custom', goal: 'Buy two bags of Brazil Cerrado and check the cart says 2 items.', bugs: ['cart-off-by-one'] })
    expect(textOf(wrapper, '[data-testid="run-goal"]')).toBe('Buy two bags of Brazil Cerrado and check the cart says 2 items.')
    expect(wrapper.get('[data-testid="run-goal"]').attributes('lang')).toBeUndefined()
    expect(textOf(wrapper, '[data-testid="run-bugs"]')).toBe('The cart count is one too high')
    await until(() => finished(wrapper), 'the run to end')
    expect(wrapper.find('[data-testid="reading"]').text()).toContain('add 2 bags')
  })

  it('copies the test and says so, and says so too when the browser will not', async () => {
    const writes: string[] = []
    vi.stubGlobal('navigator', { clipboard: { writeText: async (text: string) => {
      writes.push(text)
    } } })
    const { wrapper } = await openBoard()
    await runLive(wrapper, 'hostile-goal')
    await until(() => finished(wrapper) && wrapper.find('[data-testid="copy-test"]').exists(), 'the test')
    await wrapper.get('[data-testid="copy-test"]').trigger('click')
    await flushPromises()
    expect(writes[0]).toContain('import { expect, test } from \'@playwright/test\'')
    expect(wrapper.get('[data-testid="copy-test"]').text()).toBe('Copied')
    expect(wrapper.get('[data-testid="copy-status"]').text()).toBe('Copied')
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => {
      throw new Error('denied')
    } } })
    await wrapper.get('[data-testid="copy-test"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="copy-status"]').text()).toContain('The browser would not copy')
  })

  it('replays a recording under the Replay badge, with no request that could change anything', async () => {
    const { site, wrapper } = await openBoard({ recordings: [liveRecording('cart-count')] })
    await choose(wrapper, 'cart-count')
    await wrapper.get('[data-testid="replay-sample"]').trigger('click')
    await until(() => finished(wrapper) && wrapper.find('[data-testid="evidence"] img').exists(), 'the replay to end', 60_000)
    expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Replay')
    expect(wrapper.find('[data-testid="replaying-note"]').exists()).toBe(true)
    expect(site.calls.filter(call => call.method !== 'GET')).toEqual([])
    expect(site.callsTo('/api/lb07/runs/')).toEqual([])
    expect(wrapper.get('[data-testid="evidence"] img').attributes('src')).toMatch(/^data:image\/png;base64,/)
    expect(wrapper.find('[data-testid="stop-waiting"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="delete-run"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="plan"]')).toHaveLength(2)
  })

  it('takes the technical details out of the Brief reading and keeps the demo', async () => {
    const { wrapper } = await openBoard({ brief: true })
    await runLive(wrapper, 'pictures-have-alt-text')
    await until(() => finished(wrapper) && wrapper.find('[data-testid="evidence"] img').exists(), 'the run to end')
    expect(wrapper.text()).not.toContain('Took ')
    expect(wrapper.text()).not.toContain('At most 8 model calls a run')
    expect(wrapper.find('[data-testid="snapshot"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('image-alt')
    expect(wrapper.find('[data-testid="verdict"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="test-code"]').exists()).toBe(true)
  })

  it('says there is no back end, and offers no live run, on a copy of the site without one', async () => {
    const { wrapper } = await openBoard({ available: false })
    expect(wrapper.text()).toContain('This demo is not connected')
    expect(wrapper.find('[data-testid="no-live"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="live-sample"]').attributes('disabled')).toBeDefined()
  })

  it('runs and shows a whole run in Czech, with the shop\'s and the model\'s words left as they are', async () => {
    const { site, wrapper } = await openBoard({ locale: 'cs' })
    site.lb07.occupy(2, 3_000)
    expect(textOf(wrapper, '[data-testid="quota"]')).toContain('2 z 2')
    await runLive(wrapper)
    expect(textOf(wrapper, '[data-testid="queue"]')).toContain('Před vaším během jsou 2 další.')
    await until(() => finished(wrapper) && wrapper.find('[data-testid="evidence"] img').exists(), 'the run to end')
    expect(textOf(wrapper, '[data-testid="run-state"]')).toBe('Hotovo')
    const steps = wrapper.findAll('[data-testid="step"]').map(step => step.text().replace(/\s+/g, ' '))
    expect(steps[0]).toContain('Otevřít /')
    expect(steps[1]).toContain('Klepnout na tlačítko „Add Ethiopia Guji to cart“')
    expect(textOf(wrapper, '[data-testid="verdict"]')).toBe('Ponechán')
    expect(textOf(wrapper, '[data-testid="by-model"]')).toContain('Napsal je model')
    expect(wrapper.get('[data-testid="report"] h3').attributes('lang')).toBe('en')
    expect(wrapper.get('[data-testid="evidence"] img').attributes('alt')).toContain('po kroku 9')
    expect(wrapper.text()).not.toMatch(/\b(?:Done|Steps|Findings, made by code|Bug reports)\b/)
  })
})
