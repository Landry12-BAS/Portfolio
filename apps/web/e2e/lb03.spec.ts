// End-to-end journeys of LB-03's evaluation board, in a real browser against the test build of the site and
// the mock back end: a recorded sample replayed (with its page picture loaded for real and every field's box
// over it), a sample read live through the site's own proxy (the picture of the page comes back through it as
// a JPEG), a file of the visitor's own, a field corrected and the files exported (downloaded for real), a
// document the injection check stopped, a duplicate, every refusal of an upload, the keyboard, both
// languages and the Brief reading. Every test also fails on a CSP or Trusted Types violation, a page error or a
// console error (e2e/fixtures.ts), which is the proof that a picture from the API is allowed by the page's
// policy and that a download needs no script. The Turnstile check is the test build's stand-in; the real
// widget needs Cloudflare and is covered by component tests only.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Locator, Page } from '@playwright/test'

import { expect, test } from './fixtures'

/** Where the seed's documents are: the files a visitor's own upload is made of in these journeys. */
const SEED_DOCUMENTS = join(import.meta.dirname, '../../../data/seed/lb03/documents')

/** Opens the board and waits until it has read the session and counted the day's documents. */
async function openBoard(page: Page, path = '/systems/lb-03/board', counted = '10 of 10'): Promise<void> {
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

/** Chooses a sample in the picker by its name. */
async function chooseSample(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('radio', { name }).check()
}

/** Switches the composer to the visitor's own file and sends one of the seed's documents. */
async function uploadOwn(page: Page, file: string, own = 'Your own file'): Promise<void> {
  await page.getByRole('button', { name: own }).click()
  await page.getByTestId('file-input').setInputFiles(join(SEED_DOCUMENTS, file))
  await page.getByTestId('upload').click()
}

/** Waits until the reading of a document is done and shows its page. */
async function waitForReading(page: Page): Promise<void> {
  await expect(page.getByTestId('viewer')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('progress')).toHaveCount(0)
}

/** Says whether a picture has been loaded and decoded by the browser. */
async function isDrawn(picture: Locator): Promise<boolean> {
  return picture.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)
}

/**
 * Asks the site for a path as the visitor's own browser does, which sends the session cookie. The test's
 * request fixture does not send a `Secure` cookie over plain HTTP, so it is always a visitor with no session.
 */
async function askAsVisitor(page: Page, path: string): Promise<{ status: number, headers: Record<string, string> }> {
  return page.evaluate(async (url) => {
    const answer = await fetch(url)
    return { status: answer.status, headers: Object.fromEntries(answer.headers.entries()) }
  }, path)
}

/** Lists the paths of the fields whose boxes are lit on the page. */
function litBoxes(page: Page): Locator {
  return page.locator('[data-testid="box"][data-lit="true"]')
}

/** Finds the row of a field in the table by its path. */
function fieldRow(page: Page, path: string): Locator {
  return page.locator(`[data-testid="field-row"][data-path="${path}"]`)
}

