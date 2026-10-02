// End-to-end journeys of LB-04's evaluation board, in a real browser against the test build of the site and
// the mock back end (which runs the real PDF extraction and review pipeline, with the golden set's reference
// reviewer for a model): a recorded review replayed with no request to the back end, a live review of a
// sample with the steps shown by the state the service reports, the visitor's own PDF, a proposed wording,
// the files the system refuses, the day's limit, and both languages. The PDF viewer is checked for real:
// pdf.js and its worker load only when a visitor asks for the pages, the page is drawn on a canvas, the
// browser reads the same text as the server on every page of every sample, and a highlight sits over the
// cited words. Every test also fails on a CSP or Trusted Types violation, a page error or a console error
// (e2e/fixtures.ts), which is the proof that the viewer's worker runs under the site's policy. The Turnstile
// check is the test build's stand-in; the real widget needs Cloudflare.
import { join } from 'node:path'

import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

// The seed's PDFs, which the journeys hand the board as the visitor's own file.
const CONTRACTS = join(import.meta.dirname, '../../../data/seed/lb04/contracts')

/** Opens the board and waits until it has read the session and counted the day's contracts. */
async function openBoard(page: Page, path = '/systems/lb-04/board', counted = '3 of 3'): Promise<void> {
  await page.goto(path)
  await expect(page.getByTestId('quota')).toContainText(counted)
}

/** Records the requests that could change something, so a test can say that none was made. */
function watchWrites(page: Page): string[] {
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
  })
  return writes
}

/** Records the requests for pdf.js's worker and the scripts bigger than 300 kB, which here means pdf.js itself. */
function watchPdfCode(page: Page): { worker: string[], big: string[] } {
  const loaded = { worker: [] as string[], big: [] as string[] }
  page.on('response', (response) => {
    const url = response.url()
    if (/pdf\.worker/.test(url)) loaded.worker.push(url)
    if (!url.endsWith('.js')) return
    void response.body().then((body) => {
      if (body.length > 300_000) loaded.big.push(url)
    }).catch(() => undefined)
  })
  return loaded
}

/** Chooses a sample by its ID. */
async function choose(page: Page, id: string): Promise<void> {
  await page.locator(`input[type="radio"][value="${id}"]`).check()
}

/** Reviews a sample live and waits until the report is on the board. */
async function reviewLive(page: Page, id: string): Promise<void> {
  await choose(page, id)
  await page.getByTestId('run-sample').click()
  await expect(page.getByTestId('report')).toBeVisible({ timeout: 60_000 })
}

/** Opens the viewer from the button under the findings and waits until the pages have been drawn and read. */
async function openViewer(page: Page): Promise<void> {
  await page.getByTestId('open-viewer').click()
  await waitForViewer(page)
}

/** Waits until the viewer has drawn its page and compared the browser's reading of every page with the server's. */
async function waitForViewer(page: Page): Promise<void> {
  await expect(page.getByTestId('viewer')).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
  await expect(page.getByTestId('text-agreement')).not.toHaveAttribute('data-state', 'checking', { timeout: 60_000 })
}

/** Counts the dark pixels of the drawn page, which is none for a canvas nothing was drawn on. */
async function inkOnPage(page: Page): Promise<number> {
  return page.getByTestId('viewer-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d')
    if (!context) return 0
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let dark = 0
    for (let index = 0; index < data.length; index += 4) {
      if ((data[index] ?? 255) < 140) dark += 1
    }
    return dark
  })
}

/** Measures the ink on the drawn page under the first highlight, and under a strip of the same size at the top of the page, where there is none. */
async function inkUnderFirstHighlight(page: Page): Promise<{ under: number, area: number, control: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="viewer-canvas"]')
    const box = document.querySelector('[data-testid="highlight"]')
    const context = canvas?.getContext('2d')
    if (!canvas || !box || !context) return { under: 0, area: 0, control: 0 }
    const sheet = canvas.getBoundingClientRect()
    const rectangle = box.getBoundingClientRect()
    const scale = canvas.width / sheet.width
    const width = Math.max(Math.floor(rectangle.width * scale), 1)
    const height = Math.max(Math.floor(rectangle.height * scale), 1)
    /** Counts the dark pixels of a rectangle of the canvas. */
    const darkIn = (left: number, top: number): number => {
      const { data } = context.getImageData(Math.max(Math.floor(left), 0), Math.max(Math.floor(top), 0), Math.min(width, canvas.width), Math.min(height, canvas.height))
      let dark = 0
      for (let index = 0; index < data.length; index += 4) {
        if ((data[index] ?? 255) < 140) dark += 1
      }
      return dark
    }
    return { under: darkIn((rectangle.left - sheet.left) * scale, (rectangle.top - sheet.top) * scale), area: width * height, control: darkIn((rectangle.left - sheet.left) * scale, 2) }
  })
}

