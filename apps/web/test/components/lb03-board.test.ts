// Tests of LB-03's whole board, mounted against the fake site: a sample replayed from its recording with no
// request to the back end, a sample read live from its first stage to the checked reading, a field
// corrected and every check run again, a file of the visitor's own, a document the injection check
// stopped, every way an upload can be refused, a deployment with no back end, the Brief reading, the shelf
// of the visitor's documents, and Czech.
import { flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LB03_SAMPLES } from '#shared/data/samples/lb03'

import Lb03Board from '~/boards/lb-03/Lb03Board.vue'
import { useReadingStore } from '~/stores/reading'

import { FakeSite } from '../support/fake-site'
import type { FakeSiteOptions } from '../support/fake-site'
import { recordLb03Sample } from '../support/lb03'
import { seedUpload } from '../support/lb03-files'
import { mountWithSite } from '../support/mount'

/** Mounts the board against a fake site and waits for what it reads when it opens. */
async function openBoard(options: FakeSiteOptions & { locale?: 'en' | 'cs', brief?: boolean, prepare?: (site: FakeSite) => void } = {}) {
  const { locale, brief, prepare, ...siteOptions } = options
  const site = new FakeSite(siteOptions)
  prepare?.(site)
  vi.stubGlobal('fetch', site.fetch)
  vi.stubGlobal('location', new URL('http://site.test/'))
  const wrapper = mountWithSite(Lb03Board, { locale, props: { permalinkFor: (id: string) => `/runs/${id}`, now: Date.parse('2026-10-02T09:30:00.000Z') } })
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

/** Chooses a sample in the picker (they are the radio buttons, in the golden set's order). */
async function chooseSample(wrapper: VueWrapper, id: string): Promise<void> {
  const index = LB03_SAMPLES.findIndex(sample => sample.id === id)
  await wrapper.findAll('[data-testid="sample-picker"] input[type="radio"]')[index]?.setValue(true)
}

/** Starts what the composer offers for the chosen sample: a replay if it has a recording, a live reading if not. */
async function startSample(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('[data-testid="start-sample"]').trigger('click')
  await flushPromises()
}

/** Switches the composer to the visitor's own file, chooses one of the seed's documents and sends it. */
async function uploadOwn(wrapper: VueWrapper, name: string): Promise<void> {
  await wrapper.findAll('.composer .lb-seg__btn')[1]?.trigger('click')
  const upload = seedUpload(name)
  const file = new File([new Uint8Array(upload.bytes)], upload.filename, { type: upload.type })
  const input = wrapper.get('[data-testid="file-input"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}

/** Writes a text with its non-breaking spaces as plain ones. */
function plain(text: string): string {
  return text.replaceAll(' ', ' ')
}

describe('LB-03\'s board', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('opens on the datasheet\'s part, as a live board, with its limits and nothing read yet', async () => {
    const { wrapper } = await openBoard()
    expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Live')
    expect(wrapper.text()).toContain('LB-03')
    expect(wrapper.text()).toContain('Invoice Reader')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('10 of 10')
    expect(wrapper.findAll('[data-testid="sample-picker"] input[type="radio"]')).toHaveLength(6)
    expect(wrapper.get('[data-testid="counters"]').text()).toContain('appear here once you read one')
    expect(wrapper.find('[data-testid="shelf-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="progress"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="viewer"]').exists()).toBe(false)
    expect(wrapper.findAll('tbody tr').length).toBeGreaterThan(0)
  })

  it('asks the back end for nothing that spends quota just by opening', async () => {
    const { site } = await openBoard()
    expect(site.calls.filter(call => call.method !== 'GET')).toEqual([])
    expect(site.callsTo('/api/lb03/quota')).toHaveLength(1)
    expect(site.callsTo('/api/lb03/documents', 'GET')).toHaveLength(1)
    expect(site.callsTo('/api/recordings/lb-03')).toHaveLength(1)
  })

  it('replays a sample from its recording with no request to the back end, and shows the reading under a Replay label', async () => {
    const { site, wrapper } = await openBoard({ recordings: [recordLb03Sample({ origin: 'live', sample: 'planted-total' })] })
    const before = site.calls.length
    await chooseSample(wrapper, 'planted-total')
    expect(wrapper.get('[data-testid="start-sample"]').text()).toBe('Replay this sample')
    await startSample(wrapper)
    expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Replay')
    expect(wrapper.text()).toContain('Replay of a recorded run')
    await seconds(9)

    expect(wrapper.get('[data-testid="viewer"] img').attributes('src')).toBe('/lb03/pages/planted-total-1.jpg')
    expect(wrapper.findAll('[data-testid="field-row"]').length).toBeGreaterThan(15)
    expect(wrapper.get('[data-status="failed"] [data-testid="check-sentence"]').text()).toBe('The subtotal plus the VAT comes to 1193.85, but the total says 1293.85.')
    expect(wrapper.find('[data-testid="edit"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="read-only"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="export-link"]')).toHaveLength(0)
    expect(wrapper.get('[data-testid="scope"]').text()).toContain('Recorded trace')
    // The recording is read from the site itself; nothing is asked of the back end's own routes.
    expect(site.calls.slice(before).map(call => call.path)).toEqual(['/api/recordings/lb-03/planted-total'])
  })

  it('shows a replayed document the injection check stopped: the page, the reason, and the check that flagged it', async () => {
    const { wrapper } = await openBoard({ recordings: [recordLb03Sample({ origin: 'live', sample: 'prompt-injection' })] })
    await chooseSample(wrapper, 'prompt-injection')
    await startSample(wrapper)
    await seconds(9)
    expect(wrapper.get('[data-testid="failure"]').attributes('data-code')).toBe('injection_suspected')
    expect(wrapper.get('[data-testid="viewer"] img').attributes('src')).toBe('/lb03/pages/prompt-injection-1.jpg')
    expect(wrapper.find('[data-testid="fields"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="chain-state"]').map(item => item.text())[1]).toBe('failed')
    expect(wrapper.find('[data-testid="refund"]').exists()).toBe(false)
  })

  it('reads a sample with no recording live: after the check, stage by stage, to a checked reading with the page and its boxes', async () => {
    const { site, wrapper } = await openBoard()
    await chooseSample(wrapper, 'clean-pdf')
    expect(wrapper.find('[data-testid="no-recording"]').exists()).toBe(true)
    await startSample(wrapper)
    expect(site.callsTo('/api/session/verify', 'POST')).toHaveLength(1)
    expect(site.callsTo('/api/lb03/documents', 'POST')).toHaveLength(1)
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('9 of 10')
    expect(wrapper.findAll('[data-testid="stage"]').map(stage => stage.attributes('data-state'))).toEqual(['current', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting'])

    await seconds(2)
    expect(wrapper.findAll('[data-testid="stage"]').map(stage => stage.attributes('data-state'))).toEqual(['done', 'done', 'current', 'waiting', 'waiting', 'waiting'])
    expect(wrapper.get('[data-testid="scope"]').text()).toContain('Waiting for the trace')
    expect(wrapper.find('[data-testid="viewer"]').exists()).toBe(false)

    await seconds(4)
    expect(wrapper.find('[data-testid="progress"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="viewer"] img').attributes('src')).toMatch(/^\/api\/lb03\/documents\/[\w-]+\/pages\/1$/)
    expect(wrapper.findAll('[data-testid="boxes"], [data-testid="box"]').length).toBeGreaterThan(10)
    expect(wrapper.findAll('[data-testid="check"][data-status="passed"]')).toHaveLength(11)
    expect(wrapper.get('[data-testid="counter-state"]').text()).toBe('Read')
    expect(wrapper.get('[data-testid="journal-balance"]').text()).toBe('Balanced: debit equals credit.')
    expect(wrapper.findAll('[data-testid="export-link"]')).toHaveLength(3)
    expect(wrapper.get('[data-testid="duplicate-verdict"]').text()).toContain('Not a duplicate.')
    expect(wrapper.get('[data-testid="scope"]').text()).toContain('invoice reading')
    expect(wrapper.get('[data-testid="scope"] a').attributes('href')).toMatch(/^\/runs\/run-/)
    expect(wrapper.get('[data-testid="shelf"]').findAll('[data-testid="shelf-item"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="viewer-caption"]').text()).toContain('Total')
  })

  it('lights the box of the field the visitor chooses, from the table, from a check and from the page', async () => {
    const { wrapper } = await openBoard()
    await chooseSample(wrapper, 'planted-total')
    await startSample(wrapper)
    await seconds(8)
    const lit = () => wrapper.findAll('[data-testid="box"][data-lit="true"]').map(box => box.attributes('data-path'))
    expect(lit()).toEqual(['total'])
    expect(wrapper.get('[data-testid="viewer-caption"]').text()).toContain('1293.85')

    await wrapper.findAll('[data-testid="look"]')[1]?.trigger('click')
    expect(lit()).toEqual(['vendor'])
    expect(wrapper.get('[data-testid="viewer-caption"]').text()).toContain('Hanseatic Green Coffee GmbH')
    await wrapper.get('[data-testid="check-field"]').trigger('click')
    expect(lit()).toEqual(['total'])
    await wrapper.findAll('[data-testid="box"]')[2]?.trigger('click')
    expect(lit()).toHaveLength(1)
    expect(lit()).not.toEqual(['total'])
  })

  it('corrects a field live and runs every check again: the planted total made right, its journal entry made and its export let go', async () => {
    const { site, wrapper } = await openBoard()
    await chooseSample(wrapper, 'planted-total')
    await startSample(wrapper)
    await seconds(8)
    expect(wrapper.findAll('[data-testid="check"][data-status="failed"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="journal-none"]').text()).toContain('No entry is made while a check that stops the export has failed')
    expect(wrapper.findAll('[data-testid="export-link"]')).toHaveLength(1)

    const total = () => wrapper.findAll('[data-testid="field-row"]').find(row => row.attributes('data-path') === 'total')
    await total()?.get('[data-testid="edit"]').trigger('click')
    await total()?.get('[data-testid="edit-input"]').setValue('1193.85')
    await total()?.get('form').trigger('submit')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)

    expect(site.callsTo('/api/lb03/documents/', 'POST').at(-1)?.body).toEqual({ path: 'total', value: '1193.85' })
    expect(wrapper.findAll('[data-testid="check"][data-status="failed"]')).toHaveLength(0)
    expect(wrapper.get('[data-testid="fields-status"]').text()).toBe('Saved Total. Every check ran again. Checks that fail now: 0.')
    expect(total()?.find('[data-testid="edit-input"]').exists()).toBe(false)
    expect(total()?.get('[data-testid="edited-tag"]').text()).toBe('corrected')
    expect(wrapper.get('[data-testid="correction"]').text()).toBe('Total: was 1293.85, now 1193.85')
    expect(wrapper.find('[data-testid="journal-balance"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="export-link"]')).toHaveLength(3)
    expect(wrapper.get('[data-testid="counter-corrections"]').text()).toBe('1')
    expect(wrapper.get('[data-testid="counter-checks"]').text()).toBe('0 failed of 11')
  })

  it('keeps a value the service refuses open, with the reason, and changes nothing', async () => {
    const { wrapper } = await openBoard()
    await chooseSample(wrapper, 'clean-pdf')
    await startSample(wrapper)
    await seconds(6)
    const row = () => wrapper.findAll('[data-testid="field-row"]').find(item => item.attributes('data-path') === 'issue_date')
    await row()?.get('[data-testid="edit"]').trigger('click')
    await row()?.get('[data-testid="edit-input"]').setValue('14 September')
    await row()?.get('form').trigger('submit')
    await flushPromises()
    expect(row()?.get('[data-testid="edit-problem"]').text()).toContain('That value does not fit this field')
    expect(wrapper.findAll('[data-testid="check"][data-status="passed"]')).toHaveLength(11)
    expect(wrapper.get('[data-testid="counter-corrections"]').text()).toBe('0')
  })

  it('reads a file of the visitor\'s own, after the check, and shows what it came to', async () => {
    const { site, wrapper } = await openBoard()
    await uploadOwn(wrapper, 'euro-vat')
    expect(site.callsTo('/api/lb03/documents', 'POST')[0]?.body).toEqual({ upload: { filename: 'hanse-green-2026-4417.pdf', bytes: 6_452 } })
    await seconds(6)
    expect(wrapper.findAll('[data-testid="field-row"]').find(row => row.attributes('data-path') === 'vat.2.rate')?.get('[data-testid="field-value"]').text()).toBe('19')
    expect(wrapper.get('[data-testid="shelf"]').text()).toContain('hanse-green-2026-4417.pdf')
  })

  it('shows a live document the injection check stopped, with no fields, no export and its steps', async () => {
    const { wrapper } = await openBoard()
    await chooseSample(wrapper, 'prompt-injection')
    await startSample(wrapper)
    await seconds(6)
    expect(wrapper.get('[data-testid="failure"]').text()).toContain('No model was shown it')
    expect(wrapper.get('[data-testid="refund"]').text()).toBe('The document still counts against today\'s allowance.')
    expect(wrapper.find('[data-testid="fields"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="export"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="chain-state"]').map(item => item.text()).slice(0, 3)).toEqual(['done', 'failed', 'not reached'])
    expect(wrapper.get('[data-testid="counter-state"]').text()).toBe('No result')
  })

  it('says each refusal of an upload in its own words, and keeps the replays open', async () => {
    const { site, wrapper } = await openBoard({ verified: true, recordings: [recordLb03Sample({ origin: 'live' })] })
    const refuse = async (status: number, code: string, extra: Record<string, unknown> = {}) => {
      site.failNext('POST /api/lb03/documents', { status, body: { error: { code, message: 'x', ...extra } } })
      await chooseSample(wrapper, 'euro-vat')
      await startSample(wrapper)
    }
    await refuse(413, 'too_large')
    expect(wrapper.get('[data-testid="upload-notice"]').attributes('data-kind')).toBe('too_large')
    expect(wrapper.get('[data-testid="upload-notice"]').text()).toContain('This site passes on files of up to 4 MB.')
    await refuse(415, 'unsupported_file')
    expect(wrapper.get('[data-testid="upload-notice"]').attributes('data-kind')).toBe('unsupported')
    await refuse(429, 'document_running')
    expect(wrapper.get('[data-testid="upload-notice"]').text()).toContain('Two of your documents are being read')
    await refuse(503, 'readers_busy')
    expect(wrapper.get('[data-testid="upload-notice"]').text()).toContain('Every reader is busy')
    await refuse(429, 'daily_limit', { resets_at: '2026-10-03T00:00:00+00:00' })
    expect(wrapper.find('[data-testid="upload-notice"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="notice"]').attributes('data-kind')).toBe('quota')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('0 of 10')
    expect(wrapper.get('[data-testid="live-hint"]').text()).toContain('Today\'s documents are used up')
    await chooseSample(wrapper, 'clean-pdf')
    expect(wrapper.get('[data-testid="start-sample"]').text()).toBe('Replay this sample')
    expect(wrapper.get('[data-testid="start-sample"]').attributes('disabled')).toBeUndefined()
  })

  it('says the file is too big or not a kind the reader takes before it sends anything', async () => {
    const { site, wrapper } = await openBoard({ verified: true })
    await wrapper.findAll('.composer .lb-seg__btn')[1]?.trigger('click')
    const input = wrapper.get('[data-testid="file-input"]')
    Object.defineProperty(input.element, 'files', { value: [new File([new Uint8Array(5 * 1_048_576)], 'big.pdf', { type: 'application/pdf' })], configurable: true })
    await input.trigger('change')
    expect(wrapper.get('[data-testid="file-problem"]').text()).toContain('over 4 MB')
    expect(site.callsTo('/api/lb03/documents', 'POST')).toHaveLength(0)
  })

  it('says this copy of the site has no back end, and keeps the replays', async () => {
    const { wrapper } = await openBoard({ available: false, recordings: [recordLb03Sample({ origin: 'live' })] })
    expect(wrapper.get('[data-testid="notice"]').attributes('data-kind')).toBe('unavailable')
    expect(wrapper.get('[data-testid="start-sample"]').text()).toBe('Replay this sample')
    expect(wrapper.get('[data-testid="start-sample"]').attributes('disabled')).toBeUndefined()
    await chooseSample(wrapper, 'euro-vat')
    expect(wrapper.get('[data-testid="start-sample"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="live-hint"]').text()).toContain('cannot read documents live')
  })

  it('says the reader is off when the service says no model is reachable, and keeps the replays', async () => {
    const { wrapper } = await openBoard({
      recordings: [recordLb03Sample({ origin: 'live' })],
      prepare: (site) => {
        const quota = site.lb03.quota('fake-session').body as Record<string, unknown>
        site.failNext('GET /api/lb03/quota', { status: 200, body: { ...quota, can_read: false } })
      },
    })
    await chooseSample(wrapper, 'euro-vat')
    expect(wrapper.get('[data-testid="live-hint"]').text()).toContain('no model is reachable')
    expect(wrapper.get('[data-testid="start-sample"]').attributes('disabled')).toBeDefined()
    await chooseSample(wrapper, 'clean-pdf')
    expect(wrapper.get('[data-testid="start-sample"]').attributes('disabled')).toBeUndefined()
  })

  it('shows the Brief reading with the demo and the counters, and without the steps and the limits table', async () => {
    const { wrapper } = await openBoard({ brief: true })
    await chooseSample(wrapper, 'clean-pdf')
    await startSample(wrapper)
    await seconds(6)
    expect(wrapper.find('[data-testid="steps"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="counter-calls"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="viewer"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="check"]')).toHaveLength(11)
    expect(wrapper.find('[data-testid="quota"]').exists()).toBe(true)
  })

  it('keeps the visitor\'s documents on a shelf, opens one again, and deletes it', async () => {
    const { site, wrapper } = await openBoard()
    await chooseSample(wrapper, 'clean-pdf')
    await startSample(wrapper)
    await seconds(6)
    await chooseSample(wrapper, 'planted-total')
    await startSample(wrapper)
    await seconds(8)
    const item = (name: string) => wrapper.findAll('[data-testid="shelf-item"]').find(candidate => candidate.text().includes(name))
    expect(wrapper.findAll('[data-testid="shelf-item"]')).toHaveLength(2)
    expect(item('planted-total-hanse-2026-4700.pdf')?.text()).toContain('Checks failed: 1')
    expect(item('bohemia-packaging-2026-0412.pdf')?.text()).toContain('every check passed')

    await item('bohemia-packaging-2026-0412.pdf')?.get('[data-testid="shelf-open"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="check"][data-status="passed"]')).toHaveLength(11)
    expect(wrapper.get('[data-testid="viewer"] img').attributes('alt')).toContain('bohemia-packaging-2026-0412.pdf')

    await item('bohemia-packaging-2026-0412.pdf')?.get('[data-testid="shelf-delete"]').trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    expect(site.callsTo('/api/lb03/documents/', 'DELETE')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="shelf-item"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="viewer"]').exists()).toBe(false)
  })

  it('catches a second copy of a document the visitor already has, before it compares it with the samples', async () => {
    const { wrapper } = await openBoard()
    await chooseSample(wrapper, 'planted-total')
    await startSample(wrapper)
    await seconds(8)
    await startSample(wrapper)
    await seconds(8)
    const verdict = wrapper.get('[data-testid="duplicates"]')
    expect(verdict.attributes('data-verdict')).toBe('duplicate')
    expect(plain(verdict.text())).toContain('Same vendor and number as planted-total-hanse-2026-4700.pdf.')
    expect(wrapper.get('[data-testid="duplicate-kind"]').text()).toContain('the same invoice again')
  })

  it('writes the board in Czech: the picker, the stages, the table, the checklist and the failure', async () => {
    const { wrapper } = await openBoard({ locale: 'cs', recordings: [recordLb03Sample({ origin: 'live', sample: 'planted-total' })] })
    expect(wrapper.text()).toContain('Přečíst dokument')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('10')
    await chooseSample(wrapper, 'planted-total')
    expect(wrapper.get('[data-testid="start-sample"]').text()).toBe('Přehrát tuto ukázku')
    await startSample(wrapper)
    await seconds(9)
    expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Přehrání')
    expect(wrapper.get('[data-status="failed"] [data-testid="check-sentence"]').text()).toBe('Mezisoučet plus DPH dá 1193.85, ale celkem říká 1293.85.')
    expect(wrapper.findAll('tbody .group th').map(item => item.text()).slice(0, 2)).toEqual(['Dokument', 'Řádek 1'])
    expect(wrapper.get('[data-testid="read-only"]').text()).toContain('Je to přehrávka')
    expect(wrapper.get('[data-testid="viewer-caption"]').text()).toContain('Celkem')
  })
})