test.describe('replaying a recorded sample', () => {
  test('plays the recording as a replay, with the page picture and every box over it, and reads nothing and spends nothing', async ({ page }) => {
    const writes = watchWrites(page)
    await openBoard(page)
    await expect(page.getByTestId('board-state')).toHaveText('Live')
    await expect(page.locator('.state[data-recording="yes"]')).toHaveCount(3)

    await page.getByTestId('start-sample').click()

    await expect(page.getByTestId('board-state')).toHaveText('Replay')
    await expect(page.getByTestId('replay-banner')).toContainText('Replay of a recorded run')
    await expect(page.getByTestId('replay-banner')).toContainText('none of your allowance is used')
    await waitForReading(page)
    await expect(page.getByTestId('page-picture')).toHaveAttribute('src', '/lb03/pages/clean-pdf-1.jpg')
    await expect.poll(() => isDrawn(page.getByTestId('page-picture'))).toBe(true)
    expect(await page.getByTestId('box').count()).toBeGreaterThan(10)
    await expect(litBoxes(page)).toHaveCount(1)
    await expect(page.locator('[data-testid="check"][data-status="passed"]')).toHaveCount(11)
    await expect(page.getByTestId('journal-balance')).toHaveText('Balanced: debit equals credit.')
    await expect(page.getByTestId('read-only')).toContainText('This is a replay')
    await expect(page.getByTestId('edit')).toHaveCount(0)
    await expect(page.getByTestId('export-link')).toHaveCount(0)
    await expect(page.getByTestId('export-off')).toHaveCount(3)
    await expect(page.getByTestId('scope-row').first()).toContainText('invoice reading')
    await expect(page.getByTestId('quota')).toContainText('10 of 10')
    expect(writes).toEqual([])
  })

  test('replays a document that fails a check, shows the check and lights the field it names', async ({ page }) => {
    await openBoard(page)
    await chooseSample(page, /A total that does not add up/)
    await page.getByTestId('start-sample').click()
    await waitForReading(page)

    const failed = page.locator('[data-testid="check"][data-status="failed"]')
    await expect(failed).toHaveCount(1)
    await expect(failed.getByTestId('check-status')).toHaveText('Failed, stops the export')
    await expect(failed.getByTestId('check-sentence')).toHaveText('The subtotal plus the VAT comes to 1193.85, but the total says 1293.85.')
    await expect(litBoxes(page)).toHaveAttribute('data-path', 'total')
    await expect(page.getByTestId('viewer-caption')).toContainText('1293.85')
    await expect(fieldRow(page, 'total').getByTestId('field-check')).toHaveText('Subtotal plus VAT is the total')
    await expect(page.getByTestId('journal-none')).toContainText('No entry is made while a check that stops the export has failed')
    await expect(page.getByTestId('counter-checks')).toHaveText('1 failed of 11')
  })

  test('replays the hostile invoice: the page it was on, why no model was shown it, and the step that flagged it', async ({ page }) => {
    await openBoard(page)
    await chooseSample(page, /Invoice that gives orders/)
    await page.getByTestId('start-sample').click()

    await expect(page.getByTestId('failure')).toContainText('No model was shown it, so nothing in it could change what was read', { timeout: 20_000 })
    await expect(page.getByTestId('guard-score')).toHaveText('The injection check\'s score for the text was 0.99.')
    await expect(page.getByTestId('page-picture')).toHaveAttribute('src', '/lb03/pages/prompt-injection-1.jpg')
    await expect.poll(() => isDrawn(page.getByTestId('page-picture'))).toBe(true)
    await expect(page.getByTestId('fields')).toHaveCount(0)
    await expect(page.getByTestId('chain-state').nth(1)).toHaveText('failed')
    await expect(page.getByTestId('chain-state').nth(2)).toHaveText('not reached')
  })

  test('can be replayed again, and a sample without a recording says so and offers the live reading', async ({ page }) => {
    await openBoard(page)
    await page.getByTestId('start-sample').click()
    await waitForReading(page)
    await page.getByRole('button', { name: 'Replay again' }).click()
    await expect(page.getByTestId('progress')).toBeVisible()
    await waitForReading(page)

    await chooseSample(page, /Crumpled photo/)
    await expect(page.getByTestId('no-recording')).toContainText('There is no recording of this sample yet')
    await expect(page.getByTestId('start-sample')).toHaveText('Read this sample live')
  })

  test('shows everything at once when the visitor prefers reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openBoard(page)
    await page.getByTestId('start-sample').click()
    await expect(page.getByTestId('viewer')).toBeVisible({ timeout: 1_500 })
    await expect(page.locator('[data-testid="check"][data-status="passed"]')).toHaveCount(11)
  })

  test('works in Czech, with the sample, the checks and the failure in Czech', async ({ page }) => {
    await openBoard(page, '/cs/systems/lb-03/board', '10 z 10')
    await expect(page.locator('html')).toHaveAttribute('lang', 'cs')
    await expect(page.getByTestId('board-state')).toHaveText('Živě')
    await chooseSample(page, /Součet, který nesedí/)
    await page.getByTestId('start-sample').click()
    await expect(page.getByTestId('board-state')).toHaveText('Přehrání')
    await waitForReading(page)
    await expect(page.locator('[data-testid="check"][data-status="failed"] [data-testid="check-sentence"]')).toHaveText('Mezisoučet plus DPH dá 1193.85, ale celkem říká 1293.85.')
    await expect(page.getByTestId('read-only')).toContainText('Je to přehrávka')
    await expect(page.getByTestId('viewer-caption')).toContainText('Celkem')
  })
})