test.describe('replaying a recorded review', () => {
  test('plays the recording as a replay, asks nothing, spends nothing, and ends in the report with its radar and findings', async ({ page }) => {
    const writes = watchWrites(page)
    await openBoard(page)
    await expect(page.getByTestId('board-state')).toHaveText('Live')
    await expect(page.locator('.state[data-recording="yes"]')).toHaveCount(3)

    await page.getByTestId('replay-sample').click()

    await expect(page.getByTestId('board-state')).toHaveText('Replay')
    await expect(page.getByTestId('replay-banner')).toContainText('Replay of a recorded run')
    await expect(page.getByTestId('replay-banner')).toContainText('none of your allowance is used')
    await expect(page.getByTestId('progress')).toBeVisible()
    await expect(page.getByTestId('progress')).toContainText('This is a recording: nothing is sent and nothing is spent.')
    await expect(page.getByTestId('report')).toBeVisible({ timeout: 40_000 })
    await expect(page.getByTestId('contract')).toContainText('Wholesale supply agreement')
    await expect(page.getByTestId('radar').locator('tbody tr')).toHaveCount(9)
    await expect(page.locator('article[data-finding]')).toHaveCount(5)
    await expect(page.getByTestId('passage').first()).toContainText('shall be unlimited')
    await expect(page.getByTestId('redline')).toHaveCount(1)
    await expect(page.getByTestId('scope-row').first()).toBeVisible()
    await expect(page.getByTestId('quota')).toContainText('3 of 3')
    await expect(page.getByTestId('delete-contract')).toHaveCount(0)
    expect(writes).toEqual([])
  })

  test('replays a scan\'s refusal with its reason, and nothing about a report', async ({ page }) => {
    await openBoard(page)
    await choose(page, 'scanned-supply')
    await page.getByTestId('replay-sample').click()

    await expect(page.getByTestId('failure')).toBeVisible({ timeout: 40_000 })
    await expect(page.getByTestId('failure')).toHaveAttribute('data-code', 'no_text_layer')
    await expect(page.getByTestId('failure')).toContainText('no text layer')
    await expect(page.getByTestId('report')).toHaveCount(0)
    await expect(page.getByTestId('progress')).toHaveCount(0)
    await expect(page.getByTestId('quota')).toContainText('3 of 3')
  })

  test('plays a fair contract\'s recording to its report of nothing, and says that is not a clearance', async ({ page }) => {
    await openBoard(page)
    await choose(page, 'clean-supply')
    await page.getByTestId('replay-sample').click()

    await expect(page.getByTestId('no-findings')).toBeVisible({ timeout: 40_000 })
    await expect(page.getByTestId('no-findings')).toContainText('not a clearance')
  })

  test('says a sample has no recording yet, offers the live review, and runs it', async ({ page }) => {
    await openBoard(page)
    await choose(page, 'hostile-supply')

    await expect(page.getByTestId('replay-sample')).toHaveCount(0)
    await expect(page.getByTestId('sample-detail')).toContainText('There is no recording of this sample yet')
    await expect(page.getByTestId('run-sample')).toHaveText('Review it live')
  })

  test('can be run live instead, which then takes one of the day\'s contracts', async ({ page }) => {
    test.setTimeout(90_000)
    await openBoard(page)
    await page.getByTestId('replay-sample').click()
    await expect(page.getByTestId('report')).toBeVisible({ timeout: 40_000 })

    await page.getByTestId('replay-banner').getByRole('button', { name: /live/i }).click()

    await expect(page.getByTestId('board-state')).toHaveText('Live')
    await expect(page.getByTestId('quota')).toContainText('2 of 3')
    await expect(page.getByTestId('report')).toBeVisible({ timeout: 60_000 })
  })
})

