// Component tests for LB-03's board parts: the composer, the stages of a reading, why a document has no
// result, the viewer with its boxes, the table of fields and how a value is corrected, the checklist, the
// duplicate verdict, the journal entry, the exports, the pipeline's steps, the counters, the shelf of
// documents and the refusals, in English and in Czech. The documents come from the in-memory mock, so they
// have the shapes the real API's answers have.
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'

import { findSystemIn } from '#shared/data/datasheets'
import { LB03_SAMPLES } from '#shared/data/samples/lb03'

import ChecksPanel from '~/boards/lb-03/components/ChecksPanel.vue'
import DocumentComposer from '~/boards/lb-03/components/DocumentComposer.vue'
import DocumentShelf from '~/boards/lb-03/components/DocumentShelf.vue'
import DocumentViewer from '~/boards/lb-03/components/DocumentViewer.vue'
import DuplicatePanel from '~/boards/lb-03/components/DuplicatePanel.vue'
import ExportPanel from '~/boards/lb-03/components/ExportPanel.vue'
import FieldsTable from '~/boards/lb-03/components/FieldsTable.vue'
import JournalPanel from '~/boards/lb-03/components/JournalPanel.vue'
import ReadFailure from '~/boards/lb-03/components/ReadFailure.vue'
import ReadProgress from '~/boards/lb-03/components/ReadProgress.vue'
import ReadingCounters from '~/boards/lb-03/components/ReadingCounters.vue'
import StepsPanel from '~/boards/lb-03/components/StepsPanel.vue'
import UploadNotice from '~/boards/lb-03/components/UploadNotice.vue'

import { makeCorrected, makeDocument } from '../support/lb03'
import { mountWithSite } from '../support/mount'

/** Writes a text with its non-breaking spaces as plain ones, which is how a person reads it and how a test says it. */
function plain(text: string): string {
  return text.replaceAll('\u00A0', ' ')
}

const PICKER_SAMPLES = LB03_SAMPLES.map(sample => ({ id: sample.id, title: sample.id, note: 'note', language: 'en' as const, excerpt: sample.vendor }))

/** The composer's props with everything on, which a test changes one thing of. */
function composerProps(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { catalog: LB03_SAMPLES, samples: PICKER_SAMPLES, recorded: ['clean-pdf'], busy: false, canRunLive: true, allowanceUsedUp: false, readerOff: false, maxPages: 5, ...over }
}

/** Gives a file input a file, as a browser does when the visitor chooses one, and tells the component. */
async function choose(wrapper: ReturnType<typeof mountWithSite>, file: File): Promise<void> {
  const input = wrapper.get('[data-testid="file-input"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
}

describe('DocumentComposer', () => {
  it('opens on the samples, with the first one chosen and shown as it is printed, and its file to save', () => {
    const wrapper = mountWithSite(DocumentComposer, { props: composerProps() })
    expect(wrapper.findAll('[data-testid="sample-picker"] input[type="radio"]')).toHaveLength(6)
    const preview = wrapper.get('[data-testid="sample-preview"]')
    expect(preview.get('img').attributes('src')).toBe('/lb03/pages/clean-pdf-1.jpg')
    expect(preview.get('img').attributes('alt')).toBe('The first page of the sample "Clean PDF invoice"')
    expect(preview.text()).toContain('Invoice from Bohemia Packaging s.r.o., number 2026-0412, total 10406.00 CZK.')
    const save = wrapper.get('[data-testid="save-sample"]')
    expect(save.attributes('href')).toBe('/lb03/samples/bohemia-packaging-2026-0412.pdf')
    expect(save.attributes('download')).toBe('bohemia-packaging-2026-0412.pdf')
    expect(save.text()).toContain('5.0 kB')
  })

  it('replays a sample that has a recording and reads one that has none live', async () => {
    const wrapper = mountWithSite(DocumentComposer, { props: composerProps() })
    expect(wrapper.get('[data-testid="start-sample"]').text()).toBe('Replay this sample')
    await wrapper.get('[data-testid="start-sample"]').trigger('click')
    expect(wrapper.emitted('replay')).toEqual([['clean-pdf']])
    await wrapper.get('[data-testid="run-sample-live"]').trigger('click')
    expect(wrapper.emitted('runSample')).toEqual([['clean-pdf']])

    await wrapper.findAll('[data-testid="sample-picker"] input[type="radio"]')[5]?.setValue(true)
    expect(wrapper.get('[data-testid="start-sample"]').text()).toBe('Read this sample live')
    expect(wrapper.get('[data-testid="no-recording"]').text()).toContain('no recording of this sample yet')
    await wrapper.get('[data-testid="start-sample"]').trigger('click')
    expect(wrapper.emitted('runSample')?.at(-1)).toEqual(['planted-total'])
  })

  it('starts nothing until it knows whether the sample has a recording, and says why a live reading is off', async () => {
    const waiting = mountWithSite(DocumentComposer, { props: composerProps({ recorded: undefined }) })
    expect(waiting.get('[data-testid="start-sample"]').attributes('disabled')).toBeDefined()
    const used = mountWithSite(DocumentComposer, { props: composerProps({ canRunLive: false, allowanceUsedUp: true, recorded: [] }) })
    expect(used.get('[data-testid="live-hint"]').text()).toContain('Today\'s documents are used up')
    expect(used.get('[data-testid="start-sample"]').attributes('disabled')).toBeDefined()
    const off = mountWithSite(DocumentComposer, { props: composerProps({ canRunLive: false, readerOff: true }) })
    expect(off.get('[data-testid="live-hint"]').text()).toContain('no model is reachable')
    const none = mountWithSite(DocumentComposer, { props: composerProps({ canRunLive: false }) })
    expect(none.get('[data-testid="live-hint"]').text()).toContain('cannot read documents live')
  })

  it('takes a file of the visitor\'s own once it is a kind the reader knows and fits what the site passes on', async () => {
    const wrapper = mountWithSite(DocumentComposer, { props: composerProps() })
    await wrapper.findAll('.lb-seg__btn')[1]?.trigger('click')
    expect(wrapper.get('[data-testid="file-chosen"]').text()).toBe('No file chosen yet.')
    expect(wrapper.get('[data-testid="upload"]').attributes('disabled')).toBeDefined()

    const file = new File([new Uint8Array(2_048)], 'invoice.pdf', { type: 'application/pdf' })
    await choose(wrapper, file)
    expect(wrapper.get('[data-testid="file-chosen"]').text()).toBe('Chosen: invoice.pdf, 2.0 kB.')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('upload')).toEqual([[file]])
  })

  it('says why a file is not worth sending, and keeps the button off', async () => {
    const wrapper = mountWithSite(DocumentComposer, { props: composerProps() })
    await wrapper.findAll('.lb-seg__btn')[1]?.trigger('click')
    await choose(wrapper, new File([new Uint8Array(4 * 1_048_576 + 1)], 'big.pdf', { type: 'application/pdf' }))
    expect(wrapper.get('[data-testid="file-problem"]').text()).toBe('That file is over 4 MB, which is as much as this site passes on.')
    expect(wrapper.get('[data-testid="file-problem"]').attributes('role')).toBe('alert')
    expect(wrapper.get('[data-testid="upload"]').attributes('disabled')).toBeDefined()
    await choose(wrapper, new File([new Uint8Array(10)], 'logo.svg', { type: 'image/svg+xml' }))
    expect(wrapper.get('[data-testid="file-problem"]').text()).toBe('Only PDF, PNG, JPEG and WebP files are read.')
    await choose(wrapper, new File([], 'empty.pdf', { type: 'application/pdf' }))
    expect(wrapper.get('[data-testid="file-problem"]').text()).toBe('That file is empty.')
    expect(wrapper.emitted('upload')).toBeUndefined()
  })

  it('says the same in Czech', async () => {
    const wrapper = mountWithSite(DocumentComposer, { locale: 'cs', props: composerProps() })
    expect(wrapper.get('[data-testid="start-sample"]').text()).toBe('Přehrát tuto ukázku')
    await wrapper.findAll('.lb-seg__btn')[1]?.trigger('click')
    await choose(wrapper, new File([new Uint8Array(10)], 'notes.txt', { type: 'text/plain' }))
    expect(wrapper.get('[data-testid="file-problem"]').text()).toBe('Čtou se jen soubory PDF, PNG, JPEG a WebP.')
  })
})