test.describe('a document read live', () => {
  test('is read through the site\'s proxy from the first stage to the checked page, with the picture drawn by the service', async ({ page, context }) => {
    await openBoard(page)
    await chooseSample(page, /Euro invoice, three VAT rates/)
    await expect(page.getByTestId('no-recording')).toBeVisible()
    await page.getByTestId('start-sample').click()

    await expect(page.getByTestId('progress')).toBeVisible()
    await expect(page.getByTestId('quota')).toContainText('9 of 10')
    await expect(page.getByTestId('scope')).toContainText('Waiting for the trace')
    await expect(page.locator('[data-testid="stage"][data-state="current"]')).toHaveCount(1)
    await waitForReading(page)

    await expect(page.getByTestId('board-state')).toHaveText('Live')
    await expect(page.getByTestId('page-picture')).toHaveAttribute('src', /^\/api\/lb03\/documents\/[\w-]+\/pages\/1$/)
    await expect.poll(() => isDrawn(page.getByTestId('page-picture'))).toBe(true)
    await expect(fieldRow(page, 'vat.2.rate').getByTestId('field-value')).toHaveText('19')
    await expect(page.locator('[data-testid="check"][data-status="passed"]')).toHaveCount(11)
    await expect(page.getByTestId('scope-row').first()).toContainText('invoice reading')
    await expect(page.getByTestId('shelf-item')).toHaveCount(1)
    await expect(page.getByTestId('counter-state')).toHaveText('Read')
    expect((await context.cookies()).map(cookie => cookie.name)).toEqual(['__Host-lb_session'])
  })

  test('is a file of the visitor\'s own, sent after the check, and read as the file it is', async ({ page }) => {
    await openBoard(page)
    await uploadOwn(page, 'hanse-green-2026-4417.pdf')
    await waitForReading(page)
    await expect(page.getByTestId('shelf')).toContainText('hanse-green-2026-4417.pdf')
    await expect(page.getByTestId('quota')).toContainText('9 of 10')
  })

  test('is corrected in a field, every check runs again, and the files are exported for real', async ({ page }) => {
    await openBoard(page)
    await chooseSample(page, /A total that does not add up/)
    await page.getByTestId('run-sample-live').click()
    await waitForReading(page)
    await expect(page.locator('[data-testid="check"][data-status="failed"]')).toHaveCount(1)
    await expect(page.getByTestId('export-link')).toHaveCount(1)

    const total = fieldRow(page, 'total')
    await total.getByTestId('edit').click()
    await total.getByTestId('edit-input').fill('1193.85')
    await total.getByTestId('save-edit').click()

    await expect(page.getByTestId('fields-status')).toHaveText('Saved Total. Every check ran again. Checks that fail now: 0.')
    await expect(page.locator('[data-testid="check"][data-status="failed"]')).toHaveCount(0)
    await expect(total.getByTestId('edited-tag')).toHaveText('corrected')
    await expect(page.getByTestId('correction')).toHaveText('Total: was 1293.85, now 1193.85')
    await expect(page.getByTestId('counter-corrections')).toHaveText('1')
    await expect(page.getByTestId('journal-balance')).toBeVisible()
    await expect(page.getByTestId('export-link')).toHaveCount(3)

    const [journal] = await Promise.all([page.waitForEvent('download'), page.locator('[data-format="journal"] [data-testid="export-link"]').click()])
    expect(journal.suggestedFilename()).toBe('journal-entry.csv')
    const journalText = readFileSync(await journal.path() ?? '', 'utf8')
    expect(journalText.startsWith('﻿')).toBe(true)
    expect(journalText).toContain('1193.85')
    const [json] = await Promise.all([page.waitForEvent('download'), page.locator('[data-format="json"] [data-testid="export-link"]').click()])
    expect(json.suggestedFilename()).toBe('invoice.json')
    const reading = JSON.parse(readFileSync(await json.path() ?? '', 'utf8')) as { corrections: { path: string }[], invoice: { total: string } }
    expect(reading.corrections.map(item => item.path)).toEqual(['total'])
    expect(reading.invoice.total).toBe('1193.85')
  })

  test('keeps a value the service refuses open with the reason, and changes nothing', async ({ page, problems }) => {
    await openBoard(page)
    await page.getByTestId('run-sample-live').click()
    await waitForReading(page)
    const date = fieldRow(page, 'issue_date')
    await date.getByTestId('edit').click()
    await date.getByTestId('edit-input').fill('14 September')
    await date.getByTestId('save-edit').click()
    await expect(date.getByTestId('edit-problem')).toContainText('That value does not fit this field')
    // The browser logs the refusal (status 422) itself; it is the answer this journey asked for.
    problems.errors.length = 0
    await expect(date.getByTestId('edit-input')).toBeVisible()
    await expect(page.getByTestId('counter-corrections')).toHaveText('0')
  })

  test('lights the box of the field chosen in the table, in the checklist and on the page', async ({ page }) => {
    await openBoard(page)
    await chooseSample(page, /A total that does not add up/)
    await page.getByTestId('run-sample-live').click()
    await waitForReading(page)
    await expect(litBoxes(page)).toHaveAttribute('data-path', 'total')

    await fieldRow(page, 'vendor').getByTestId('look').click()
    await expect(litBoxes(page)).toHaveAttribute('data-path', 'vendor')
    await expect(page.getByTestId('viewer-caption')).toContainText('Hanseatic Green Coffee GmbH')
    await page.locator('[data-testid="check"][data-status="failed"]').getByTestId('check-field').click()
    await expect(litBoxes(page)).toHaveAttribute('data-path', 'total')
    await page.locator('[data-testid="box"][data-path="invoice_number"]').click({ force: true })
    await expect(litBoxes(page)).toHaveAttribute('data-path', 'invoice_number')
  })

  test('catches a document the visitor already has, before it compares it with the samples', async ({ page }) => {
    await openBoard(page)
    await chooseSample(page, /A total that does not add up/)
    await page.getByTestId('run-sample-live').click()
    await waitForReading(page)
    await expect(page.getByTestId('duplicates')).toHaveAttribute('data-verdict', 'none')

    await page.getByTestId('run-sample-live').click()
    await expect(page.getByTestId('duplicates')).toHaveAttribute('data-verdict', 'duplicate', { timeout: 20_000 })
    await expect(page.getByTestId('duplicate-kind')).toContainText('the same invoice again')
    await expect(page.locator('[data-testid="check"][data-check="not_duplicate"]')).toHaveAttribute('data-status', 'failed')
  })

  test('is stopped when its text gives orders: no fields, no export, and the check that flagged it', async ({ page }) => {
    await openBoard(page)
    await chooseSample(page, /Invoice that gives orders/)
    await page.getByTestId('run-sample-live').click()

    await expect(page.getByTestId('failure')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('refund')).toHaveText('The document still counts against today\'s allowance.')
    await expect(page.getByTestId('fields')).toHaveCount(0)
    await expect(page.getByTestId('export')).toHaveCount(0)
    await expect(page.getByTestId('counter-state')).toHaveText('No result')
    await expect(page.getByTestId('chain-state').nth(1)).toHaveText('failed')
  })

  test('is opened again from the shelf after the board was emptied, and deleted', async ({ page }) => {
    await openBoard(page)
    await page.getByTestId('start-sample').click()
    await waitForReading(page)
    await page.getByRole('button', { name: 'Read it live instead' }).click()
    await waitForReading(page)
    await expect(page.getByTestId('shelf-item')).toHaveCount(1)

    await page.reload()
    await expect(page.getByTestId('quota')).toContainText('9 of 10')
    await expect(page.getByTestId('shelf-item')).toHaveCount(1)
    await page.getByTestId('shelf-open').click()
    await waitForReading(page)
    await expect(page.locator('[data-testid="check"][data-status="passed"]')).toHaveCount(11)

    await page.getByTestId('shelf-delete').click()
    await expect(page.getByTestId('shelf-item')).toHaveCount(0)
    await expect(page.getByTestId('viewer')).toHaveCount(0)
  })

  test('has a permalink for its trace that opens on its own page', async ({ page }) => {
    await openBoard(page)
    await chooseSample(page, /Euro invoice, three VAT rates/)
    await page.getByTestId('start-sample').click()
    await waitForReading(page)
    await page.getByRole('link', { name: 'Open this trace on its own page' }).click()

    await expect(page).toHaveURL(/\/runs\/run-[\da-f]{20}$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trace of a run')
    await expect(page.getByTestId('scope-row').first()).toContainText('invoice reading')
    await expect(page.locator('.facts a[href="/systems/lb-03"]')).toContainText('LB-03')
  })

  test('works in Czech, from the visitor\'s own file to a corrected field', async ({ page }) => {
    await openBoard(page, '/cs/systems/lb-03/board', '10 z 10')
    await uploadOwn(page, 'planted-total-hanse-2026-4700.pdf', 'Váš vlastní soubor')
    await waitForReading(page)
    await expect(page.locator('[data-testid="check"][data-status="failed"] [data-testid="check-status"]')).toHaveText('Nesplněno, zastaví export')
    const total = fieldRow(page, 'total')
    await total.getByTestId('edit').click()
    await total.getByTestId('edit-input').fill('1193.85')
    await total.getByTestId('save-edit').click()
    await expect(page.getByTestId('fields-status')).toContainText('Uloženo: Celkem.')
    await expect(page.locator('[data-testid="check"][data-status="failed"]')).toHaveCount(0)
    await expect(page.getByTestId('quota')).toContainText('9 z 10')
  })
})

test.describe('the keyboard', () => {
  test('looks at a field, edits it, saves with Enter and leaves with Escape, and focus goes where a person expects', async ({ page }) => {
    await openBoard(page)
    await chooseSample(page, /A total that does not add up/)
    await page.getByTestId('run-sample-live').click()
    await waitForReading(page)
    const writes = watchWrites(page)

    const look = fieldRow(page, 'vendor').getByTestId('look')
    await look.focus()
    await page.keyboard.press('Enter')
    await expect(litBoxes(page)).toHaveAttribute('data-path', 'vendor')
    await expect(look).toHaveAttribute('aria-pressed', 'true')

    const edit = fieldRow(page, 'currency').getByTestId('edit')
    await edit.focus()
    await page.keyboard.press('Enter')
    const input = fieldRow(page, 'currency').getByTestId('edit-input')
    await expect(input).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(input).toHaveCount(0)
    await expect(edit).toBeFocused()
    expect(writes).toEqual([])

    await page.keyboard.press('Enter')
    await page.keyboard.type('E')
    await page.keyboard.press('Control+a')
    await page.keyboard.type('EUR')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('fields-status')).toContainText('Saved Currency.')
    await expect(edit).toBeFocused()
    expect(writes).toEqual([expect.stringContaining('POST /api/lb03/documents/')])
  })

  test('reaches every control of the composer in a sensible order and starts a replay with Enter', async ({ page }) => {
    await openBoard(page)
    await page.getByRole('radio', { name: /Clean PDF invoice/ }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('radio', { name: /Euro invoice/ })).toBeChecked()
    await page.keyboard.press('ArrowLeft')
    await page.getByTestId('start-sample').focus()
    await page.keyboard.press('Enter')
    await waitForReading(page)
  })
})

