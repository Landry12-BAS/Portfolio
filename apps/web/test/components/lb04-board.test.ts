// Tests of LB-04's whole board, mounted against the fake site whose back end is the mock's LB-04 (the
// real PDF extraction and the real review pipeline, with the golden set's reference reviewer for a model):
// a live review of a sample from the click to the report, the radar and the findings with their passages
// as text, the PDF viewer and the highlights it draws only where the browser reads the server's text, a
// proposed wording as a redline, the files the system refuses, the visitor's own PDF checked before it is
// sent, the day's contracts used up, a replay of a recording and a sample with none, the Brief reading and
// Czech. The PDF itself is drawn by pdf.js, which needs a real browser and has its own journey in
// e2e/lb04.spec.ts; here the engine is a stand-in that reads the text the server read, so what is checked
// is what the board does with the engine's answers.
import { readLb04Seed } from '@lb/api-clients/testing'
import type { Recording } from '@lb/contracts'
import { DOMWrapper, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import Lb04Board from '~/boards/lb-04/Lb04Board.vue'
import ContractViewer from '~/boards/lb-04/components/ContractViewer.vue'
import { POLL_MS } from '~/boards/lb-04/limits'
import { useLb04Store } from '~/boards/lb-04/store'
import { useReadingStore } from '~/stores/reading'

import cs from '../../i18n/locales/cs'
import type { FakeSiteOptions } from '../support/fake-site'
import { Lb04Site, warmUp } from '../support/lb04-site'
import { recordLb04Sample } from '../support/lb04-recording'
import { mountWithSite } from '../support/mount'

// What the stand-in engine does, and what a test can make it do: which text it reads for a page, and the
// calls it was given.
const engine = vi.hoisted(() => ({
  opened: [] as number[],
  drawn: [] as number[],
  destroyed: 0,
  textOf: (_page: number): string => '',
}))

vi.mock('~/boards/lb-04/pdf/engine', () => ({
  openPdf: vi.fn((bytes: Uint8Array) => {
    engine.opened.push(bytes.byteLength)
    return Promise.resolve({
      pageCount: 11,
      textOf: (page: number) => Promise.resolve({ text: engine.textOf(page), runs: [], truncated: false }),
      draw: (page: number, _canvas: unknown, width: number) => {
        engine.drawn.push(page)
        return Promise.resolve({
          width,
          height: Math.round(width * 1.3),
          boxesFor: (_text: unknown, start: number, end: number) => [{ left: 10 + (start % 40), top: 24, width: Math.max(end - start, 1), height: 12 }],
        })
      },
      destroy: () => {
        engine.destroyed += 1
        return Promise.resolve()
      },
    })
  }),
}))

const TODAY = Date.parse('2026-10-02T09:30:00.000Z')
// The visitor's session in the fake site.
const SESSION = 'fake-session-0123456789'
let recording: Recording

beforeAll(async () => {
  await warmUp(['wholesale-supply', 'clean-supply', 'hostile-supply', 'scanned-supply', 'master-supply-31'])
  recording = await recordLb04Sample()
}, 90_000)

/** What a test may choose when it opens the board. */
interface OpenOptions extends FakeSiteOptions {
  locale?: 'en' | 'cs'
  brief?: boolean
  // Runs before the board is mounted, with the site, for a day that is already part spent.
  prepare?: (site: Lb04Site) => void
}

/** Mounts the board against a fake site and waits for what it reads when it opens. */
async function openBoard(options: OpenOptions = {}) {
  const { locale, brief, prepare, ...siteOptions } = options
  const site = new Lb04Site(siteOptions)
  prepare?.(site)
  vi.stubGlobal('fetch', site.fetch)
  vi.stubGlobal('location', new URL('http://site.test/'))
  const wrapper = mountWithSite(Lb04Board, { locale, props: { permalinkFor: (id: string) => `/runs/${id}`, now: TODAY } })
  if (brief) useReadingStore().mode = 'brief'
  await flushPromises()
  await vi.advanceTimersByTimeAsync(0)
  await flushPromises()
  return { site, wrapper }
}

/** Lets time pass in polling steps until a condition holds. */
async function until(condition: () => boolean, limit = 60): Promise<void> {
  for (let step = 0; step < limit && !condition(); step += 1) {
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await flushPromises()
  }
  expect(condition()).toBe(true)
}

/** Lets a number of seconds pass, with the board's timers running. */
async function seconds(count: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(count * 1_000)
  await flushPromises()
}

/** Chooses a sample in the picker by its ID. */
async function choose(wrapper: VueWrapper, id: string): Promise<void> {
  await wrapper.get(`input[type="radio"][value="${id}"]`).setValue()
}

/** Chooses a sample and reviews it live, then waits until its report is on the board. */
async function reviewToTheEnd(wrapper: VueWrapper, id: string): Promise<void> {
  await choose(wrapper, id)
  await wrapper.get('[data-testid="run-sample"]').trigger('click')
  await flushPromises()
  await until(() => wrapper.find('[data-testid="report"]').exists())
}

/** The findings on the board, in the order shown, as their IDs. */
function findingIds(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[data-finding]').filter(card => card.element.tagName === 'ARTICLE').map(card => card.attributes('data-finding') ?? '')
}

/** Anything a test looks inside: the board as mounted, or one part of it that was found. */
interface Within {
  element: Element
}

/** Finds the first element that matches, or fails naming the selector. */
function elementOf(within: Within, selector: string): DOMWrapper<Element> {
  const element = within.element.querySelector(selector)
  if (!element) throw new Error(`Nothing matches ${selector}.`)
  return new DOMWrapper(element)
}

/** The card of a finding. */
function card(within: Within, id: string): DOMWrapper<Element> {
  return elementOf(within, `article[data-finding="${id}"]`)
}

/** The button inside a part of the board that has the given text. */
function buttonOf(within: Within, text: string): DOMWrapper<Element> {
  const button = [...within.element.querySelectorAll('button')].find(candidate => candidate.textContent.includes(text))
  if (!button) throw new Error(`No button says "${text}".`)
  return new DOMWrapper(button)
}

describe('LB-04\'s board', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(TODAY)
    engine.opened.length = 0
    engine.drawn.length = 0
    engine.destroyed = 0
    engine.textOf = () => ''
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  describe('when it opens', () => {
    it('is the datasheet\'s part as a live board, with the six samples, the day\'s three contracts and nothing run yet', async () => {
      const { wrapper } = await openBoard()

      expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Live')
      expect(wrapper.text()).toContain('LB-04')
      expect(wrapper.text()).toContain('Not legal advice')
      expect(wrapper.get('[data-testid="quota"]').text()).toContain('3 of 3')
      expect(wrapper.findAll('input[type="radio"]')).toHaveLength(6)
      for (const absent of ['progress', 'report', 'failure', 'contract', 'viewer']) expect(wrapper.find(`[data-testid="${absent}"]`).exists(), absent).toBe(false)
    })

    it('reads what it shows and asks for nothing that spends a contract, a file or a model call', async () => {
      const { site } = await openBoard()

      expect(site.calls.filter(call => call.method !== 'GET')).toEqual([])
      expect(site.callsTo('/api/lb04/limits')).toHaveLength(1)
      expect(site.callsTo('/api/lb04/contracts', 'GET')).toHaveLength(1)
      expect(site.callsTo('/api/recordings/lb-04')).toHaveLength(1)
      expect(site.callsTo('/api/lb04/playbook')).toEqual([])
    })

    it('shows the playbook only once the visitor opens it, and then with its nine topics, read once', async () => {
      const { site, wrapper } = await openBoard()
      const playbook = wrapper.get('[data-testid="playbook"]')
      expect(playbook.find('h3').exists()).toBe(false)

      playbook.element.setAttribute('open', '')
      await playbook.trigger('toggle')
      await flushPromises()

      expect(playbook.findAll('h3')).toHaveLength(9)
      expect(playbook.text()).toContain('Required clause')
      expect(site.callsTo('/api/lb04/playbook')).toHaveLength(1)
    })

    it('says plainly that nothing is sent when the site has no back end, and offers no live review', async () => {
      const { site, wrapper } = await openBoard({ available: false })

      expect(wrapper.find('[data-testid="notice"]').exists()).toBe(true)
      expect(wrapper.get('[data-testid="run-sample"]').attributes('disabled')).toBeDefined()
      expect(site.calls.filter(call => call.path.startsWith('/api/lb04'))).toEqual([])
    })
  })

  describe('a live review of a sample', () => {
    it('runs the check once, sends the sample\'s ID, shows the steps by the state the service reports and counts one contract', async () => {
      const { site, wrapper } = await openBoard()
      await choose(wrapper, 'wholesale-supply')
      await wrapper.get('[data-testid="run-sample"]').trigger('click')
      await flushPromises()

      expect(site.callsTo('/api/session/verify', 'POST')).toHaveLength(1)
      expect(site.callsTo('/api/lb04/contracts', 'POST')[0]?.body).toEqual({ from: 'sample', sampleId: 'wholesale-supply' })
      const progress = wrapper.get('[data-testid="progress"]')
      expect(progress.attributes('data-state')).toBe('queued')
      expect(progress.findAll('li')).toHaveLength(4)
      expect(wrapper.get('[data-testid="announcement"]').text()).toBe('The review is queued.')
      expect(wrapper.get('[data-testid="quota"]').text()).toContain('2 of 3')
      expect(wrapper.get('[data-testid="run-sample"]').attributes('disabled')).toBeDefined()
      expect(wrapper.find('[data-testid="report"]').exists()).toBe(false)
    })

    it('moves each step on only when the service says so, and ends in a report, announced', async () => {
      const { wrapper } = await openBoard()
      await choose(wrapper, 'wholesale-supply')
      await wrapper.get('[data-testid="run-sample"]').trigger('click')
      await flushPromises()
      const seen = new Set<string>()
      for (let step = 0; step < 60 && !wrapper.find('[data-testid="report"]').exists(); step += 1) {
        await vi.advanceTimersByTimeAsync(POLL_MS)
        await flushPromises()
        const progress = wrapper.find('[data-testid="progress"]')
        seen.add(progress.exists() ? (progress.attributes('data-state') ?? '') : 'gone')
      }

      expect([...seen]).toEqual(expect.arrayContaining(['extracting', 'analysing', 'verifying']))
      expect(wrapper.find('[data-testid="progress"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="announcement"]').text()).toBe('The review is done. Findings: 5.')
    })

    it('shows the report: the contract, the figures of what was checked, the radar and the five findings, the worst first', async () => {
      const { wrapper } = await openBoard()
      await reviewToTheEnd(wrapper, 'wholesale-supply')

      const header = wrapper.get('[data-testid="contract"]')
      expect(header.text()).toContain('Wholesale supply agreement')
      expect(header.text()).toContain('Pages: 11')
      expect(header.text()).toContain('Not legal advice')
      const summary = wrapper.get('[data-testid="report-summary"]')
      expect(summary.text()).toContain('Playbook')
      expect(summary.get('[data-testid="screen-verdict"]').text()).toContain('No passage in the contract addresses a reviewer')
      expect(wrapper.get('[data-testid="radar"]').findAll('tbody tr')).toHaveLength(9)
      expect(findingIds(wrapper)).toHaveLength(5)
      expect(wrapper.get('[data-testid="redlines-left"]').text()).toContain('3 of 3')
    })

    it('draws the radar as an image with a title and a description, and has the same numbers as words in the table beside it', async () => {
      const { wrapper } = await openBoard()
      await reviewToTheEnd(wrapper, 'wholesale-supply')

      const drawing = wrapper.get('[data-testid="radar"] svg')
      expect(drawing.attributes('role')).toBe('img')
      expect(drawing.get('title').text()).toBe('Risk by topic')
      expect(drawing.get('desc').text()).toMatch(/topics with a finding/)
      expect(wrapper.get('[data-testid="radar-area"]').attributes('points')).toMatch(/\d/)
      const rows = wrapper.get('[data-testid="radar"]').findAll('tbody tr')
      const renewal = rows.find(row => row.get('th').text() === 'Renewal')
      expect(Number(renewal?.findAll('td')[1]?.text())).toBeGreaterThan(0)
      expect(renewal?.findAll('td')[0]?.text()).toMatch(/Low|Medium|High|Critical/)
    })

    it('quotes the contract\'s own words as text for every risk, and says what a missing clause was searched for', async () => {
      const { wrapper } = await openBoard()
      await reviewToTheEnd(wrapper, 'wholesale-supply')
      const store = useLb04Store()
      const risks = store.report?.findings.filter(finding => finding.kind === 'risk') ?? []
      const absent = store.report?.findings.filter(finding => finding.kind === 'absent') ?? []

      expect(risks).toHaveLength(4)
      for (const finding of risks) {
        const quote = card(wrapper, finding.id).get('[data-testid="passage"]').text()
        expect(quote).toContain(finding.kind === 'risk' ? finding.quote : '')
      }
      expect(absent).toHaveLength(1)
      expect(card(wrapper, absent[0]?.id ?? '').text()).toContain('The playbook expects this clause')
      expect(card(wrapper, absent[0]?.id ?? '').find('[data-testid="passage"]').exists()).toBe(false)
    })

    it('shows how serious each finding is in words, not only in a mark', async () => {
      const { wrapper } = await openBoard()
      await reviewToTheEnd(wrapper, 'wholesale-supply')

      for (const id of findingIds(wrapper)) expect(card(wrapper, id).text()).toMatch(/Low|Medium|High|Critical/)
    })

    it('narrows the findings to a topic from the radar\'s table, says so, and shows them all again', async () => {
      const { wrapper } = await openBoard()
      await reviewToTheEnd(wrapper, 'wholesale-supply')
      const before = findingIds(wrapper).length
      const topic = wrapper.get('[data-testid="radar"]').findAll('tbody button:not([disabled])')[0]
      await topic?.trigger('click')

      const narrowed = findingIds(wrapper).length
      expect(narrowed).toBeGreaterThan(0)
      expect(narrowed).toBeLessThan(before)
      expect(wrapper.get('[data-testid="findings"]').text()).toContain(`Showing ${narrowed} of ${before}`)
      expect(topic?.attributes('aria-pressed')).toBe('true')

      await buttonOf(wrapper.get('[data-testid="findings"]'), 'Show all findings').trigger('click')
      expect(findingIds(wrapper)).toHaveLength(before)
    })

    it('has the Scope trace of the run, with the models it called, and a permalink to the run', async () => {
      const { wrapper } = await openBoard()
      await reviewToTheEnd(wrapper, 'wholesale-supply')
      await seconds(3)

      const scope = wrapper.get('[data-testid="scope"]')
      expect(scope.findAll('[data-testid="scope-row"]').length).toBeGreaterThan(2)
      expect(scope.text()).toContain('lb-long')
      expect(scope.get('a').attributes('href')).toMatch(/^\/runs\//)
    })

    it('does not fetch the PDF, or load the viewer, until the visitor asks for it', async () => {
      const { site, wrapper } = await openBoard()
      await reviewToTheEnd(wrapper, 'wholesale-supply')

      expect(site.fileCalls()).toEqual([])
      expect(wrapper.find('[data-testid="viewer"]').exists()).toBe(false)
      expect(engine.opened).toEqual([])
      expect(wrapper.find('[data-testid="open-viewer"]').exists()).toBe(true)
    })
  })

  describe('the contract\'s pages', () => {
    /** Reviews the wholesale supply agreement, and makes the stand-in engine read the text the server read. */
    async function reviewed() {
      const opened = await openBoard()
      await reviewToTheEnd(opened.wrapper, 'wholesale-supply')
      const store = useLb04Store()
      const server = new Map((store.pages ?? []).map(page => [page.page, page.text]))
      engine.textOf = page => server.get(page) ?? ''
      return { ...opened, store, server }
    }

    /**
     * Opens the viewer on a finding's passage and waits until the page is drawn and every page's text has
     * been compared with the server's. The viewer loads its parts with dynamic imports, which take a little
     * real time that the fake timers do not move, so this waits on the page itself.
     */
    async function showFirstRisk(wrapper: VueWrapper, store: ReturnType<typeof useLb04Store>) {
      const first = store.report?.findings.find(finding => finding.kind === 'risk')
      await buttonOf(card(wrapper, first?.id ?? ''), 'Show in the contract').trigger('click')
      await vi.waitFor(() => {
        expect(wrapper.find('[data-testid="text-agreement"]').exists()).toBe(true)
        expect(wrapper.find('[data-testid="text-agreement"]').attributes('data-state')).not.toBe('checking')
      }, { timeout: 8_000, interval: 20 })
      await flushPromises()
      return first
    }

    it('open on the page of the finding the visitor chose, fetching the PDF once and drawing that page', async () => {
      const { site, wrapper, store } = await reviewed()
      const first = await showFirstRisk(wrapper, store)

      expect(site.fileCalls()).toHaveLength(1)
      expect(engine.opened).toHaveLength(1)
      expect(wrapper.get('[data-testid="viewer"]').attributes('data-status')).toBe('ready')
      const page = first?.kind === 'risk' ? first.citation.page : 0
      expect(engine.drawn).toContain(page)
      expect((wrapper.get('[data-testid="viewer-page"]').element as HTMLInputElement).value).toBe(String(page))
      expect(card(wrapper, first?.id ?? '').get('button[aria-pressed]').attributes('aria-pressed')).toBe('true')
    })

    it('say that the browser read the server\'s text on every page, and highlight the cited characters on that page', async () => {
      const { wrapper, store } = await reviewed()
      const first = await showFirstRisk(wrapper, store)

      expect(wrapper.get('[data-testid="text-agreement"]').attributes('data-state')).toBe('match')
      expect(wrapper.get('[data-testid="text-agreement"]').text()).toContain('all 11 pages')
      const boxes = wrapper.findAll('[data-testid="highlight"]')
      expect(boxes.length).toBeGreaterThan(0)
      expect(boxes.map(box => box.attributes('data-finding'))).toContain(first?.id)
    })

    it('leave the highlight off a page where the browser read other text, and say which pages, with the passage still as text', async () => {
      const { wrapper, store, server } = await reviewed()
      const first = store.report?.findings.find(finding => finding.kind === 'risk')
      const page = first?.kind === 'risk' ? first.citation.page : 1
      engine.textOf = number => (number === page ? `${server.get(number) ?? ''} (another reading)` : (server.get(number) ?? ''))
      await showFirstRisk(wrapper, store)

      expect(wrapper.get('[data-testid="text-agreement"]').attributes('data-state')).toBe('differs')
      expect(wrapper.get('[data-testid="text-agreement"]').text()).toContain(`pages ${page}`)
      expect(wrapper.findAll('[data-testid="highlight"]')).toEqual([])
      expect(wrapper.get('[data-testid="page-text"]').find('mark').exists()).toBe(true)
      expect(card(wrapper, first?.id ?? '').find('[data-testid="passage"]').exists()).toBe(true)
    })

    it('mark the cited characters in the page\'s text for a reader who cannot see the page', async () => {
      const { wrapper, store } = await reviewed()
      const first = await showFirstRisk(wrapper, store)

      const marked = wrapper.get('[data-testid="page-text"]').findAll('mark').map(mark => mark.text()).join(' ')
      expect(first?.kind === 'risk' && marked.replace(/\s+/g, ' ')).toContain(first?.kind === 'risk' ? first.quote.replace(/\s+/g, ' ').slice(0, 24) : '')
    })

    it('give the page\'s text a name and a place in the tab order, since it scrolls', async () => {
      const { wrapper, store } = await reviewed()
      const first = await showFirstRisk(wrapper, store)
      const text = wrapper.get('[data-testid="page-text"]')

      expect(text.attributes('tabindex')).toBe('0')
      expect(text.attributes('aria-label')).toBe(`Text of page ${first?.kind === 'risk' ? first.citation.page : 0}`)
    })

    it('go to another page from the keyboard-reachable controls, within the contract', async () => {
      const { wrapper, store } = await reviewed()
      await showFirstRisk(wrapper, store)
      const input = wrapper.get('[data-testid="viewer-page"]')
      const before = Number((input.element as HTMLInputElement).value)

      await buttonOf(wrapper.get('[data-testid="viewer"]'), 'Next page').trigger('click')
      await flushPromises()
      expect(Number((input.element as HTMLInputElement).value)).toBe(Math.min(before + 1, 11))

      ;(input.element as HTMLInputElement).value = '999'
      await input.trigger('change')
      expect((input.element as HTMLInputElement).value).toBe('11')
      ;(input.element as HTMLInputElement).value = '0'
      await input.trigger('change')
      expect((input.element as HTMLInputElement).value).toBe('1')
    })

    it('keep the digits the visitor has typed in the page box when the viewer redraws before they leave it', async () => {
      const { wrapper, store } = await reviewed()
      await showFirstRisk(wrapper, store)
      const input = wrapper.get('[data-testid="viewer-page"]')
      const box = input.element as HTMLInputElement

      // The background comparison of the texts redraws the viewer once for each page it reads; a redraw by hand
      // between the typing and the visitor's leaving the box is the same thing, without waiting for the pages.
      box.value = '9'
      await input.trigger('input')
      wrapper.findComponent(ContractViewer).vm.$forceUpdate()
      await nextTick()
      expect(box.value).toBe('9')

      await input.trigger('change')
      await flushPromises()
      expect(box.value).toBe('9')
      expect(engine.drawn).toContain(9)
    })

    it('close the engine when the board goes away', async () => {
      const { wrapper, store } = await reviewed()
      await showFirstRisk(wrapper, store)
      wrapper.unmount()
      await flushPromises()

      expect(engine.destroyed).toBeGreaterThanOrEqual(1)
    })
  })

  describe('a proposed wording', () => {
    it('is made for a finding, shown word by word as a real insertion and deletion with the words a screen reader says, and counted', async () => {
      const { site, wrapper } = await openBoard()
      await reviewToTheEnd(wrapper, 'wholesale-supply')
      const first = useLb04Store().report?.findings.find(finding => finding.kind === 'risk')
      await buttonOf(card(wrapper, first?.id ?? ''), 'Propose a wording').trigger('click')
      await flushPromises()
      await seconds(2)

      const redline = card(wrapper, first?.id ?? '').get('[data-testid="redline"]')
      expect(site.callsTo(`/api/lb04/contracts/${useLb04Store().contract?.id}/findings/${first?.id}/redline`, 'POST')).toHaveLength(1)
      expect(redline.text()).toContain('Not legal advice')
      expect(redline.get('[data-testid="redline-proposal"]').text().length).toBeGreaterThan(20)
      expect(redline.findAll('ins').length + redline.findAll('del').length).toBeGreaterThan(0)
      expect(redline.get('[data-testid="redline-diff"]').text()).toMatch(/Removed:|Added:/)
      expect(wrapper.get('[data-testid="redlines-left"]').text()).toContain('2 of 3')
      expect(card(wrapper, first?.id ?? '').text()).not.toContain('Propose a wording')
    })

    it('says when the model could not be reached, and keeps the contract\'s count of wordings', async () => {
      const { site, wrapper } = await openBoard()
      await reviewToTheEnd(wrapper, 'wholesale-supply')
      const first = useLb04Store().report?.findings[0]
      site.failNext('POST /api/lb04/contracts', { status: 503, body: { error: { code: 'analysis_unavailable', message: 'The model is unavailable right now.' } } })
      await buttonOf(card(wrapper, first?.id ?? ''), 'Propose a wording').trigger('click')
      await flushPromises()

      expect(wrapper.get('[data-testid="own-notice"]').attributes('data-notice')).toBe('model')
      expect(wrapper.get('[data-testid="redlines-left"]').text()).toContain('3 of 3')
      expect(wrapper.find('[data-testid="redline"]').exists()).toBe(false)
    })
  })

  describe('the other samples', () => {
    it('says a fair contract has nothing against the playbook, and that this is not a clearance', async () => {
      const { wrapper } = await openBoard()
      await reviewToTheEnd(wrapper, 'clean-supply')

      expect(wrapper.get('[data-testid="no-findings"]').text()).toContain('Nothing in this contract goes against the playbook.')
      expect(wrapper.get('[data-testid="no-findings"]').text()).toContain('not a clearance')
      expect(findingIds(wrapper)).toEqual([])
      expect(wrapper.get('[data-testid="radar"]').findAll('tbody button:not([disabled])')).toEqual([])
    })

    it('flags the contract that talks to its reviewer, and no finding quotes one of its instructions', async () => {
      const { wrapper } = await openBoard()
      await reviewToTheEnd(wrapper, 'hostile-supply')

      expect(wrapper.get('[data-testid="screen-verdict"]').text()).toContain('address an AI reviewer')
      const quotes = wrapper.findAll('[data-testid="passage"]').map(passage => passage.text().toLowerCase())
      expect(quotes.length).toBeGreaterThan(0)
      for (const quote of quotes) expect(quote).not.toMatch(/ignore (all )?previous|no risks|do not report/)
    })

    it('refuses a scan with its reason, takes nothing from the day and shows no report', async () => {
      const { wrapper } = await openBoard()
      await choose(wrapper, 'scanned-supply')
      await wrapper.get('[data-testid="run-sample"]').trigger('click')
      await flushPromises()
      await until(() => wrapper.find('[data-testid="failure"]').exists())

      const failure = wrapper.get('[data-testid="failure"]')
      expect(failure.attributes('data-code')).toBe('no_text_layer')
      expect(failure.text()).toContain('no text layer')
      expect(failure.text()).toContain('Your place for the day was given back')
      expect(wrapper.find('[data-testid="report"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="progress"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="quota"]').text()).toContain('3 of 3')
      expect(wrapper.get('[data-testid="announcement"]').text()).toBe('The review failed.')
    })

    it('refuses a contract of 31 pages and names the limit', async () => {
      const { wrapper } = await openBoard()
      await choose(wrapper, 'master-supply-31')
      await wrapper.get('[data-testid="run-sample"]').trigger('click')
      await flushPromises()
      await until(() => wrapper.find('[data-testid="failure"]').exists())

      expect(wrapper.get('[data-testid="failure"]').attributes('data-code')).toBe('too_many_pages')
      expect(wrapper.get('[data-testid="failure"]').text()).toContain('more than 30 pages')
    })

    it('says the model is unavailable when the review ends that way, and gives the place back', async () => {
      const { site, wrapper } = await openBoard()
      site.mock.failNext('analysis_unavailable')
      await choose(wrapper, 'wholesale-supply')
      await wrapper.get('[data-testid="run-sample"]').trigger('click')
      await flushPromises()
      await until(() => wrapper.find('[data-testid="failure"]').exists())

      expect(wrapper.get('[data-testid="failure"]').attributes('data-code')).toBe('analysis_unavailable')
      expect(wrapper.get('[data-testid="failure"]').text()).toContain('Try again later')
      expect(wrapper.get('[data-testid="quota"]').text()).toContain('3 of 3')
    })
  })

  describe('the visitor\'s own PDF', () => {
    /** Switches the starter to the visitor's own file. */
    async function ownFile(wrapper: VueWrapper): Promise<void> {
      await wrapper.findAll('.lb-seg__btn')[1]?.trigger('click')
      await flushPromises()
    }

    /** Hands the file input a file, as a visitor choosing one does. */
    async function pick(wrapper: VueWrapper, file: File): Promise<void> {
      const input = wrapper.get('[data-testid="upload-input"]')
      Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
      await input.trigger('change')
      await flushPromises()
    }

    it('says what is wrong with a file before anything is sent, and keeps the button off', async () => {
      const { site, wrapper } = await openBoard()
      await ownFile(wrapper)
      await pick(wrapper, new File(['Dear sir, this is a letter'], 'letter.pdf', { type: 'application/pdf' }))

      expect(wrapper.get('[data-testid="upload"]').text()).toContain('The file is not a PDF.')
      expect(wrapper.get('[data-testid="run-file"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get('[data-testid="upload-input"]').attributes('aria-invalid')).toBe('true')
      expect(site.callsTo('/api/lb04/contracts', 'POST')).toEqual([])
    })

    it('reviews a PDF the visitor chose, sending its bytes as base64 and keeping them in the browser for the viewer', async () => {
      const { site, wrapper } = await openBoard()
      const bytes = readLb04Seed().samples.find(sample => sample.entry.id === 'clean-supply')?.bytes ?? new Uint8Array()
      await ownFile(wrapper)
      await pick(wrapper, new File([bytes.slice()], 'my-agreement.pdf', { type: 'application/pdf' }))
      expect(wrapper.get('[data-testid="upload"]').text()).toContain('Chosen: my-agreement.pdf')
      await wrapper.get('[data-testid="run-file"]').trigger('click')
      await flushPromises()
      await until(() => wrapper.find('[data-testid="report"]').exists())

      const sent = site.callsTo('/api/lb04/contracts', 'POST')[0]?.body as { from: string, filename: string, contentBase64: string }
      expect(sent.from).toBe('upload')
      expect(sent.filename).toBe('my-agreement.pdf')
      expect(sent.contentBase64).toBe(Buffer.from(bytes).toString('base64'))
      expect(site.fileCalls()).toEqual([])
    })
  })

  describe('the day\'s contracts', () => {
    it('are used up: the starter says so, a live review is off, and the notice does not blame the site', async () => {
      const { site, wrapper } = await openBoard({
        prepare: (prepared) => {
          for (let count = 0; count < 3; count += 1) prepared.mock.create(SESSION, { from: 'sample', sampleId: 'clean-supply' })
        },
      })

      expect(wrapper.get('[data-testid="quota"]').text()).toContain('0 of 3')
      expect(wrapper.get('[data-testid="run-sample"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get('[data-testid="starter"]').text()).toContain('Today\'s contracts are used up')
      expect(site.callsTo('/api/lb04/contracts', 'POST')).toEqual([])
    })

    it('are replayable for nothing when they are used up, if the sample has a recording', async () => {
      const { site, wrapper } = await openBoard({
        recordings: [recording],
        prepare: (prepared) => {
          for (let count = 0; count < 3; count += 1) prepared.mock.create(SESSION, { from: 'sample', sampleId: 'clean-supply' })
        },
      })
      const before = site.callsTo('/api/lb04').length
      await wrapper.get('[data-testid="replay-sample"]').trigger('click')
      await flushPromises()
      await seconds(9)

      expect(site.callsTo('/api/lb04')).toHaveLength(before)
      expect(wrapper.find('[data-testid="report"]').exists()).toBe(true)
    })

    it('say after a refusal from the service that none are left, with when the day starts again', async () => {
      const { site, wrapper } = await openBoard()
      site.failNext('POST /api/lb04/contracts', { status: 429, body: { error: { code: 'daily_limit', message: 'No contracts left today.', resets_at: '2026-10-03T00:00:00.000Z' } } })
      await wrapper.get('[data-testid="run-sample"]').trigger('click')
      await flushPromises()

      expect(wrapper.get('[data-testid="notice"]').text()).toMatch(/used up|limit/i)
      expect(wrapper.get('[data-testid="quota"]').text()).toContain('0 of 3')
    })
  })

  describe('stopping, reopening and deleting', () => {
    it('stops waiting, leaves the board empty, lists the contract and keeps the place taken', async () => {
      const { wrapper } = await openBoard()
      await choose(wrapper, 'wholesale-supply')
      await wrapper.get('[data-testid="run-sample"]').trigger('click')
      await flushPromises()
      await buttonOf(wrapper.get('[data-testid="progress"]'), 'Stop waiting').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="progress"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="stopped"]').text()).toContain('You stopped waiting')
      expect(wrapper.get('[data-testid="my-contracts"]').text()).toContain('Wholesale supply agreement')
      expect(wrapper.get('[data-testid="quota"]').text()).toContain('2 of 3')
    })

    it('opens one of the visitor\'s contracts from the list, without taking another place, and follows it to its report', async () => {
      const { site, wrapper } = await openBoard()
      await choose(wrapper, 'wholesale-supply')
      await wrapper.get('[data-testid="run-sample"]').trigger('click')
      await flushPromises()
      await buttonOf(wrapper.get('[data-testid="progress"]'), 'Stop waiting').trigger('click')
      await flushPromises()
      await buttonOf(wrapper.get('[data-testid="my-contracts"]'), 'Open').trigger('click')
      await flushPromises()
      await until(() => wrapper.find('[data-testid="report"]').exists())

      expect(site.callsTo('/api/lb04/contracts', 'POST')).toHaveLength(1)
      expect(wrapper.get('[data-testid="quota"]').text()).toContain('2 of 3')
      expect(findingIds(wrapper)).toHaveLength(5)
    })

    it('deletes the contract now, empties the board, and does not give the place back', async () => {
      const { site, wrapper } = await openBoard()
      await reviewToTheEnd(wrapper, 'clean-supply')
      const id = useLb04Store().contract?.id ?? ''
      await wrapper.get('[data-testid="delete-contract"]').trigger('click')
      await flushPromises()

      expect(site.callsTo(`/api/lb04/contracts/${id}`, 'DELETE')).toHaveLength(1)
      expect(wrapper.find('[data-testid="report"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="contract"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="quota"]').text()).toContain('2 of 3')
    })
  })

  describe('a replay', () => {
    it('plays a recording with no request to the back end, labelled as a replay, ending in the report with its redline', async () => {
      const { site, wrapper } = await openBoard({ recordings: [recording] })
      const before = site.callsTo('/api/lb04').length
      await wrapper.get('[data-testid="replay-sample"]').trigger('click')
      await flushPromises()

      expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Replay')
      expect(wrapper.find('[data-testid="replay-banner"]').exists()).toBe(true)
      expect(wrapper.get('[data-testid="progress"]').text()).toContain('This is a recording: nothing is sent and nothing is spent.')
      await seconds(9)

      expect(site.callsTo('/api/lb04')).toHaveLength(before)
      expect(wrapper.find('[data-testid="report"]').exists()).toBe(true)
      expect(findingIds(wrapper).length).toBeGreaterThan(0)
      expect(wrapper.findAll('[data-testid="redline"]')).toHaveLength(1)
      expect(wrapper.find('[data-testid="delete-contract"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="redlines-left"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="quota"]').text()).toContain('3 of 3')
    })

    it('offers the live review of the same sample, which then takes one contract', async () => {
      const { site, wrapper } = await openBoard({ recordings: [recording], verified: true })
      await wrapper.get('[data-testid="replay-sample"]').trigger('click')
      await flushPromises()
      await seconds(9)
      await buttonOf(wrapper.get('[data-testid="replay-banner"]'), 'live').trigger('click')
      await flushPromises()

      expect(site.callsTo('/api/lb04/contracts', 'POST')[0]?.body).toEqual({ from: 'sample', sampleId: 'wholesale-supply' })
      expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Live')
    })

    it('says a sample has no recording yet and offers the live review, where there is none', async () => {
      const { wrapper } = await openBoard({ recordings: [] })

      expect(wrapper.find('[data-testid="replay-sample"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="sample-detail"]').text()).toContain('There is no recording of this sample yet')
      expect(wrapper.get('[data-testid="run-sample"]').text()).toBe('Review it live')
    })
  })

  describe('the Brief reading and Czech', () => {
    it('keeps the Brief reading short: one sentence of figures, no playbook, no source of each finding', async () => {
      const { wrapper } = await openBoard({ brief: true })
      await reviewToTheEnd(wrapper, 'wholesale-supply')

      expect(wrapper.find('[data-testid="playbook"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="report-summary"]').text()).toContain('The server checked')
      expect(wrapper.get('[data-testid="report-summary"]').find('dl').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('Found by the model')
    })

    it('speaks Czech, with the label that the review is not legal advice, and leaves the contract\'s own words as they are', async () => {
      const { wrapper } = await openBoard({ locale: 'cs' })
      expect(wrapper.text()).toContain(cs.lb04.notLegalAdvice)
      await reviewToTheEnd(wrapper, 'wholesale-supply')

      expect(wrapper.get('[data-testid="report"]').text()).toContain(cs.lb04.finding.show)
      expect(wrapper.get('[data-testid="announcement"]').text()).toBe(cs.lb04.live.done.replace('{count}', '5'))
      const first = useLb04Store().report?.findings.find(finding => finding.kind === 'risk')
      expect(wrapper.get(`article[data-finding="${first?.id}"] [data-testid="passage"]`).text()).toContain(first?.kind === 'risk' ? first.quote : '')
    })
  })
})