describe('ReadProgress', () => {
  it('marks the stages as the document stands, in words and in order, and counts the seconds since the file was taken', () => {
    const document = makeDocument({ sample: 'clean-pdf', until: 'extract' })
    const wrapper = mountWithSite(ReadProgress, { props: { document, startedAt: 1_000_000, limitSeconds: 300, replaying: false, now: 1_012_000 } })
    const stages = wrapper.findAll('[data-testid="stage"]')
    expect(stages.map(stage => stage.attributes('data-state'))).toEqual(['done', 'done', 'current', 'waiting', 'waiting', 'waiting'])
    expect(stages.map(stage => stage.get('.state').text())).toEqual(['done', 'done', 'now', 'waiting', 'waiting', 'waiting'])
    expect(wrapper.get('[data-testid="elapsed"]').text()).toBe('12 s since the service took the file. The board stops waiting after 300 s.')
    expect(wrapper.text()).toContain('no percentage is shown')
    expect(wrapper.find('[data-testid="slow"]').exists()).toBe(false)
  })

  it('says how many documents are ahead, in the form each language\'s plural asks for', () => {
    const waiting = { ...makeDocument({ sample: 'clean-pdf', until: 'uploaded' }), state: 'uploaded' as const }
    const ahead = (count: number | null, locale: 'en' | 'cs') => mountWithSite(ReadProgress, { locale, props: { document: { ...waiting, queued_ahead: count }, startedAt: 1, limitSeconds: 300, replaying: false, now: 1 } }).find('[data-testid="queue"]').text()
    expect(ahead(0, 'en')).toBe('Yours is next: it starts as soon as a reader is free.')
    expect(ahead(1, 'en')).toBe('1 document is ahead of this one.')
    expect(ahead(3, 'en')).toBe('3 documents are ahead of this one.')
    expect(ahead(1, 'cs')).toBe('Před tímto dokumentem je 1 dokument.')
    expect(ahead(3, 'cs')).toBe('Před tímto dokumentem jsou 3 dokumenty.')
    expect(ahead(7, 'cs')).toBe('Před tímto dokumentem je 7 dokumentů.')
    const none = mountWithSite(ReadProgress, { props: { document: { ...waiting, state: 'ocr' as const, queued_ahead: null }, startedAt: 1, limitSeconds: 300, replaying: false, now: 1 } })
    expect(none.find('[data-testid="queue"]').exists()).toBe(false)
  })

  it('says a reading is taking longer than usual once it has gone on for 45 seconds', () => {
    const document = makeDocument({ sample: 'clean-pdf', until: 'validate' })
    const wrapper = mountWithSite(ReadProgress, { props: { document, startedAt: 0, limitSeconds: 300, replaying: false, now: 46_000 } })
    expect(wrapper.get('[data-testid="slow"]').text()).toContain('taking longer than usual')
  })

  it('says the file is being sent before there is a document, with every stage waiting', () => {
    const wrapper = mountWithSite(ReadProgress, { props: { document: undefined, startedAt: undefined, limitSeconds: 300, replaying: false } })
    expect(wrapper.get('.title').text()).toBe('Sending the file…')
    expect(wrapper.findAll('[data-testid="stage"]').every(stage => stage.attributes('data-state') === 'waiting')).toBe(true)
    expect(wrapper.find('[data-testid="elapsed"]').exists()).toBe(false)
  })

  it('says it is a replay, with no clock, and writes the stages in Czech', () => {
    const document = makeDocument({ sample: 'clean-pdf', until: 'ocr' })
    const wrapper = mountWithSite(ReadProgress, { locale: 'cs', props: { document, startedAt: undefined, limitSeconds: 300, replaying: true } })
    expect(wrapper.get('.title').text()).toBe('Přehrávám nahrané čtení')
    expect(wrapper.find('[data-testid="elapsed"]').exists()).toBe(false)
    expect(wrapper.findAll('.state').map(item => item.text())).toEqual(['hotovo', 'právě teď', 'čeká', 'čeká', 'čeká', 'čeká'])
  })

  it('marks the repair a document needed none of as not needed and the stage a failed document stopped at', () => {
    const clean = mountWithSite(ReadProgress, { props: { document: makeDocument({ sample: 'clean-pdf' }), startedAt: 0, limitSeconds: 300, replaying: false, now: 5_000 } })
    expect(clean.findAll('[data-testid="stage"]').map(stage => stage.attributes('data-state'))).toEqual(['done', 'done', 'done', 'done', 'skipped', 'done'])
    const hostile = mountWithSite(ReadProgress, { props: { document: makeDocument({ sample: 'prompt-injection' }), startedAt: 0, limitSeconds: 300, replaying: false, now: 5_000 } })
    expect(hostile.findAll('[data-testid="stage"]').map(stage => stage.attributes('data-state'))).toEqual(['done', 'done', 'failed', 'waiting', 'waiting', 'waiting'])
    expect(hostile.findAll('.state').map(item => item.text())[2]).toBe('stopped here')
  })
})

