// Tests of LB-08's whole board, mounted against the fake site: opening a sample and editing the
// workflow in the outline with every edit checked, running it with a test order, making a step fail
// and reading the retries, the dead letter and the replay, answering an approval, a sample replayed
// from its recording with no request that could change anything, a sample with no recording, a
// deployment with no back end, the notices, the Brief reading, and Czech. The canvas is a separate
// piece of code that needs a real browser; the end-to-end tests cover it, and here it is a stand-in
// that shows when it is loaded.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { recordingSchema } from '@lb/contracts'
import type { Recording } from '@lb/contracts'
import { flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LB08_SAMPLES } from '#shared/data/samples/lb08'

import Lb08Board from '~/boards/lb-08/Lb08Board.vue'
import { useReadingStore } from '~/stores/reading'

import type { FakeSiteOptions } from '../support/fake-site'
import { Lb08Site } from '../support/lb08-site'
import { mountWithSite } from '../support/mount'

vi.mock('~/boards/lb-08/components/GraphCanvas.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'GraphCanvasStand-in',
      emits: ['pick', 'said'],
      setup(_, { emit }) {
        const say = () => emit('said', 'Moved a step.')
        return () => h('div', { 'data-testid': 'canvas-stand-in' }, [h('button', { 'data-testid': 'stand-in-said', 'onClick': say }, 'say something')])
      },
    }),
  }
})

const FIXTURES = join(import.meta.dirname, '../../e2e/fixtures/recordings/lb-08')

/** One of the committed recordings, made to look like a real one (the site shows only those). */
function liveRecording(sample: string): Recording {
  return recordingSchema.parse({ ...JSON.parse(readFileSync(join(FIXTURES, `${sample}.json`), 'utf8')) as object, origin: 'live' })
}