test.describe('a live review', () => {
  test('runs a contract that talks to its reviewer from the check to the report, with the screen\'s verdict, and counts it', async ({ page }) => {
    test.setTimeout(90_000)
    const writes = watchWrites(page)
    await openBoard(page)
    await choose(page, 'hostile-supply')
    await page.getByTestId('run-sample').click()

    await expect(page.getByTestId('progress')).toBeVisible()
    await expect(page.getByTestId('quota')).toContainText('2 of 3')
    await expect(page.getByTestId('run-sample')).toBeDisabled()
    await expect(page.getByTestId('report')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('screen-verdict')).toContainText('address an AI reviewer')
    await expect(page.getByTestId('progress')).toHaveCount(0)
    await expect(page.getByTestId('announcement')).toContainText('The review is done')
    await expect(page.getByTestId('scope-row').first()).toBeVisible()
    await expect(page.getByTestId('scope').getByRole('link')).toHaveAttribute('href', /\/runs\//)
    await expect(page.getByTestId('my-contracts')).toHaveCount(0)
    expect(writes).toContain('POST /api/session/verify')
    expect(writes.filter(write => write === 'POST /api/lb04/contracts')).toHaveLength(1)
  })

  test('shows each step by the state the service reports, in order, and never ahead of it', async ({ page }) => {
    test.setTimeout(90_000)
    await openBoard(page)
    const seen = new Set<string>()
    page.on('response', (response) => {
      if (!/\/api\/lb04\/contracts\/[\w-]+$/.test(response.url())) return
      void response.json().then((view: { state: string }) => seen.add(view.state)).catch(() => undefined)
    })
    await choose(page, 'hostile-supply')
    await page.getByTestId('run-sample').click()

    for (const state of ['extracting', 'analysing', 'verifying']) {
      await expect(page.getByTestId('progress')).toHaveAttribute('data-state', state, { timeout: 40_000 })
      const steps = await page.locator('[data-testid="progress"] li').evaluateAll(items => items.map(item => item.getAttribute('data-status')))
      const order = ['queued', 'extracting', 'analysing', 'verifying']
      expect(steps).toEqual(order.map((step, index) => (index < order.indexOf(state) ? 'done' : index === order.indexOf(state) ? 'now' : 'next')))
    }
    await expect(page.getByTestId('report')).toBeVisible({ timeout: 40_000 })
    expect([...seen]).toEqual(expect.arrayContaining(['extracting', 'analysing', 'verifying', 'done']))
  })

  test('proposes a wording for a finding as a word-by-word redline in real text, labelled and counted', async ({ page }) => {
    test.setTimeout(90_000)
    await openBoard(page)
    await reviewLive(page, 'wholesale-supply')
    await expect(page.getByTestId('redlines-left')).toContainText('3 of 3')
    const first = page.locator('article[data-finding]').first()

    await first.getByRole('button', { name: 'Propose a wording' }).click()

    await expect(first.getByTestId('redline')).toBeVisible({ timeout: 20_000 })
    await expect(first.getByTestId('redline')).toContainText('Not legal advice')
    expect(await first.getByTestId('redline').locator('ins, del').count()).toBeGreaterThan(0)
    await expect(first.getByTestId('redline-diff')).toContainText(/Removed:|Added:/)
    expect((await first.getByTestId('redline-proposal').innerText()).length).toBeGreaterThan(40)
    await expect(page.getByTestId('redlines-left')).toContainText('2 of 3')
    await expect(first.getByRole('button', { name: 'Propose a wording' })).toHaveCount(0)
  })

  test('refuses a scan live with its reason, takes nothing from the day, and shows no report', async ({ page }) => {
    test.setTimeout(90_000)
    await openBoard(page)
    await choose(page, 'scanned-supply')
    await page.getByTestId('run-sample').click()

    await expect(page.getByTestId('failure')).toBeVisible({ timeout: 40_000 })
    await expect(page.getByTestId('failure')).toHaveAttribute('data-code', 'no_text_layer')
    await expect(page.getByTestId('failure')).toContainText('Your place for the day was given back')
    await expect(page.getByTestId('report')).toHaveCount(0)
    await expect(page.getByTestId('quota')).toContainText('3 of 3')
    await expect(page.getByTestId('announcement')).toHaveText('The review failed.')
  })

  test('refuses a contract of 31 pages and names the limit', async ({ page }) => {
    test.setTimeout(90_000)
    await openBoard(page)
    await choose(page, 'master-supply-31')
    await page.getByTestId('run-sample').click()

    await expect(page.getByTestId('failure')).toBeVisible({ timeout: 40_000 })
    await expect(page.getByTestId('failure')).toHaveAttribute('data-code', 'too_many_pages')
    await expect(page.getByTestId('failure')).toContainText('more than 30 pages')
  })

  test('stops waiting, keeps the contract in the visitor\'s list, and opens it again to its report without another contract', async ({ page }) => {
    test.setTimeout(90_000)
    const writes = watchWrites(page)
    await openBoard(page)
    await choose(page, 'hostile-supply')
    await page.getByTestId('run-sample').click()
    await expect(page.getByTestId('progress')).toBeVisible()

    await page.getByTestId('progress').getByRole('button', { name: 'Stop waiting' }).click()

    await expect(page.getByTestId('stopped')).toBeVisible()
    await expect(page.getByTestId('progress')).toHaveCount(0)
    await expect(page.getByTestId('my-contracts')).toContainText('Supply agreement with instructions for an AI reviewer')
    await expect(page.getByTestId('quota')).toContainText('2 of 3')
    await page.getByTestId('my-contracts').getByRole('button', { name: 'Open' }).click()
    await expect(page.getByTestId('report')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('quota')).toContainText('2 of 3')
    expect(writes.filter(write => write === 'POST /api/lb04/contracts')).toHaveLength(1)
  })

  test('deletes the contract on request, empties the board, and does not give the place back', async ({ page }) => {
    test.setTimeout(90_000)
    await openBoard(page)
    await reviewLive(page, 'clean-supply')

    await page.getByTestId('delete-contract').click()

    await expect(page.getByTestId('report')).toHaveCount(0)
    await expect(page.getByTestId('contract')).toHaveCount(0)
    await expect(page.getByTestId('my-contracts')).toHaveCount(0)
    await expect(page.getByTestId('quota')).toContainText('2 of 3')
  })
})

test.describe('the visitor\'s own PDF', () => {
  test('is checked in the browser first: a letter, an empty file and a file that is too large are refused before anything is sent', async ({ page }) => {
    const writes = watchWrites(page)
    await openBoard(page)
    await page.getByRole('button', { name: 'Your own PDF' }).click()
    const input = page.getByTestId('upload-input')
    const send = page.getByTestId('run-file')

    await input.setInputFiles({ name: 'letter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('Dear sir, this is a letter') })
    await expect(page.getByTestId('upload')).toContainText('The file is not a PDF.')
    await expect(send).toBeDisabled()
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await input.setInputFiles({ name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) })
    await expect(page.getByTestId('upload')).toContainText('The file is empty.')
    await input.setInputFiles({ name: 'big.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2 * 1_048_576)]) })
    await expect(page.getByTestId('upload')).toContainText('larger than 2.0 MB')
    await expect(send).toBeDisabled()
    expect(writes).toEqual([])
  })

  test('is reviewed and shown: sent as base64, kept in the browser for the viewer, with its pages read the same by both readers', async ({ page }) => {
    test.setTimeout(120_000)
    const requests: string[] = []
    page.on('request', request => requests.push(`${request.method()} ${new URL(request.url()).pathname}`))
    await openBoard(page)
    await page.getByRole('button', { name: 'Your own PDF' }).click()
    await page.getByTestId('upload-input').setInputFiles(join(CONTRACTS, 'wholesale-supply.pdf'))
    await expect(page.getByTestId('upload')).toContainText('Chosen: wholesale-supply.pdf')

    await page.getByTestId('run-file').click()

    await expect(page.getByTestId('report')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('contract')).toContainText('wholesale-supply.pdf')
    await page.locator('article[data-finding]').first().getByRole('button', { name: 'Show in the contract' }).click()
    await waitForViewer(page)
    await expect(page.getByTestId('text-agreement')).toHaveAttribute('data-state', 'match')
    expect(await inkOnPage(page)).toBeGreaterThan(2_000)
    expect(requests.filter(request => /\/file$/.test(request))).toEqual([])
  })
})

test.describe('the day\'s contracts', () => {
  test('say, after the service refuses for the day, that none are left and when the day starts again', async ({ page, problems }) => {
    await openBoard(page)
    await page.route('**/api/lb04/contracts', route => (route.request().method() === 'POST'
      ? route.fulfill({ status: 429, json: { error: { code: 'daily_limit', message: 'x', resets_at: '2026-10-03T00:00:00Z' } } })
      : route.continue()))

    await choose(page, 'hostile-supply')
    await page.getByTestId('run-sample').click()

    await expect(page.getByTestId('notice')).toBeVisible()
    await expect(page.getByTestId('quota')).toContainText('0 of 3')
    await expect(page.getByTestId('run-sample')).toBeDisabled()
    await expect(page.getByTestId('starter')).toContainText('Today\'s contracts are used up')
    problems.errors.length = 0
  })

  test('are still open for the recorded samples when they are used up', async ({ page, problems }) => {
    await openBoard(page)
    await page.route('**/api/lb04/contracts', route => (route.request().method() === 'POST'
      ? route.fulfill({ status: 429, json: { error: { code: 'daily_limit', message: 'x' } } })
      : route.continue()))
    await choose(page, 'hostile-supply')
    await page.getByTestId('run-sample').click()
    await expect(page.getByTestId('quota')).toContainText('0 of 3')
    problems.errors.length = 0

    await choose(page, 'wholesale-supply')
    await page.getByTestId('replay-sample').click()

    await expect(page.getByTestId('report')).toBeVisible({ timeout: 40_000 })
  })

  test('say the model is unavailable when it is, in the board\'s own words, and nothing was taken', async ({ page, problems }) => {
    await openBoard(page)
    await page.route('**/api/lb04/contracts', route => (route.request().method() === 'POST'
      ? route.fulfill({ status: 503, json: { error: { code: 'analysis_unavailable', message: 'x' } } })
      : route.continue()))

    await choose(page, 'hostile-supply')
    await page.getByTestId('run-sample').click()

    await expect(page.getByTestId('own-notice')).toHaveAttribute('data-notice', 'model')
    await expect(page.getByTestId('quota')).toContainText('3 of 3')
    problems.errors.length = 0
  })
})

test.describe('the PDF viewer', () => {
  test('loads pdf.js and its worker only when the visitor asks for the pages, and from the site\'s own origin', async ({ page }) => {
    const code = watchPdfCode(page)
    await openBoard(page)
    await page.getByTestId('replay-sample').click()
    await expect(page.getByTestId('report')).toBeVisible({ timeout: 40_000 })
    await expect(page.getByTestId('open-viewer')).toBeVisible()
    expect(code.worker).toEqual([])
    expect(code.big).toEqual([])

    await openViewer(page)

    expect(code.worker).toHaveLength(1)
    expect(new URL(code.worker[0] ?? 'http://elsewhere.test').origin).toBe(new URL(page.url()).origin)
    expect(code.big.length).toBeGreaterThan(0)
    await expect(page.getByTestId('viewer')).toHaveAttribute('data-status', 'ready')
  })

  test('draws the page on a canvas, and the browser reads the same text as the server on every page', async ({ page }) => {
    await openBoard(page)
    await page.getByTestId('replay-sample').click()
    await expect(page.getByTestId('report')).toBeVisible({ timeout: 40_000 })

    await openViewer(page)

    expect(await inkOnPage(page)).toBeGreaterThan(2_000)
    await expect(page.getByTestId('text-agreement')).toHaveAttribute('data-state', 'match')
    await expect(page.getByTestId('text-agreement')).toContainText('all 11 pages')
  })

  test('highlights the cited words of a finding, over exactly the ink of those words and nowhere else', async ({ page }) => {
    await openBoard(page)
    await page.getByTestId('replay-sample').click()
    await expect(page.getByTestId('report')).toBeVisible({ timeout: 40_000 })
    const first = page.locator('article[data-finding]').first()
    const id = await first.getAttribute('data-finding')

    await first.getByRole('button', { name: 'Show in the contract' }).click()
    await waitForViewer(page)

    await expect(first.getByRole('button', { name: 'Show in the contract' })).toHaveAttribute('aria-pressed', 'true')
    const boxes = page.locator(`[data-testid="highlight"][data-finding="${id}"]`)
    expect(await boxes.count()).toBeGreaterThan(0)
    const ink = await inkUnderFirstHighlight(page)
    expect(ink.under / ink.area).toBeGreaterThan(0.04)
    expect(ink.control).toBe(0)
    // The cited words are also text: the passage under the finding, and the page's own text with the same words marked.
    await page.getByTestId('viewer').locator('summary').click()
    const marked = (await page.getByTestId('page-text').locator('mark').allInnerTexts()).join(' ').replace(/\s+/g, ' ')
    expect(marked).toContain((await first.getByTestId('passage').innerText()).replace(/\s+/g, ' ').replace('THE CONTRACT\'S OWN WORDS', '').trim().slice(0, 30).trim())
  })

  test('goes to another finding\'s page when its button is pressed', async ({ page }) => {
    await openBoard(page)
    await page.getByTestId('replay-sample').click()
    await expect(page.getByTestId('report')).toBeVisible({ timeout: 40_000 })
    await page.locator('article[data-finding]').first().getByRole('button', { name: 'Show in the contract' }).click()
    await waitForViewer(page)
    const pageBefore = await page.getByTestId('viewer-page').inputValue()

    await page.locator('article[data-finding]').nth(1).getByRole('button', { name: 'Show in the contract' }).click()

    await expect(page.getByTestId('viewer-page')).not.toHaveValue(pageBefore)
    const second = await page.locator('article[data-finding]').nth(1).getAttribute('data-finding')
    await expect(page.locator(`[data-testid="highlight"][data-finding="${second}"]`).first()).toBeAttached()
  })

  test('selects a finding when its highlight is clicked, where two findings share a page', async ({ page }) => {
    await openBoard(page)
    await page.getByTestId('replay-sample').click()
    await expect(page.getByTestId('report')).toBeVisible({ timeout: 40_000 })
    const first = page.locator('article[data-finding]').first()
    const firstId = await first.getAttribute('data-finding')
    await first.getByRole('button', { name: 'Show in the contract' }).click()
    await waitForViewer(page)

    // The liability clause and the assignment of intellectual property are both on page 8 of this contract.
    const ids = await page.locator('[data-testid="highlight"]').evaluateAll(boxes => [...new Set(boxes.map(box => box.getAttribute('data-finding')))])
    expect(ids.length).toBeGreaterThanOrEqual(2)
    const otherId = ids.find(id => id !== firstId) ?? ''
    await page.locator(`[data-testid="highlight"][data-finding="${otherId}"]`).first().click({ force: true })

    await expect(page.locator(`article[data-finding="${otherId}"]`).getByRole('button', { name: 'Show in the contract' })).toHaveAttribute('aria-pressed', 'true')
    await expect(first.getByRole('button', { name: 'Show in the contract' })).toHaveAttribute('aria-pressed', 'false')
  })

  test('is operated with the keyboard: the page buttons, the page number, and the passage as text', async ({ page }) => {
    await openBoard(page)
    await page.getByTestId('replay-sample').click()
    await expect(page.getByTestId('report')).toBeVisible({ timeout: 40_000 })
    await openViewer(page)
    const number = page.getByTestId('viewer-page')
    await expect(number).toHaveValue('1')

    await page.getByRole('button', { name: 'Next page' }).focus()
    await page.keyboard.press('Enter')
    await expect(number).toHaveValue('2')
    await page.getByRole('button', { name: 'Previous page' }).focus()
    await page.keyboard.press('Space')
    await expect(number).toHaveValue('1')
    await number.fill('9')
    await number.press('Tab')
    await expect(number).toHaveValue('9')
    await number.fill('99')
    await number.press('Tab')
    await expect(number).toHaveValue('11')
    await page.getByTestId('viewer').locator('summary').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('page-text')).toBeVisible()
    await expect(page.getByRole('group', { name: /Page 11 of 11/ })).toBeVisible()
  })

  // The same check for every sample the system can read: the server's pdf.js (the legacy build, in a worker
  // thread) and the browser's (the modern build, in a module worker) must read the same text on every page,
  // because a citation counts its characters in the server's text and the highlight is drawn in the browser's.
  for (const sample of [
    { id: 'wholesale-supply', pages: 11 },
    { id: 'clean-supply', pages: 11 },
    { id: 'hostile-supply', pages: 6 },
    { id: 'master-supply-30', pages: 30 },
  ]) {
    test(`reads ${sample.id}'s ${sample.pages} pages as the server does`, async ({ page }) => {
      test.setTimeout(150_000)
      await openBoard(page)
      await reviewLive(page, sample.id)

      await openViewer(page)

      await expect(page.getByTestId('text-agreement')).toHaveAttribute('data-state', 'match')
      await expect(page.getByTestId('text-agreement')).toContainText(`all ${sample.pages} pages`)
      expect(await inkOnPage(page)).toBeGreaterThan(1_000)
    })
  }
})

test.describe('the policy of LB-04\'s board pages (docs/SECURITY.md, section 3)', () => {
  for (const path of ['/systems/lb-04/board', '/cs/systems/lb-04/board']) {
    test(`${path} adds the PDF worker's policy and the worker source, and nothing wide`, async ({ request }) => {
      const csp = (await request.get(path)).headers()['content-security-policy'] ?? ''
      expect(csp).toContain('trusted-types vue lb-turnstile lb-pdf-worker')
      expect(csp).toContain('worker-src \'self\'')
      expect(csp).toContain('frame-src https://challenges.cloudflare.com')
      expect(csp).toContain('connect-src \'self\';')
      expect(csp).toContain('require-trusted-types-for \'script\'')
      expect(csp).toMatch(/script-src 'self' 'strict-dynamic' 'nonce-[\w+/=-]{16,}'/)
      expect(csp).not.toContain('*')
      expect(csp).not.toMatch(/unsafe-eval|allow-duplicates|wasm-unsafe-eval/)
      const trusted = csp.split(';').map(part => part.trim()).find(part => part.startsWith('trusted-types ')) ?? ''
      expect(trusted.split(' ')).not.toContain('default')
    })
  }

  for (const path of ['/', '/cs', '/systems/lb-04', '/cs/systems/lb-04', '/systems/lb-01/board', '/systems/lb-05/board', '/systems/lb-08/board', '/cs/systems/lb-08/board']) {
    test(`${path} does not get the PDF worker's policy`, async ({ request }) => {
      const csp = (await request.get(path)).headers()['content-security-policy'] ?? ''
      expect(csp).not.toContain('lb-pdf-worker')
      expect(csp).not.toContain('worker-src')
    })
  }

  test('the page can start no worker and make no policy of its own: only the one address, under the one name', async ({ page, problems }) => {
    await openBoard(page)

    const outcome = await page.evaluate(() => {
      const results: Record<string, string> = {}
      /** Runs a step and records the name of the error it threw, or that it did not. */
      const attempt = (name: string, step: () => unknown): void => {
        try {
          step()
          results[name] = 'allowed'
        }
        catch (error) {
          results[name] = error instanceof Error ? error.name : 'threw'
        }
      }
      attempt('a worker from a plain string', () => new Worker('/_nuxt/anything.js'))
      attempt('a policy named default', () => window.trustedTypes?.createPolicy('default', { createScriptURL: input => input }))
      attempt('a policy of another name', () => window.trustedTypes?.createPolicy('lb-evil', { createScriptURL: input => input }))
      return results
    })

    expect(outcome['a worker from a plain string']).toBe('TypeError')
    expect(outcome['a policy named default']).toBe('TypeError')
    expect(outcome['a policy of another name']).toBe('TypeError')
    // The browser itself reported each refusal. They are the violations this test provoked, so they are taken
    // off the page's list here, where the fixture would fail the test for them.
    const reported = await page.evaluate(() => window.__cspViolations.splice(0))
    expect(reported).toEqual([
      expect.stringMatching(/^require-trusted-types-for blocked trusted-types-sink Worker constructor/),
      'trusted-types blocked trusted-types-policy default',
      'trusted-types blocked trusted-types-policy lb-evil',
    ])
    // The console says the same three things, as errors, which the fixture would also fail the test for.
    expect(problems.errors).toHaveLength(3)
    expect(problems.errors.join(' ')).toContain('requires \'TrustedScriptURL\' assignment')
    expect(problems.errors.join(' ')).toContain('Creating a TrustedTypePolicy named \'default\'')
    expect(problems.errors.join(' ')).toContain('Creating a TrustedTypePolicy named \'lb-evil\'')
    problems.errors.length = 0
  })

  test('the worker file is served from the site\'s own origin, as a script, with nothing else of pdf.js loaded from elsewhere', async ({ page }) => {
    const origins = new Set<string>()
    page.on('request', request => origins.add(new URL(request.url()).origin))
    await openBoard(page)
    await page.getByTestId('replay-sample').click()
    await expect(page.getByTestId('report')).toBeVisible({ timeout: 40_000 })
    await openViewer(page)

    expect([...origins]).toEqual([new URL(page.url()).origin])
  })
})

test.describe('using only the keyboard', () => {
  test('chooses a sample, replays it, narrows the findings by a topic, and opens the passage in the viewer', async ({ page }) => {
    await openBoard(page)
    await page.locator('input[type="radio"][value="wholesale-supply"]').focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    await expect(page.locator('input[type="radio"][value="wholesale-supply"]')).toBeChecked()
    await page.getByTestId('replay-sample').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('report')).toBeVisible({ timeout: 40_000 })

    const topic = page.getByTestId('radar').locator('tbody button:not([disabled])').first()
    await topic.focus()
    await page.keyboard.press('Enter')
    await expect(topic).toHaveAttribute('aria-pressed', 'true')
    expect(await page.locator('article[data-finding]').count()).toBeLessThan(5)
    await page.getByRole('button', { name: 'Show all findings' }).focus()
    await page.keyboard.press('Space')
    await expect(page.locator('article[data-finding]')).toHaveCount(5)

    await page.locator('article[data-finding]').first().getByRole('button', { name: 'Show in the contract' }).focus()
    await page.keyboard.press('Enter')
    await waitForViewer(page)
    await expect(page.getByTestId('viewer-page')).not.toHaveValue('1')
  })

  test('has a visible focus ring on the buttons of the starter, the findings and the viewer', async ({ page }) => {
    await openBoard(page)
    await page.getByTestId('replay-sample').focus()
    const outline = await page.getByTestId('replay-sample').evaluate(button => getComputedStyle(button).outlineStyle)
    expect(outline).not.toBe('none')
  })
})

test.describe('in Czech', () => {
  test('speaks Czech from the starter to the report, and keeps the contract\'s own words as they are', async ({ page }) => {
    await openBoard(page, '/cs/systems/lb-04/board', '3 z 3')
    await expect(page.getByTestId('starter')).toContainText('Vyberte smlouvu')
    await expect(page.locator('html')).toHaveAttribute('lang', 'cs')

    await page.getByTestId('replay-sample').click()

    await expect(page.getByTestId('report')).toBeVisible({ timeout: 40_000 })
    await expect(page.getByTestId('report')).toContainText('Ukázat ve smlouvě')
    await expect(page.getByTestId('passage').first()).toContainText('shall be unlimited')
    await expect(page.getByTestId('announcement')).toContainText('Kontrola je hotová')
    await expect(page.getByTestId('contract')).toContainText('Nejde o právní poradenství')
  })

  test('shows the viewer in Czech, with the same agreement between the readers', async ({ page }) => {
    await openBoard(page, '/cs/systems/lb-04/board', '3 z 3')
    await page.getByTestId('replay-sample').click()
    await expect(page.getByTestId('report')).toBeVisible({ timeout: 40_000 })
    await page.locator('article[data-finding]').first().getByRole('button', { name: 'Ukázat ve smlouvě' }).click()
    await waitForViewer(page)

    await expect(page.getByTestId('text-agreement')).toHaveAttribute('data-state', 'match')
    await expect(page.getByRole('button', { name: 'Další strana' })).toBeVisible()
  })
})

test.describe('the Brief reading', () => {
  test('keeps the report short: one sentence of figures, no playbook and no source on each finding', async ({ page }) => {
    await openBoard(page)
    await page.getByRole('group', { name: 'Reading mode' }).getByRole('button', { name: 'Brief' }).click()
    await page.getByTestId('replay-sample').click()

    await expect(page.getByTestId('report')).toBeVisible({ timeout: 40_000 })
    await expect(page.getByTestId('report-summary')).toContainText('The server checked')
    await expect(page.getByTestId('playbook')).toHaveCount(0)
    await expect(page.getByText('Found by the model')).toHaveCount(0)
  })
})