describe('ReadFailure', () => {
  it('says why the injection check stopped a document, with its score, in both languages', () => {
    const document = makeDocument({ sample: 'prompt-injection' })
    const english = mountWithSite(ReadFailure, { props: { document, replaying: false } })
    expect(english.get('[data-testid="failure"]').attributes('data-code')).toBe('injection_suspected')
    expect(english.text()).toContain('No model was shown it, so nothing in it could change what was read.')
    expect(english.get('[data-testid="guard-score"]').text()).toBe('The injection check\'s score for the text was 0.99.')
    const czech = mountWithSite(ReadFailure, { locale: 'cs', props: { document, replaying: false } })
    expect(czech.text()).toContain('Žádný model ho neviděl')
    expect(czech.get('[data-testid="guard-score"]').text()).toContain('0,99')
  })

  it('says whether the document is given back to the day: a file the reader cannot take counts, the service\'s own failure does not', () => {
    const base = makeDocument({ sample: 'prompt-injection' })
    const counted = mountWithSite(ReadFailure, { props: { document: base, replaying: false } })
    expect(counted.get('[data-testid="refund"]').text()).toBe('The document still counts against today\'s allowance.')
    const service = mountWithSite(ReadFailure, { props: { document: { ...base, failure: { code: 'model_budget', message: 'x' } }, replaying: false } })
    expect(service.get('[data-testid="refund"]').text()).toBe('This failure was the service\'s, so the document is given back to your day (up to 3 a day).')
    const replay = mountWithSite(ReadFailure, { props: { document: base, replaying: true } })
    expect(replay.find('[data-testid="refund"]').exists()).toBe(false)
  })

  it('has its own sentence for every failure code', () => {
    const base = makeDocument({ sample: 'prompt-injection' })
    const codes = ['unsupported_file', 'too_large', 'too_many_pages', 'image_too_big', 'unreadable_file', 'unsafe_file', 'no_text', 'ocr_failed', 'injection_suspected', 'unchecked', 'model_failed', 'model_budget', 'model_output', 'time_limit', 'call_limit', 'interrupted'] as const
    const texts = codes.map(code => mountWithSite(ReadFailure, { props: { document: { ...base, failure: { code, message: 'x' } }, replaying: true } }).get('.text').text())
    expect(new Set(texts).size).toBe(16)
    for (const text of texts) expect(text).not.toMatch(/lb03\./)
  })

  it('shows nothing for a document that did not fail', () => {
    const wrapper = mountWithSite(ReadFailure, { props: { document: makeDocument(), replaying: false } })
    expect(wrapper.find('[data-testid="failure"]').exists()).toBe(false)
  })
})