/** Answers the page's questions about its screen: a narrow one without a pointer unless the test asks for a wide one, and with motion. */
function stubScreen(wide: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide && query.includes('min-width: 900px'),
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
async function openBoard(options: FakeSiteOptions & { locale?: 'en' | 'cs', brief?: boolean, wide?: boolean } = {}) {
  const { locale, brief, wide = false, ...siteOptions } = options
  stubScreen(wide)
  const site = new Lb08Site({ verified: true, ...siteOptions })
  vi.stubGlobal('fetch', site.fetch)
  vi.stubGlobal('location', new URL('http://site.test/'))
  const wrapper = mountWithSite(Lb08Board, { locale, props: { permalinkFor: (id: string) => `/runs/${id}`, now: Date.parse('2026-10-02T09:30:00.000Z') } })
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

/** Lets time pass in small steps until a condition holds, or fails after a while. */
async function until(condition: () => boolean, stepMs = 250, limit = 120): Promise<void> {
  for (let step = 0; step < limit && !condition(); step += 1) await seconds(stepMs / 1_000)
  expect(condition()).toBe(true)
}

/** Picks a sample in the picker by its id. */
async function choose(wrapper: VueWrapper, id: string): Promise<void> {
  await wrapper.get(`input[type="radio"][value="${id}"]`).setValue(true)
}

/** Opens a sample as a live workflow. */
async function openLive(wrapper: VueWrapper, id = 'wholesale-order'): Promise<void> {
  await choose(wrapper, id)
  // A sample with a recording offers the live run beside its replay; one without has only the live run.
  const beside = wrapper.find('[data-testid="open-sample-live"]')
  await (beside.exists() ? beside : wrapper.get('[data-testid="start-sample"]')).trigger('click')
  await seconds(1)
}

/** The steps of the outline, by id. */
function outlineIds(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[data-testid="outline-step"]').map(step => step.attributes('data-step') ?? '')
}

/** The status the run on the board has. */
function runStatus(wrapper: VueWrapper): string | undefined {
  return wrapper.find('[data-testid="run-status"]').attributes('data-status')
}

describe('LB-08\'s board', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('opens on the datasheet\'s part, as a live board, with its limits, the samples to choose from and nothing opened', async () => {
    const { wrapper } = await openBoard({ recordings: [liveRecording('low-stock-reorder')] })

    expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Live')
    expect(wrapper.text()).toContain('LB-08')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('10 of 10')
    expect(wrapper.get('[data-testid="generations"]').text()).toContain('10 of 10')
    expect(wrapper.findAll('input[type="radio"][name="sample"]')).toHaveLength(LB08_SAMPLES.length)
    expect(wrapper.find('[data-testid="editor"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="my-workflows"]').text()).toContain('You have no workflows yet.')
    expect(wrapper.get('[data-testid="versions"]').text()).toContain('A version appears when a workflow is opened')
  })

  it('opens a sample live: the workflow in the outline, valid, saved, with its version and its place in the list', async () => {
    const { site, wrapper } = await openBoard()

    await openLive(wrapper)

    expect(wrapper.find('[data-testid="editor"]').exists()).toBe(true)
    expect(outlineIds(wrapper)).toEqual(['order_received', 'big_order', 'check_stock', 'alert_roastery', 'email_cafe'])
    expect(wrapper.get('[data-testid="validity"]').text()).toContain('Valid. Steps: 5. Connections: 4.')
    expect(wrapper.get('[data-testid="saved-state"]').text()).toContain('Saved')
    expect(wrapper.get('[data-testid="save"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="run"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.findAll('[data-testid="version"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="my-workflow"]')).toHaveLength(1)
    expect(site.callsTo('/api/lb08/workflows', 'POST')[0]?.body).toEqual({ from: 'sample', sampleId: 'wholesale-order' })
    expect(wrapper.get('[data-testid="order"]').text()).toContain('For the event: A wholesale order arrives')
  })

  it('refuses an edit that breaks the workflow: the reason at the step and in the list, nothing to save or run, and undo fixes it', async () => {
    const { wrapper } = await openBoard()
    await openLive(wrapper)

    await wrapper.get('[data-step="big_order"] [data-testid="outline-remove"]').trigger('click')

    expect(wrapper.get('[data-testid="validity"]').text()).toContain('Problems:')
    expect(wrapper.findAll('[data-testid="issue"]').some(issue => issue.attributes('data-code') === 'unreachable_node')).toBe(true)
    expect(wrapper.get('[data-step="check_stock"] [data-testid="step-problem"]').text()).toContain('cannot be reached from the trigger')
    expect(wrapper.get('[data-testid="save"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="run"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="run-blocked"]').text()).toContain('Fix the problems in the workflow first.')

    await wrapper.get('[data-testid="undo"]').trigger('click')
    expect(wrapper.get('[data-testid="validity"]').text()).toContain('Valid.')
    expect(wrapper.get('[data-testid="run"]').attributes('disabled')).toBeUndefined()
  })

  it('saves an edit as the next version, which the list of versions shows as the visitor\'s own', async () => {
    const { site, wrapper } = await openBoard()
    await openLive(wrapper)
    await wrapper.get('[data-step="order_received"] [data-testid="outline-edit"]').trigger('click')

    await wrapper.get('[data-testid="inspector"] input[type="text"]').setValue('An order comes in')
    expect(wrapper.get('[data-testid="saved-state"]').text()).toContain('Changes not saved')
    await wrapper.get('[data-testid="save"]').trigger('click')
    await seconds(1)

    expect(wrapper.get('[data-testid="saved-state"]').text()).toContain('Saved')
    expect(wrapper.findAll('[data-testid="version"]')).toHaveLength(2)
    expect(wrapper.get('[data-testid="versions"]').text()).toContain('You, by editing')
    expect(site.callsTo('/api/lb08/workflows/', 'PUT')).toHaveLength(1)
    expect(wrapper.get('[data-testid="said"]').text()).toContain('Saved as version 2.')
  })

  it('loads the canvas only when it is wanted, and says aloud what the canvas says', async () => {
    const { wrapper } = await openBoard()
    await openLive(wrapper)
    expect(wrapper.find('[data-testid="canvas-stand-in"]').exists()).toBe(false)

    await wrapper.findAll('[data-testid="editor"] .lb-seg__btn').find(button => button.text() === 'Canvas')?.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="canvas-stand-in"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="outline"]').exists()).toBe(false)

    await wrapper.get('[data-testid="stand-in-said"]').trigger('click')
    expect(wrapper.get('[data-testid="said"]').text()).toBe('Moved a step.')

    await wrapper.findAll('[data-testid="editor"] .lb-seg__btn').find(button => button.text() === 'Outline')?.trigger('click')
    expect(wrapper.find('[data-testid="outline"]').exists()).toBe(true)
  })
})

describe('LB-08\'s board: a run', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('runs the workflow with the sample\'s test order, step by step, and shows what the sandbox sent exactly once', async () => {
    const { site, wrapper } = await openBoard()
    await openLive(wrapper)

    await wrapper.get('[data-testid="run"]').trigger('click')
    await seconds(8)

    expect(runStatus(wrapper)).toBe('succeeded')
    expect(site.callsTo('/api/lb08/workflows/', 'POST')[0]?.body).toMatchObject({ input: { orderId: 'WO-2041', totalEur: 640 } })
    expect(wrapper.findAll('[data-testid="run-step"]').map(step => step.attributes('data-status'))).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded'])
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('9 of 10')
    expect(wrapper.get('[data-testid="sent-summary"]').text()).toContain('Each thing was sent once.')
    expect(wrapper.findAll('[data-testid="sent-row"]')).toHaveLength(2)
    expect(wrapper.findAll('[data-testid="log-event"]').length).toBeGreaterThan(10)
    expect(wrapper.get('[data-testid="run-announce"]').text()).toContain('The run succeeded.')
    expect(wrapper.get('[data-testid="scope"]').text()).toContain('step.check_stock')
  })

  it('retries a failing step with a countdown, then sends the step to the dead-letter queue, and one click replays it without sending twice', async () => {
    const { site, wrapper } = await openBoard()
    await openLive(wrapper, 'low-stock-reorder')
    await wrapper.get('[data-testid="failure"][data-step="tell_purchasing"] select').setValue('3')
    expect(wrapper.get('[data-testid="failure"][data-step="tell_purchasing"]').text()).toContain('dead-letter queue')

    await wrapper.get('[data-testid="run"]').trigger('click')
    await seconds(2)
    expect(wrapper.get('[data-testid="retry-countdown"]').text()).toMatch(/Next attempt in \d s|Trying again now/)
    await seconds(8)

    expect(runStatus(wrapper)).toBe('failed')
    expect(wrapper.findAll('[data-testid="dead-letter"]')).toHaveLength(1)
    expect(wrapper.find('[data-step="tell_purchasing"] [data-testid="step-dead"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="sent-row"]')).toHaveLength(1)
    expect(site.callsTo('/api/lb08/workflows/', 'POST')[0]?.body).toMatchObject({ failures: [{ nodeId: 'tell_purchasing', times: 3 }] })

    await wrapper.get('[data-testid="dead-replay"]').trigger('click')
    await seconds(8)

    expect(runStatus(wrapper)).toBe('succeeded')
    expect(wrapper.get('[data-testid="run-chain"]').text()).toContain('Replay 2')
    expect(wrapper.findAll('[data-testid="sent-row"]')).toHaveLength(2)
    expect(wrapper.get('[data-testid="sent-summary"]').text()).toContain('Each thing was sent once.')
    expect(wrapper.get('[data-testid="sent-figures"]').text()).toContain('2 sent and 1 recognised and not sent again')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('8 of 10')
    expect(wrapper.find('[data-testid="dead-replayed"]').exists()).toBe(true)
  })

  it('waits for the approval an approval step asks, and the answer the visitor gives decides the branch', async () => {
    const { wrapper } = await openBoard()
    await openLive(wrapper, 'refund-approval')

    await wrapper.get('[data-testid="run"]').trigger('click')
    await seconds(4)

    expect(runStatus(wrapper)).toBe('awaiting_approval')
    expect(wrapper.get('[data-testid="approval-question"]').text()).toContain('is asked:')
    await wrapper.get('[data-testid="approve"]').trigger('click')
    await seconds(6)

    expect(runStatus(wrapper)).toBe('succeeded')
    expect(wrapper.find('[data-testid="approval"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="run-step"][data-status="skipped"]').length).toBeGreaterThan(0)
  })

  it('checks the test order with the service\'s rules, says which field is wrong, and does not run', async () => {
    const { site, wrapper } = await openBoard()
    await openLive(wrapper)

    await wrapper.get('#lb08-order-totalEur').setValue('lots')

    expect(wrapper.get('[data-testid="order-problem"]').text()).toContain('Enter a number.')
    expect(wrapper.get('[data-testid="run"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="run-blocked"]').text()).toContain('Fix the test order first.')
    expect(site.callsTo('/api/lb08/workflows/', 'POST').filter(call => call.path.endsWith('/runs'))).toHaveLength(0)
  })

  it('says the day\'s runs are used up when the back end refuses a run, and turns the button off', async () => {
    const { site, wrapper } = await openBoard()
    await openLive(wrapper)
    site.failNext('POST /api/lb08/workflows/', { status: 429, body: { error: { code: 'daily_limit', message: 'x', resets_at: '2026-10-03T00:00:00Z' } } })

    await wrapper.get('[data-testid="run"]').trigger('click')
    await seconds(1)

    expect(wrapper.get('[data-testid="notice"]').attributes('data-kind')).toBe('quota')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('0 of 10')
    expect(wrapper.get('[data-testid="run"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="run-blocked"]').text()).toContain('Today\'s runs are used up')
  })

  it('leaves the ids and the event names out of the Brief reading, and puts them in the Technical one', async () => {
    const { wrapper } = await openBoard()
    await openLive(wrapper)
    await wrapper.get('[data-testid="run"]').trigger('click')
    await seconds(8)
    expect(wrapper.find('[data-testid="log-event"] .type').exists()).toBe(true)
    expect(wrapper.get('[data-testid="run-progress"]').text()).toContain('order_received')

    useReadingStore().mode = 'brief'
    await flushPromises()

    expect(wrapper.find('[data-testid="log-event"] .type').exists()).toBe(false)
    expect(wrapper.get('[data-testid="run-progress"]').text()).not.toContain('order_received')
  })
})

describe('LB-08\'s board: describing a process, and what can go wrong', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  /** Switches the composer to the visitor's own words and describes a process. */
  async function describeProcess(wrapper: VueWrapper, text: string): Promise<void> {
    await wrapper.findAll('[aria-label="Where the process comes from"] .lb-seg__btn')[1]?.trigger('click')
    await wrapper.get('textarea').setValue(text)
    await wrapper.get('form').trigger('submit')
    await seconds(1)
  }

  it('turns the visitor\'s words into a workflow, which counts as one of the day\'s descriptions and records that a model wrote it', async () => {
    const { site, wrapper } = await openBoard()

    await describeProcess(wrapper, 'When a wholesale order over €500 arrives, check stock, alert the roastery on Slack and email the café an ETA.')

    expect(wrapper.find('[data-testid="editor"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="versions"]').text()).toContain('The model')
    expect(wrapper.get('[data-testid="generations"]').text()).toContain('9 of 10')
    expect(site.callsTo('/api/lb08/workflows', 'POST')[0]?.body).toMatchObject({ from: 'description' })
  })

  it('lists what the checks refused when the model wrote a process that cannot be built, and opens no editor', async () => {
    const { wrapper } = await openBoard()

    await describeProcess(wrapper, 'Whenever a customer leaves a review, send them an SMS to thank them.')

    expect(wrapper.get('[data-testid="refusal"]').text()).toContain('That process cannot be built')
    expect(wrapper.findAll('[data-testid="refusal-problem"]').length).toBeGreaterThan(0)
    expect(wrapper.find('[data-testid="editor"]').exists()).toBe(false)
  })

  it('says describing is unavailable when the model is, and keeps the samples open', async () => {
    const { site, wrapper } = await openBoard()
    site.failNext('POST /api/lb08/workflows', { status: 503, body: { error: { code: 'generation_unavailable', message: 'x' } } })

    await describeProcess(wrapper, 'When a customer asks for a refund, ask finance and email them the answer.')

    expect(wrapper.get('[data-testid="generation-unavailable"]').text()).toContain('Describing is unavailable right now')
    // Not the kit's notice for a deployment with no back end, which says that only recorded samples can be played.
    expect(wrapper.find('[data-testid="notice"]').exists()).toBe(false)
    await wrapper.findAll('[aria-label="Where the process comes from"] .lb-seg__btn')[0]?.trigger('click')
    expect(wrapper.get('[data-testid="start-sample"]').attributes('disabled')).toBeUndefined()
  })

  it('says the visitor keeps as many workflows as are allowed, when the back end says so', async () => {
    const { site, wrapper } = await openBoard()
    site.failNext('POST /api/lb08/workflows', { status: 409, body: { error: { code: 'workflow_limit', message: 'x' } } })

    await choose(wrapper, 'wholesale-order')
    await wrapper.get('[data-testid="start-sample"]').trigger('click')
    await seconds(1)

    expect(wrapper.get('[data-testid="too-many-workflows"]').text()).toContain('Delete one to make another.')
    expect(wrapper.find('[data-testid="editor"]').exists()).toBe(false)
  })

  it('says there is no back end when the deployment has none, and offers nothing it cannot do', async () => {
    const { wrapper } = await openBoard({ available: false })

    expect(wrapper.get('[data-testid="notice"]').attributes('data-kind')).toBe('unavailable')
    expect(wrapper.get('[data-testid="start-sample"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="generations"]').exists()).toBe(false)
  })
})