test.describe('when something fails', () => {
  test('says each refusal of an upload in its own words, and keeps the replays open', async ({ page, problems }) => {
    const answers: { status: number, code: string }[] = [
      { status: 413, code: 'too_large' },
      { status: 415, code: 'unsupported_file' },
      { status: 429, code: 'document_running' },
      { status: 503, code: 'readers_busy' },
    ]
    await page.route('**/api/lb03/documents', async (route) => {
      // Only an upload is refused; the board's list of the visitor's documents (a GET) goes through.
      if (route.request().method() !== 'POST') return route.continue()
      const next = answers.shift()
      if (next === undefined) return route.continue()
      return route.fulfill({ status: next.status, json: { error: { code: next.code, message: 'x' } } })
    })
    await openBoard(page)
    await chooseSample(page, /Crumpled photo/)
    const expectations = [
      ['too_large', 'This site passes on files of up to 4 MB.'],
      ['unsupported', 'The reader takes PDF, PNG, JPEG and WebP files'],
      ['running', 'Two of your documents are being read'],
      ['busy', 'Every reader is busy'],
    ] as const
    for (const [kind, text] of expectations) {
      await page.getByTestId('start-sample').click()
      await expect(page.getByTestId('upload-notice')).toHaveAttribute('data-kind', kind)
      await expect(page.getByTestId('upload-notice')).toContainText(text)
    }
    problems.errors.length = 0
    await chooseSample(page, /Clean PDF invoice/)
    await page.getByTestId('start-sample').click()
    await expect(page.getByTestId('viewer')).toBeVisible({ timeout: 15_000 })
  })

  test('says the day\'s allowance is used up, and still lets a recorded sample be replayed', async ({ page, problems }) => {
    await page.route('**/api/lb03/documents', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      return route.fulfill({ status: 429, json: { error: { code: 'daily_limit', message: 'x', resets_at: '2026-10-03T00:00:00Z' } } })
    })
    await openBoard(page)
    await chooseSample(page, /Crumpled photo/)
    await page.getByTestId('start-sample').click()

    await expect(page.getByTestId('notice')).toHaveAttribute('data-kind', 'quota')
    await expect(page.getByTestId('quota')).toContainText('0 of 10')
    await expect(page.getByTestId('live-hint')).toContainText('Today\'s documents are used up')
    problems.errors.length = 0
    await chooseSample(page, /Clean PDF invoice/)
    await page.getByTestId('start-sample').click()
    await expect(page.getByTestId('viewer')).toBeVisible({ timeout: 15_000 })
  })

  test('sends a file that is not what it says to the service, which refuses it by its first bytes, and the board says so', async ({ page, problems }) => {
    await openBoard(page)
    await page.getByRole('button', { name: 'Your own file' }).click()
    await page.getByTestId('file-input').setInputFiles({ name: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('this is not a pdf at all') })
    await page.getByTestId('upload').click()
    await expect(page.getByTestId('upload-notice')).toHaveAttribute('data-kind', 'unsupported')
    await expect(page.getByTestId('quota')).toContainText('10 of 10')
    problems.errors.length = 0
  })

  test('refuses before it sends a file that is too big, empty or not a kind the reader takes, and sends nothing', async ({ page }) => {
    const writes = watchWrites(page)
    await openBoard(page)
    await page.getByRole('button', { name: 'Your own file' }).click()
    const input = page.getByTestId('file-input')
    await input.setInputFiles({ name: 'big.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(4 * 1_048_576 + 1) })
    await expect(page.getByTestId('file-problem')).toHaveText('That file is over 4 MB, which is as much as this site passes on.')
    await input.setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') })
    await expect(page.getByTestId('file-problem')).toHaveText('Only PDF, PNG, JPEG and WebP files are read.')
    await input.setInputFiles({ name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) })
    await expect(page.getByTestId('file-problem')).toHaveText('That file is empty.')
    await expect(page.getByTestId('upload')).toBeDisabled()
    expect(writes).toEqual([])
  })

  test('says the site could not be reached when the network drops during an upload', async ({ page, problems }) => {
    await page.route('**/api/lb03/documents', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      return route.abort('connectionreset')
    })
    await openBoard(page)
    await chooseSample(page, /Crumpled photo/)
    await page.getByTestId('start-sample').click()
    await expect(page.getByTestId('notice')).toHaveAttribute('data-kind', 'network')
    problems.errors.length = 0
  })

  test('says a reading failed when the service says so, and gives its reason in the board\'s own words', async ({ page, problems }) => {
    await openBoard(page)
    await chooseSample(page, /Crumpled photo/)
    await page.route('**/api/lb03/documents/*', async (route) => {
      if (route.request().method() !== 'GET' || /\/(?:pages|export)\b/.test(route.request().url())) return route.continue()
      const response = await route.fetch()
      const body = await response.json() as Record<string, unknown>
      return route.fulfill({ response, json: { ...body, state: 'failed', failure: { code: 'model_budget', message: 'x' }, fields: null, checks: null, journal: null, journal_status: null, duplicate: null, can_export: false } })
    })
    await page.getByTestId('start-sample').click()
    await expect(page.getByTestId('failure')).toContainText('Today\'s free model capacity is used up', { timeout: 20_000 })
    await expect(page.getByTestId('refund')).toContainText('given back to your day (up to 3 a day)')
    problems.errors.length = 0
  })

  test('says this copy of the site has no back end, and the replays still work', async ({ page, problems }) => {
    await page.route('**/api/session', route => route.fulfill({ json: { available: false, verified: false, siteKey: null, testMode: true, resetsAt: '2026-10-03T00:00:00.000Z' } }))
    await page.route('**/api/lb03/**', route => route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'This part of the site is not available right now.' } } }))
    await page.goto('/systems/lb-03/board')
    await expect(page.getByTestId('notice')).toHaveAttribute('data-kind', 'unavailable')
    await page.getByTestId('start-sample').click()
    await expect(page.getByTestId('viewer')).toBeVisible({ timeout: 15_000 })
    problems.errors.length = 0
  })
})