describe('DocumentViewer', () => {
  const document = makeDocument({ sample: 'planted-total' })
  const props = { pictureUrl: '/lb03/pages/planted-total-1.jpg', page: 1, pages: 1, fields: document.fields, selected: 'total', label: 'planted.pdf' }

  it('draws a box for every field found on the page, and lights the one that is looked at', () => {
    const wrapper = mountWithSite(DocumentViewer, { props })
    const boxes = wrapper.findAll('[data-testid="box"]')
    expect(boxes.length).toBe(document.fields?.filter(field => field.box !== null).length)
    const lit = boxes.filter(box => box.attributes('data-lit') === 'true')
    expect(lit.map(box => box.attributes('data-path'))).toEqual(['total'])
    expect(boxes.at(-1)?.attributes('data-path')).toBe('total')
    expect(wrapper.get('[data-testid="page-picture"]').attributes('src')).toBe('/lb03/pages/planted-total-1.jpg')
    expect(wrapper.get('[data-testid="page-picture"]').attributes('alt')).toBe('Page 1 of 1 of the document planted.pdf')
    expect(wrapper.get('svg').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('svg').attributes('viewBox')).toBe('0 0 1 1')
  })

  it('says in words what is lit, where it is and how sure the reader is, and not by colour alone', () => {
    const wrapper = mountWithSite(DocumentViewer, { props })
    const caption = wrapper.get('[data-testid="viewer-caption"]')
    const total = document.fields?.find(field => field.path === 'total')
    expect(caption.text()).toContain('Total')
    expect(caption.text()).toContain(total?.value ?? '?')
    expect(caption.text()).toMatch(/On page 1\. Confidence (high|medium|low), \d+%\./)
  })

  it('draws each band of confidence with its own kind of line', () => {
    const fields = [
      { path: 'vendor', kind: 'text' as const, value: 'A', box: { page: 1, quad: [0.1, 0.1, 0.2, 0.1, 0.2, 0.2, 0.1, 0.2], confidence: 0.95, match: 1, band: 'high' as const }, edited: false, checks: [] },
      { path: 'currency', kind: 'currency' as const, value: 'CZK', box: { page: 1, quad: [0.3, 0.1, 0.4, 0.1, 0.4, 0.2, 0.3, 0.2], confidence: 0.8, match: 1, band: 'medium' as const }, edited: false, checks: [] },
      { path: 'total', kind: 'amount' as const, value: '1', box: { page: 1, quad: [0.5, 0.1, 0.6, 0.1, 0.6, 0.2, 0.5, 0.2], confidence: 0.6, match: 1, band: 'low' as const }, edited: false, checks: [] },
    ]
    const wrapper = mountWithSite(DocumentViewer, { props: { ...props, fields, selected: undefined } })
    expect(wrapper.findAll('[data-testid="box"]').map(box => box.classes().find(name => name.startsWith('line-')))).toEqual(['line-solid', 'line-dashed', 'line-dotted'])
    expect(wrapper.get('[data-testid="viewer-caption"]').text()).toBe('Choose a field in the table to see where it is on the page.')
  })

  it('looks at a field when its box is clicked, and draws only the lit box when every box is switched off', async () => {
    const wrapper = mountWithSite(DocumentViewer, { props })
    await wrapper.findAll('[data-testid="box"]')[0]?.trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual([document.fields?.find(field => field.box !== null)?.path])
    await wrapper.get('[data-testid="show-all"]').setValue(false)
    expect(wrapper.findAll('[data-testid="box"]')).toHaveLength(1)
  })

  it('draws only the boxes of the page being shown, and pages through a document of several', async () => {
    const field = (path: string, page: number) => ({ path, kind: 'text' as const, value: path, box: { page, quad: [0.1, 0.1, 0.2, 0.1, 0.2, 0.2, 0.1, 0.2], confidence: 0.95, match: 1, band: 'high' as const }, edited: false, checks: [] })
    const wrapper = mountWithSite(DocumentViewer, { props: { ...props, pages: 3, page: 2, fields: [field('vendor', 1), field('currency', 2), field('total', 3)], selected: undefined } })
    expect(wrapper.findAll('[data-testid="box"]').map(box => box.attributes('data-path'))).toEqual(['currency'])
    expect(wrapper.get('[data-testid="page-of"]').text()).toBe('Page 2 of 3')
    await wrapper.get('[data-testid="next-page"]').trigger('click')
    await wrapper.get('[data-testid="previous-page"]').trigger('click')
    expect(wrapper.emitted('page')).toEqual([[3], [1]])
  })

  it('has no pager for a document of one page, and no box and an apology for a picture that cannot be loaded', async () => {
    const wrapper = mountWithSite(DocumentViewer, { props })
    expect(wrapper.find('[data-testid="page-of"]').exists()).toBe(false)
    await wrapper.get('[data-testid="page-picture"]').trigger('error')
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.get('[data-testid="picture-missing"]').text()).toBe('The picture of this page is not available. The fields are still the reading.')
  })

  it('says a field has no box because it was typed in, or because it was not found', () => {
    const typed = { path: 'total', kind: 'amount' as const, value: '1', box: null, edited: true, checks: [] }
    expect(mountWithSite(DocumentViewer, { props: { ...props, fields: [typed], selected: 'total' } }).get('.where').text()).toBe('You typed this value, so it has no box on the page.')
    expect(mountWithSite(DocumentViewer, { props: { ...props, fields: [{ ...typed, edited: false }], selected: 'total' } }).get('.where').text()).toBe('This value was not found among the words read from the page.')
  })
})