describe('LB-08\'s board: samples and replays', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('replays a recorded sample as a replay, with no request that could change anything or spend anything', async () => {
    const { site, wrapper } = await openBoard({ recordings: [liveRecording('low-stock-reorder')] })
    await choose(wrapper, 'low-stock-reorder')
    expect(wrapper.get('[data-testid="start-sample"]').text()).toBe('Replay this sample')
    const before = site.calls.length

    await wrapper.get('[data-testid="start-sample"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Replay')
    expect(wrapper.get('[data-testid="replay-banner"]').text()).toContain('Replay of a recorded run')
    await seconds(15)

    expect(wrapper.find('[data-testid="read-only"]').exists()).toBe(true)
    expect(runStatus(wrapper)).toBe('succeeded')
    expect(wrapper.findAll('[data-testid="dead-letter"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="dead-replayed"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="sent-summary"]').text()).toContain('Each thing was sent once.')
    expect(wrapper.get('[data-testid="run"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('10 of 10')
    expect(site.calls.slice(before).map(call => `${call.method} ${call.path}`)).toEqual(['GET /api/recordings/lb-08/low-stock-reorder'])
  })

  it('shows a recorded approval as waiting with nobody to answer', async () => {
    const { wrapper } = await openBoard({ recordings: [liveRecording('refund-approval')] })
    await choose(wrapper, 'refund-approval')
    await wrapper.get('[data-testid="start-sample"]').trigger('click')
    await until(() => wrapper.find('[data-testid="approval"]').exists())

    expect(wrapper.get('[data-testid="approval"]').text()).toContain('This is a replay, so there is nothing to answer.')
    expect(wrapper.find('[data-testid="approve"]').exists()).toBe(false)
  })

  it('replays again, and opens the sample live from the banner', async () => {
    const { site, wrapper } = await openBoard({ recordings: [liveRecording('wholesale-order')] })
    await wrapper.get('[data-testid="start-sample"]').trigger('click')
    await seconds(15)
    const [again, live] = wrapper.findAll('[data-testid="replay-banner"] button')

    await again?.trigger('click')
    await seconds(1)
    expect(wrapper.find('[data-testid="replay-banner"]').exists()).toBe(true)
    await seconds(15)
    await live?.trigger('click')
    await seconds(2)

    expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Live')
    expect(site.callsTo('/api/lb08/workflows', 'POST')).toHaveLength(1)
    expect(wrapper.get('[data-testid="run"]').attributes('disabled')).toBeUndefined()
  })

  it('says a sample without a recording has none, and opens it live', async () => {
    const { site, wrapper } = await openBoard({ recordings: [liveRecording('low-stock-reorder')] })

    await choose(wrapper, 'wholesale-order-cs')
    expect(wrapper.get('[data-testid="no-recording"]').text()).toContain('There is no recording of this sample yet')
    expect(wrapper.get('[data-testid="start-sample"]').text()).toBe('Open this sample live')
    await wrapper.get('[data-testid="start-sample"]').trigger('click')
    await seconds(1)

    expect(wrapper.find('[data-testid="editor"]').exists()).toBe(true)
    expect(site.callsTo('/api/lb08/workflows', 'POST')[0]?.body).toEqual({ from: 'sample', sampleId: 'wholesale-order-cs' })
  })
})

describe('LB-08\'s board in Czech', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('speaks Czech from the limits to the problem at a step, and keeps the part number', async () => {
    const { wrapper } = await openBoard({ locale: 'cs' })

    expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Živě')
    expect(wrapper.text()).toContain('LB-08')
    expect(wrapper.get('[data-testid="quota"]').text()).toMatch(/10\sz\s10/)
    expect(wrapper.text()).toContain('Zbývající běhy workflow dnes')

    await openLive(wrapper)
    await wrapper.get('[data-step="big_order"] [data-testid="outline-remove"]').trigger('click')
    expect(wrapper.get('[data-testid="validity"]').text()).toContain('Problémy:')
    expect(wrapper.get('[data-step="check_stock"] [data-testid="step-problem"]').text()).toContain('se ze spouštěče nedá dojít')
  })

  it('says in Czech that describing is unavailable when the model is, and not that the demo is not connected', async () => {
    const { site, wrapper } = await openBoard({ locale: 'cs' })
    site.failNext('POST /api/lb08/workflows', { status: 503, body: { error: { code: 'generation_unavailable', message: 'x' } } })

    // The composer's second choice is writing the process down; its label is Czech here, so it is found by its place.
    await wrapper.findAll('.switch .lb-seg__btn')[1]?.trigger('click')
    await wrapper.get('textarea').setValue('Když zákazník žádá o vrácení peněz, zeptej se účetní a pošli mu odpověď e-mailem.')
    await wrapper.get('form').trigger('submit')
    await seconds(1)

    expect(wrapper.get('[data-testid="generation-unavailable"]').text()).toContain('Popisování teď není dostupné')
    expect(wrapper.find('[data-testid="notice"]').exists()).toBe(false)
  })

  it('runs a workflow and tells its log in Czech', async () => {
    const { wrapper } = await openBoard({ locale: 'cs' })
    await openLive(wrapper)

    await wrapper.get('[data-testid="run"]').trigger('click')
    await seconds(8)

    expect(runStatus(wrapper)).toBe('succeeded')
    expect(wrapper.get('[data-testid="sent-summary"]').text()).toContain('Každá věc byla odeslána jednou.')
    expect(wrapper.get('[data-testid="run-announce"]').text()).toContain('Běh uspěl.')
  })
})