test.describe('reading modes, the datasheet link and the page', () => {
  test('shows less in the Brief reading, and the datasheet links to the board in both languages', async ({ page }) => {
    await page.goto('/systems/lb-03')
    await expect(page.getByText('The evaluation board for this part is open.')).toBeVisible()
    await page.getByRole('link', { name: 'Open the evaluation board' }).click()
    await expect(page).toHaveURL(/\/systems\/lb-03\/board$/)
    await expect(page.getByTestId('quota')).toContainText('10 of 10')

    await page.getByTestId('start-sample').click()
    await waitForReading(page)
    await expect(page.getByTestId('steps')).toBeVisible()
    await expect(page.getByTestId('counter-calls')).toBeVisible()
    await page.getByRole('group', { name: 'Reading mode' }).getByRole('button', { name: 'Brief' }).click()
    await expect(page.getByTestId('steps')).toHaveCount(0)
    await expect(page.getByTestId('counter-calls')).toHaveCount(0)
    await expect(page.locator('[data-testid="scope"] table')).toHaveCount(0)
    await expect(page.getByTestId('viewer')).toBeVisible()
    await expect(page.getByTestId('quota')).toBeVisible()

    await page.goto('/cs/systems/lb-03')
    await page.getByRole('link', { name: 'Otevřít vývojovou desku' }).click()
    await expect(page).toHaveURL(/\/cs\/systems\/lb-03\/board$/)
  })

  test('has the board\'s security headers, with the page pictures and the downloads of its own origin only', async ({ request }) => {
    const policy = (await request.get('/systems/lb-03/board')).headers()['content-security-policy'] ?? ''
    expect(policy).toContain('img-src \'self\' data:')
    expect(policy).toContain('connect-src \'self\'')
    expect(policy).toContain('frame-ancestors \'none\'')
    expect(policy).toContain('trusted-types vue lb-turnstile')
    expect(policy).not.toContain('blob:')
  })

  test('serves a document\'s picture and exports with no-store, nosniff and a plain file name, and refuses another visitor\'s', async ({ page, request }) => {
    await openBoard(page)
    await page.getByTestId('start-sample').click()
    await waitForReading(page)
    await page.getByRole('button', { name: 'Read it live instead' }).click()
    await waitForReading(page)
    const picture = await page.getByTestId('page-picture').getAttribute('src') ?? ''
    const download = await page.locator('[data-format="json"] [data-testid="export-link"]').getAttribute('href') ?? ''

    const pictureAnswer = await askAsVisitor(page, picture)
    expect(pictureAnswer.status).toBe(200)
    expect(pictureAnswer.headers['content-type']).toBe('image/jpeg')
    expect(pictureAnswer.headers['cache-control']).toBe('no-store')
    expect(pictureAnswer.headers['x-content-type-options']).toBe('nosniff')
    expect(pictureAnswer.headers['content-disposition']).toBe('inline; filename="page-1.jpg"')
    const downloadAnswer = await askAsVisitor(page, download)
    expect(downloadAnswer.status).toBe(200)
    expect(downloadAnswer.headers['cache-control']).toBe('no-store')
    expect(downloadAnswer.headers['x-content-type-options']).toBe('nosniff')
    expect(downloadAnswer.headers['content-disposition']).toBe('attachment; filename="invoice.json"')

    // A visitor with no session of their own is not the document's owner: it is as if the document were not there.
    for (const path of [picture, download]) {
      const stranger = await request.get(path)
      expect(stranger.status()).toBe(404)
      expect(await stranger.json()).toMatchObject({ error: { code: 'not_found' } })
    }
  })

  test('does not scroll sideways on a phone, with the reading, the fields and the checklist on show', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openBoard(page)
    await chooseSample(page, /A total that does not add up/)
    await page.getByTestId('start-sample').click()
    await waitForReading(page)
    await expect(page.getByTestId('fields')).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
})