describe('FieldsTable', () => {
  const planted = makeDocument({ sample: 'planted-total' })
  const baseProps = { fields: planted.fields ?? [], selected: 'total', editable: true, busy: false, problem: undefined, status: '', checks: planted.checks ?? [], corrections: [] }

  it('lists every field in the order a person reads an invoice, with its value, its place and how sure the reader is', () => {
    const wrapper = mountWithSite(FieldsTable, { props: baseProps })
    const rows = wrapper.findAll('[data-testid="field-row"]')
    expect(rows).toHaveLength(planted.fields?.length ?? 0)
    expect(rows[0]?.attributes('data-path')).toBe('document_type')
    expect(rows.at(-1)?.attributes('data-path')).toBe('total')
    const headings = wrapper.findAll('tbody .group th').map(item => item.text())
    expect(headings.slice(0, 3)).toEqual(['Document', 'Line 1', 'Line 2'])
    expect(headings.at(-1)).toBe('Total')
    const total = rows.at(-1)
    expect(total?.get('[data-testid="field-value"]').text()).toBe('1293.85')
    expect(total?.get('[data-testid="sureness"]').text()).toMatch(/^(high|medium|low), \d+%$/)
    expect(total?.attributes('class')).toContain('chosen')
  })

  it('names the check that failed on a field, in words with an icon', () => {
    const wrapper = mountWithSite(FieldsTable, { props: baseProps })
    const total = wrapper.findAll('[data-testid="field-row"]').at(-1)
    expect(total?.get('[data-testid="field-check"]').text()).toBe('Subtotal plus VAT is the total')
    expect(wrapper.findAll('[data-testid="field-check"]')).toHaveLength(1)
  })

  it('lights the field\'s box when its name is chosen, and says so to a screen reader', async () => {
    const wrapper = mountWithSite(FieldsTable, { props: baseProps })
    const look = wrapper.findAll('[data-testid="look"]')[1]
    expect(look?.attributes('aria-label')).toBe('Show Vendor on the page')
    await look?.trigger('click')
    expect(wrapper.emitted('select')).toEqual([['vendor']])
    expect(wrapper.findAll('[data-testid="look"]').at(-1)?.attributes('aria-pressed')).toBe('true')
  })

  it('opens an input that fits the field, sends what was typed on Enter, and closes when the service has taken it', async () => {
    const wrapper = mountWithSite(FieldsTable, { props: baseProps })
    const total = () => wrapper.findAll('[data-testid="field-row"]').at(-1)
    await total()?.get('[data-testid="edit"]').trigger('click')
    await nextTick()
    const input = total()?.get('[data-testid="edit-input"]')
    expect(input?.attributes('inputmode')).toBe('decimal')
    expect((input?.element as HTMLInputElement).value).toBe('1293.85')
    expect(document.activeElement).toBe(input?.element)
    expect(total()?.text()).toContain('Write the amount with a decimal point')
    await input?.setValue('1193.85')
    await total()?.get('form').trigger('submit')
    expect(wrapper.emitted('correct')).toEqual([['total', '1193.85']])

    await wrapper.setProps({ busy: true })
    expect(total()?.get('[data-testid="save-edit"]').text()).toBe('Saving…')
    expect(total()?.get('[data-testid="save-edit"]').attributes('disabled')).toBeDefined()
    await wrapper.setProps({ busy: false })
    await nextTick()
    expect(total()?.find('[data-testid="edit-input"]').exists()).toBe(false)
    expect(document.activeElement).toBe(total()?.get('[data-testid="edit"]').element)
  })

  it('stays open with the reason when the service refuses the value, and leaves on Escape', async () => {
    const wrapper = mountWithSite(FieldsTable, { props: baseProps })
    const total = () => wrapper.findAll('[data-testid="field-row"]').at(-1)
    await total()?.get('[data-testid="edit"]').trigger('click')
    await total()?.get('[data-testid="edit-input"]').setValue('abc')
    await total()?.get('form').trigger('submit')
    await wrapper.setProps({ busy: true })
    await wrapper.setProps({ busy: false, problem: 'invalid' })
    expect(total()?.get('[data-testid="edit-problem"]').text()).toBe('That value does not fit this field. Check how it is written, or leave it empty to empty the field.')
    expect(total()?.get('[data-testid="edit-problem"]').attributes('role')).toBe('alert')
    expect(total()?.get('[data-testid="edit-input"]').attributes('aria-invalid')).toBe('true')
    await total()?.get('[data-testid="edit-input"]').trigger('keydown', { key: 'Escape' })
    expect(total()?.find('[data-testid="edit-input"]').exists()).toBe(false)
    await total()?.get('[data-testid="edit"]').trigger('click')
    expect(total()?.find('[data-testid="edit-problem"]').exists()).toBe(false)
  })

  it('offers a choice for the kind of document, a list of currencies, and a date format hint', async () => {
    const wrapper = mountWithSite(FieldsTable, { props: baseProps })
    const row = (path: string) => wrapper.findAll('[data-testid="field-row"]').find(candidate => candidate.attributes('data-path') === path)
    await row('document_type')?.get('[data-testid="edit"]').trigger('click')
    expect(row('document_type')?.findAll('option').map(option => option.text())).toEqual(['Invoice', 'Credit note', 'Receipt'])
    await row('currency')?.get('[data-testid="edit"]').trigger('click')
    expect(row('currency')?.get('[data-testid="edit-input"]').attributes('list')).toBe('lb03-currencies')
    expect(wrapper.findAll('#lb03-currencies option').map(option => option.attributes('value'))).toEqual(['CZK', 'EUR', 'USD', 'GBP', 'PLN', 'CHF', 'HUF'])
    await row('issue_date')?.get('[data-testid="edit"]').trigger('click')
    expect(row('issue_date')?.text()).toContain('YYYY-MM-DD')
    expect(row('issue_date')?.get('[data-testid="edit-input"]').attributes('inputmode')).toBe('numeric')
  })

  it('marks a corrected field as corrected in words, lists the corrections, and says a field it did not find was not found', () => {
    const corrected = makeCorrected('clean-pdf', [['line_items.0.total', '7500.00']])
    const wrapper = mountWithSite(FieldsTable, { props: { ...baseProps, fields: corrected.fields ?? [], checks: corrected.checks ?? [], corrections: corrected.corrections, selected: undefined } })
    const edited = wrapper.findAll('[data-testid="field-row"]').find(row => row.attributes('data-path') === 'line_items.0.total')
    expect(edited?.get('[data-testid="edited-tag"]').text()).toBe('corrected')
    expect(edited?.get('[data-testid="sureness"]').text()).toBe('typed by you')
    expect(wrapper.get('[data-testid="correction"]').text()).toBe('Line 1: Line total: was 7400.00, now 7500.00')
  })

  it('shows no Edit button and says why for a replay', () => {
    const wrapper = mountWithSite(FieldsTable, { props: { ...baseProps, editable: false } })
    expect(wrapper.find('[data-testid="edit"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="read-only"]').text()).toContain('This is a replay')
  })

  it('says what a correction did in a live region, and writes the table in Czech', () => {
    const wrapper = mountWithSite(FieldsTable, { locale: 'cs', props: { ...baseProps, status: 'Uloženo: Celkem. Všechny kontroly proběhly znovu. Nesplněných kontrol: 0.' } })
    expect(wrapper.get('[data-testid="fields-status"]').attributes('role')).toBe('status')
    expect(wrapper.get('[data-testid="fields-status"]').text()).toContain('Uloženo')
    expect(wrapper.findAll('tbody .group th').map(item => item.text()).slice(0, 2)).toEqual(['Dokument', 'Řádek 1'])
    expect(wrapper.findAll('thead th').map(item => item.text()).slice(0, 4)).toEqual(['Pole', 'Hodnota', 'Na stránce', 'Nesplněné kontroly'])
  })
})

describe('ChecksPanel', () => {
  it('lists the eleven checks in order, each with what became of it in words', () => {
    const document = makeDocument({ sample: 'planted-total' })
    const wrapper = mountWithSite(ChecksPanel, { props: { checks: document.checks ?? [], fields: document.fields ?? [], selected: undefined } })
    const rows = wrapper.findAll('[data-testid="check"]')
    expect(rows.map(row => row.attributes('data-check'))).toEqual(['required_fields', 'dates_valid', 'currency_known', 'signs_agree', 'line_math', 'line_items_sum', 'vat_math', 'vat_bases', 'total_reconciles', 'fields_on_page', 'not_duplicate'])
    expect(rows.map(row => row.get('[data-testid="check-status"]').text())).toEqual(['Passed', 'Passed', 'Passed', 'Passed', 'Passed', 'Passed', 'Passed', 'Passed', 'Failed, stops the export', 'Passed', 'Passed'])
    expect(wrapper.get('[data-testid="checks-summary"]').text()).toBe('Passed: 10. Failed, stops the export: 1. Warnings: 0. Not run: 0.')
  })

  it('tells a failed check in a sentence with the numbers, and its fields look at the page', async () => {
    const document = makeDocument({ sample: 'planted-total' })
    const wrapper = mountWithSite(ChecksPanel, { props: { checks: document.checks ?? [], fields: document.fields ?? [], selected: 'total' } })
    const failed = wrapper.get('[data-status="failed"]')
    expect(failed.attributes('data-severity')).toBe('error')
    expect(failed.get('[data-testid="check-sentence"]').text()).toBe('The subtotal plus the VAT comes to 1193.85, but the total says 1293.85.')
    const link = failed.get('[data-testid="check-field"]')
    expect(link.text()).toBe('Total')
    expect(link.attributes('aria-pressed')).toBe('true')
    await link.trigger('click')
    expect(wrapper.emitted('select')).toEqual([['total']])
  })

  it('says a warning is a warning, a check that could not run was not run, and a passed check has no sentence', () => {
    const document = makeDocument({ sample: 'handwritten-receipt' })
    const wrapper = mountWithSite(ChecksPanel, { props: { checks: document.checks ?? [], fields: document.fields ?? [], selected: undefined } })
    const warning = wrapper.get('[data-check="fields_on_page"]')
    expect(warning.get('[data-testid="check-status"]').text()).toBe('Warning')
    expect(warning.attributes('data-severity')).toBe('warning')
    expect(warning.findAll('[data-testid="check-field"]').length).toBeLessThanOrEqual(6)
    expect(wrapper.get('[data-check="required_fields"]').find('[data-testid="check-sentence"]').exists()).toBe(false)
    const skipped = mountWithSite(ChecksPanel, { props: { checks: [{ id: 'vat_bases', status: 'skipped', severity: 'error', message: '', fields: [], expected: null, actual: null }], fields: [], selected: undefined } })
    expect(skipped.get('[data-testid="check-status"]').text()).toBe('Not run')
    expect(skipped.text()).toContain('the numbers this check needs are not on the document')
  })

  it('writes the checklist in Czech', () => {
    const document = makeDocument({ sample: 'planted-total' })
    const wrapper = mountWithSite(ChecksPanel, { locale: 'cs', props: { checks: document.checks ?? [], fields: document.fields ?? [], selected: undefined } })
    expect(wrapper.get('[data-status="failed"] [data-testid="check-sentence"]').text()).toBe('Mezisoučet plus DPH dá 1193.85, ale celkem říká 1293.85.')
    expect(wrapper.get('[data-status="failed"] [data-testid="check-status"]').text()).toBe('Nesplněno, zastaví export')
  })
})

describe('DuplicatePanel', () => {
  const passed = makeDocument({ sample: 'clean-pdf' }).checks?.find(check => check.id === 'not_duplicate')

  it('says a document is not a duplicate, and how many it was compared with', () => {
    const wrapper = mountWithSite(DuplicatePanel, { props: { duplicate: null, check: passed, compared: 6, known: [] } })
    expect(wrapper.attributes('data-verdict')).toBe('none')
    expect(wrapper.get('[data-testid="duplicate-verdict"]').text()).toContain('Not a duplicate.')
    expect(wrapper.get('[data-testid="compared"]').text()).toBe('Compared with 6 documents: your others of this hour, and the samples.')
  })

  it('names the sample a document repeats by its title, and says whether the content is the same too', () => {
    const wrapper = mountWithSite(DuplicatePanel, { props: { duplicate: { of: 'clean-pdf', source: 'sample', same_content: true }, check: undefined, compared: undefined, known: [] } })
    expect(wrapper.attributes('data-verdict')).toBe('duplicate')
    expect(wrapper.text()).toContain('Same vendor and number as the sample "Clean PDF invoice".')
    expect(wrapper.get('[data-testid="duplicate-kind"]').text()).toBe('The content is the same too: this is the same invoice again.')
    expect(wrapper.text()).toContain('A duplicate stops the export')
  })

  it('names one of the visitor\'s documents by its file, or says another when it is gone, and says different content differs', () => {
    const known = [{ id: 'abcdefgh', state: 'ready' as const, failure: null, label: 'first.pdf', kind: 'pdf' as const, byte_size: 10, pages: 1, created_at: '2026-10-02T09:30:00+00:00', expires_at: '2026-10-02T10:30:00+00:00', checks_failed: 0, can_export: true }]
    const named = mountWithSite(DuplicatePanel, { props: { duplicate: { of: 'abcdefgh', source: 'document', same_content: false }, check: undefined, compared: undefined, known } })
    expect(named.text()).toContain('Same vendor and number as first.pdf.')
    expect(named.get('[data-testid="duplicate-kind"]').text()).toContain('The content differs')
    const gone = mountWithSite(DuplicatePanel, { props: { duplicate: { of: 'zzzzzzzz', source: 'document', same_content: true }, check: undefined, compared: undefined, known } })
    expect(gone.text()).toContain('Same vendor and number as another of your documents.')
  })

  it('says it could not compare a document with no vendor or number, in Czech too', () => {
    const skipped = { id: 'not_duplicate' as const, status: 'skipped' as const, severity: 'error' as const, message: '', fields: [], expected: null, actual: null }
    const wrapper = mountWithSite(DuplicatePanel, { locale: 'cs', props: { duplicate: null, check: skipped, compared: undefined, known: [] } })
    expect(wrapper.attributes('data-verdict')).toBe('skipped')
    expect(wrapper.text()).toContain('Nesrovnáno')
  })
})

describe('JournalPanel', () => {
  it('shows the entry the document makes, its totals, and that debit equals credit', () => {
    const document = makeDocument({ sample: 'clean-pdf' })
    const wrapper = mountWithSite(JournalPanel, { props: { journal: document.journal, status: document.journal_status } })
    const lines = wrapper.findAll('[data-testid="journal-line"]')
    expect(lines.length).toBeGreaterThanOrEqual(3)
    expect(wrapper.get('[data-testid="journal-totals"]').text()).toContain('10406.00')
    expect(wrapper.get('[data-testid="journal-balance"]').text()).toBe('Balanced: debit equals credit.')
    expect(wrapper.text()).toContain('in CZK')
    expect(wrapper.findAll('thead th').map(item => item.text())).toEqual(['Account', 'Name', 'Debit', 'Credit', 'Memo'])
  })

  it('says why there is no entry: a failed check holds it back, or the lines do not balance', () => {
    const planted = makeDocument({ sample: 'planted-total' })
    const held = mountWithSite(JournalPanel, { props: { journal: planted.journal, status: planted.journal_status } })
    expect(planted.journal_status).toBe('blocked_by_checks')
    expect(held.get('[data-testid="journal-none"]').text()).toContain('No entry is made while a check that stops the export has failed')
    const unbalanced = mountWithSite(JournalPanel, { props: { journal: null, status: 'does_not_balance' } })
    expect(unbalanced.get('[data-testid="journal-none"]').text()).toContain('do not make a balanced entry')
  })

  it('writes the entry\'s words in Czech', () => {
    const document = makeDocument({ sample: 'clean-pdf' })
    const wrapper = mountWithSite(JournalPanel, { locale: 'cs', props: { journal: document.journal, status: document.journal_status } })
    expect(wrapper.findAll('thead th').map(item => item.text())).toEqual(['Účet', 'Název', 'Má dáti', 'Dal', 'Poznámka'])
    expect(wrapper.get('[data-testid="journal-balance"]').text()).toContain('Vyrovnáno')
  })
})

describe('ExportPanel', () => {
  it('offers three downloads as plain links with the names the service gives the files', () => {
    const wrapper = mountWithSite(ExportPanel, { props: { documentId: 'Ab-1_2345', canExport: true, journalMade: true, live: true } })
    const links = wrapper.findAll('[data-testid="export-link"]')
    expect(links.map(link => link.attributes('href'))).toEqual([
      '/api/lb03/documents/Ab-1_2345/export?format=csv',
      '/api/lb03/documents/Ab-1_2345/export?format=journal',
      '/api/lb03/documents/Ab-1_2345/export?format=json',
    ])
    expect(links.map(link => link.attributes('download'))).toEqual(['invoice-lines.csv', 'journal-entry.csv', 'invoice.json'])
    expect(wrapper.find('[data-testid="export-off"]').exists()).toBe(false)
  })

  it('holds the two CSV files back while a check that stops the export has failed, and says the JSON always goes', () => {
    const wrapper = mountWithSite(ExportPanel, { props: { documentId: 'Ab-1_2345', canExport: false, journalMade: false, live: true } })
    expect(wrapper.findAll('[data-testid="export-link"]').map(link => link.attributes('download'))).toEqual(['invoice.json'])
    expect(wrapper.findAll('[data-testid="export-off"]')).toHaveLength(2)
    expect(wrapper.findAll('[data-testid="export-off"]').every(button => button.attributes('disabled') !== undefined)).toBe(true)
    expect(wrapper.text()).toContain('or take the JSON, which always goes')
  })

  it('says a document with no journal entry has none to export', () => {
    const wrapper = mountWithSite(ExportPanel, { props: { documentId: 'Ab-1_2345', canExport: true, journalMade: false, live: true } })
    expect(wrapper.findAll('[data-testid="export-link"]')).toHaveLength(2)
    expect(wrapper.text()).toContain('This document makes no journal entry.')
  })

  it('offers nothing to download for a replay, and says so in the visitor\'s language', () => {
    const wrapper = mountWithSite(ExportPanel, { locale: 'cs', props: { documentId: 'Ab-1_2345', canExport: true, journalMade: true, live: false } })
    expect(wrapper.findAll('[data-testid="export-link"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-testid="export-off"]')).toHaveLength(3)
    expect(wrapper.text()).toContain('Je to přehrávka')
  })
})

describe('StepsPanel', () => {
  const chain = findSystemIn('lb-03', 'en')?.chain ?? []

  it('shows the nine links of the datasheet\'s chain with what became of each, its time and what it counted', () => {
    const document = makeDocument({ sample: 'clean-pdf' })
    const wrapper = mountWithSite(StepsPanel, { props: { document, chain } })
    const rows = wrapper.findAll('[data-testid="chain-step"]')
    expect(rows.map(row => row.get('.name').text())).toEqual(chain)
    expect(rows.map(row => row.get('[data-testid="chain-state"]').text())).toEqual(['done', 'done', 'done', 'done', 'skipped', 'done', 'done', 'done', 'ready'])
    expect(rows[0]?.text()).toContain('pages1')
    expect(rows[0]?.text()).toContain('syscall filter (seccomp)yes')
    expect(rows[1]?.text()).toContain('score0.01')
    expect(plain(wrapper.get('[data-testid="waited"]').text())).toBe('It waited 40 ms for a reader.')
  })

  it('says what a failed document reached and what it did not, and that a held-back export is held back', () => {
    const hostile = mountWithSite(StepsPanel, { props: { document: makeDocument({ sample: 'prompt-injection' }), chain } })
    expect(hostile.findAll('[data-testid="chain-state"]').map(item => item.text())).toEqual(['done', 'failed', 'not reached', 'not reached', 'not reached', 'not reached', 'not reached', 'not reached', 'not reached'])
    expect(hostile.findAll('[data-testid="chain-step"]')[1]?.text()).toContain('flaggedyes')
    const planted = mountWithSite(StepsPanel, { props: { document: makeDocument({ sample: 'planted-total' }), chain } })
    expect(planted.findAll('[data-testid="chain-state"]').at(-1)?.text()).toBe('held back')
  })

  it('writes the steps in Czech, with the datasheet\'s own Czech names', () => {
    const czechChain = findSystemIn('lb-03', 'cs')?.chain ?? []
    const wrapper = mountWithSite(StepsPanel, { locale: 'cs', props: { document: makeDocument({ sample: 'clean-pdf' }), chain: czechChain } })
    expect(wrapper.findAll('[data-testid="chain-step"] .name').map(item => item.text())).toEqual(czechChain)
    expect(wrapper.findAll('[data-testid="chain-state"]')[4]?.text()).toBe('přeskočeno')
    expect(plain(wrapper.text())).toContain('Na čtečku čekal 40 ms.')
  })
})

describe('ReadingCounters', () => {
  it('shows the counters of the document on the board, and how many model calls of the five it used', () => {
    const document = makeDocument({ sample: 'planted-total' })
    const wrapper = mountWithSite(ReadingCounters, { props: { document, quota: undefined, brief: false, replaying: false } })
    expect(wrapper.get('[data-testid="counter-state"]').text()).toBe('Read')
    expect(wrapper.get('[data-testid="counter-calls"]').text()).toBe('3 of 5')
    expect(wrapper.get('[data-testid="counter-checks"]').text()).toBe('1 failed of 11')
    expect(wrapper.get('[data-testid="counter-corrections"]').text()).toBe('0')
    expect(wrapper.text()).toContain('Deleted after')
  })

  it('shows fewer counters in the Brief reading, none of a document that is not there, and no expiry for a replay', () => {
    const document = makeDocument({ sample: 'clean-pdf' })
    const brief = mountWithSite(ReadingCounters, { props: { document, quota: undefined, brief: true, replaying: false } })
    expect(brief.find('[data-testid="counter-calls"]').exists()).toBe(false)
    const empty = mountWithSite(ReadingCounters, { props: { document: undefined, quota: undefined, brief: false, replaying: false } })
    expect(empty.text()).toContain('appear here once you read one')
    const replay = mountWithSite(ReadingCounters, { props: { document, quota: undefined, brief: false, replaying: true } })
    expect(replay.text()).not.toContain('Deleted after')
  })

  it('writes the counters in Czech', () => {
    const wrapper = mountWithSite(ReadingCounters, { locale: 'cs', props: { document: makeDocument({ sample: 'planted-total' }), quota: undefined, brief: false, replaying: false } })
    expect(wrapper.get('[data-testid="counter-state"]').text()).toBe('Přečteno')
    expect(plain(wrapper.get('[data-testid="counter-calls"]').text())).toBe('3 z 5')
    expect(plain(wrapper.get('[data-testid="counter-checks"]').text())).toBe('nesplněno 1 z 11')
  })
})

describe('DocumentShelf', () => {
  const summary = (id: string, state: 'ready' | 'failed' | 'ocr', failed: number | null) => ({ id, state, failure: null, label: `${id}.pdf`, kind: 'pdf' as const, byte_size: 5_109, pages: 1, created_at: '2026-10-02T09:30:00+00:00', expires_at: '2026-10-02T10:30:00+00:00', checks_failed: failed, can_export: failed === 0 })
  const props = { documents: [summary('aaaaaaaa', 'ready', 0), summary('bbbbbbbb', 'ready', 2), summary('cccccccc', 'ocr', null), summary('dddddddd', 'failed', null)], status: 'ready' as const, currentId: 'aaaaaaaa', busy: false, deleting: false }

  it('lists the visitor\'s documents with how each stands, and opens or deletes one', async () => {
    const wrapper = mountWithSite(DocumentShelf, { props })
    const items = wrapper.findAll('[data-testid="shelf-item"]')
    expect(items.map(item => item.get('.facts').text())).toEqual(['every check passed · 5.0 kB', 'Checks failed: 2 · 5.0 kB', 'Being read · 5.0 kB', 'No result · 5.0 kB'])
    expect(items[0]?.get('[data-testid="shelf-open"]').attributes('disabled')).toBeDefined()
    await items[1]?.get('[data-testid="shelf-open"]').trigger('click')
    await items[1]?.get('[data-testid="shelf-delete"]').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['bbbbbbbb']])
    expect(wrapper.emitted('remove')).toEqual([['bbbbbbbb']])
  })

  it('does not offer to delete a document that is still being read, and names each document on its buttons', () => {
    const wrapper = mountWithSite(DocumentShelf, { props })
    const reading = wrapper.findAll('[data-testid="shelf-item"]')[2]
    expect(reading?.get('[data-testid="shelf-delete"]').attributes('disabled')).toBeDefined()
    expect(reading?.get('[data-testid="shelf-open"]').attributes('aria-label')).toBe('Open cccccccc.pdf')
    expect(reading?.get('[data-testid="shelf-delete"]').attributes('aria-label')).toBe('Delete cccccccc.pdf')
  })

  it('says there are none, or that they could not be listed, and writes itself in Czech', () => {
    expect(mountWithSite(DocumentShelf, { props: { ...props, documents: [] } }).get('[data-testid="shelf-empty"]').text()).toBe('The documents you upload appear here for an hour.')
    expect(mountWithSite(DocumentShelf, { props: { ...props, documents: [], status: 'failed' as const } }).text()).toContain('could not be listed')
    const czech = mountWithSite(DocumentShelf, { locale: 'cs', props })
    expect(czech.findAll('[data-testid="shelf-open"]')[1]?.text()).toBe('Otevřít')
    expect(czech.findAll('.facts')[1]?.text()).toBe('Nesplněných kontrol: 2 · 5,0 kB')
  })
})

describe('UploadNotice', () => {
  it('says each refusal in the board\'s own words, with the limit the site has', () => {
    const texts = (['too_large', 'unsupported', 'running', 'busy'] as const).map(kind => mountWithSite(UploadNotice, { props: { kind } }).get('[data-testid="upload-notice"]'))
    expect(texts.map(notice => notice.attributes('data-kind'))).toEqual(['too_large', 'unsupported', 'running', 'busy'])
    expect(texts[0]?.text()).toContain('This site passes on files of up to 4 MB.')
    expect(texts[2]?.text()).toContain('Two of your documents are being read')
    expect(texts.every(notice => notice.attributes('role') === 'alert')).toBe(true)
  })

  it('says them in Czech', () => {
    const wrapper = mountWithSite(UploadNotice, { locale: 'cs', props: { kind: 'too_large' } })
    expect(wrapper.text()).toContain('Ten soubor je příliš velký')
    expect(wrapper.text()).toContain('do 4 MB')
  })
})
