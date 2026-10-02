// End-to-end accessibility checks of LB-03's evaluation board: axe finds no WCAG 2.2 AA violation in any
// state a visitor can reach (nothing read yet, the own-file form open and a file it will not send, a replay of
// a document whose check fails with its boxes lit and all drawn at once, the hostile invoice stopped, a live
// reading still in progress, a live reading with a field open for editing and the service's refusal shown, a
// corrected document with its journal and its exports, the refusals of an upload, a notice, a phone's width),
// in both languages and both themes. The page's picture is loaded for real and the boxes are drawn over it,
// so the confidence meter, the lit box's colours and the check statuses are what axe sees against both themes'
// backgrounds. Every test also fails on a CSP violation or a console error (e2e/fixtures.ts).
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

const languages = [
  { code: 'en', prefix: '', counted: '10 of 10', ownFile: 'Your own file', planted: /A total that does not add up/, hostile: /Invoice that gives orders/, clean: /Clean PDF invoice/, crumpled: /Crumpled photo/ },
  { code: 'cs', prefix: '/cs', counted: '10 z 10', ownFile: 'Váš vlastní soubor', planted: /Součet, který nesedí/, hostile: /Faktura, která dává rozkazy/, clean: /Čistá PDF faktura/, crumpled: /Pomačkaná fotografie/ },
] as const

// The class the theme script puts on <html>, matched as a whole word.
const themeClass = { light: /\blight\b/, dark: /\bdark\b/ } as const

/** Checks the page with axe against WCAG 2.2 AA and names each violation by rule and element. */
async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()
  expect(results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([])
}

/** Waits until a document's reading is done and its page is on show with the picture loaded. */
async function waitForReading(page: Page): Promise<void> {
  await expect(page.getByTestId('viewer')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('progress')).toHaveCount(0)
  await expect.poll(() => page.getByTestId('page-picture').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const language of languages) {
    test.describe(`the board in ${language.code}, ${colorScheme} theme`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme })
        await page.goto(`${language.prefix}/systems/lb-03/board`)
        await expect(page.locator('html')).toHaveClass(themeClass[colorScheme])
        await expect(page.getByTestId('quota')).toContainText(language.counted)
      })

      test('meets WCAG 2.2 AA before anything is read', async ({ page }) => {
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with the visitor\'s own file form open and a file the board will not send', async ({ page }) => {
        await page.getByRole('button', { name: language.ownFile }).click()
        await expect(page.getByTestId('file-input')).toBeVisible()
        await expectNoViolations(page)
        await page.getByTestId('file-input').setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') })
        await expect(page.getByTestId('file-problem')).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA after a replay of a document whose check fails, with its boxes, fields, checks, journal and steps', async ({ page }) => {
        await page.getByRole('radio', { name: language.planted }).check()
        await page.getByTestId('start-sample').click()
        await waitForReading(page)
        await expect(page.locator('[data-testid="check"][data-status="failed"]')).toHaveCount(1)
        await expect(page.getByTestId('scope-row').first()).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with a box lit from the table and with every box drawn at once', async ({ page }) => {
        await page.getByRole('radio', { name: language.clean }).check()
        await page.getByTestId('start-sample').click()
        await waitForReading(page)
        await page.locator('[data-testid="field-row"][data-path="vendor"]').getByTestId('look').click()
        await expect(page.locator('[data-testid="box"][data-lit="true"]')).toHaveAttribute('data-path', 'vendor')
        await expectNoViolations(page)
        await page.getByTestId('show-all').click()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA after the hostile invoice was stopped, with the reason and the step that flagged it', async ({ page }) => {
        await page.getByRole('radio', { name: language.hostile }).check()
        await page.getByTestId('start-sample').click()
        await expect(page.getByTestId('failure')).toBeVisible({ timeout: 20_000 })
        await expect(page.getByTestId('guard-score')).toBeVisible()
        await expect(page.getByTestId('steps')).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA while a live document is still being read', async ({ page }) => {
        // Hold back what the service says about the document, so it stays in the state under test long enough to scan.
        await page.route('**/api/lb03/documents/*', async (route) => {
          if (route.request().method() !== 'GET' || /\/(?:pages|export)\b/.test(route.request().url())) return route.continue()
          await new Promise(resolve => setTimeout(resolve, 6_000))
          return route.continue().catch(() => undefined)
        })
        await page.getByRole('radio', { name: language.crumpled }).check()
        await page.getByTestId('start-sample').click()
        await expect(page.getByTestId('progress')).toBeVisible()
        await expect(page.getByTestId('elapsed')).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with a live reading, a field open for editing and the service\'s refusal shown', async ({ page, problems }) => {
        await page.getByRole('radio', { name: language.clean }).check()
        await page.getByTestId('run-sample-live').click()
        await waitForReading(page)
        const date = page.locator('[data-testid="field-row"][data-path="issue_date"]')
        await date.getByTestId('edit').click()
        await expect(date.getByTestId('edit-input')).toBeFocused()
        await expectNoViolations(page)
        await date.getByTestId('edit-input').fill('14 September')
        await date.getByTestId('save-edit').click()
        await expect(date.getByTestId('edit-problem')).toBeVisible()
        // The browser logs the refusal (status 422) itself; it is the answer this test asked for.
        problems.errors.length = 0
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA after a correction, with the journal entry made and the files ready to export', async ({ page }) => {
        await page.getByRole('radio', { name: language.planted }).check()
        await page.getByTestId('run-sample-live').click()
        await waitForReading(page)
        const total = page.locator('[data-testid="field-row"][data-path="total"]')
        await total.getByTestId('edit').click()
        await total.getByTestId('edit-input').fill('1193.85')
        await total.getByTestId('save-edit').click()
        await expect(total.getByTestId('edited-tag')).toBeVisible()
        await expect(page.getByTestId('journal-balance')).toBeVisible()
        await expect(page.getByTestId('export-link')).toHaveCount(3)
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA after a duplicate was caught', async ({ page }) => {
        await page.getByRole('radio', { name: language.planted }).check()
        await page.getByTestId('run-sample-live').click()
        await waitForReading(page)
        await page.getByTestId('run-sample-live').click()
        await expect(page.getByTestId('duplicates')).toHaveAttribute('data-verdict', 'duplicate', { timeout: 20_000 })
        await expect(page.getByTestId('shelf-item')).toHaveCount(2)
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with the refusal of an upload shown in the board\'s own words', async ({ page, problems }) => {
        await page.route('**/api/lb03/documents', route => (route.request().method() === 'POST'
          ? route.fulfill({ status: 503, json: { error: { code: 'readers_busy', message: 'x' } } })
          : route.continue()))
        await page.getByRole('radio', { name: language.crumpled }).check()
        await page.getByTestId('start-sample').click()
        await expect(page.getByTestId('upload-notice')).toBeVisible()
        problems.errors.length = 0
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with the day\'s allowance used up', async ({ page, problems }) => {
        await page.route('**/api/lb03/documents', route => (route.request().method() === 'POST'
          ? route.fulfill({ status: 429, json: { error: { code: 'daily_limit', message: 'x', resets_at: '2026-10-03T00:00:00Z' } } })
          : route.continue()))
        await page.getByRole('radio', { name: language.crumpled }).check()
        await page.getByTestId('start-sample').click()
        await expect(page.getByTestId('notice')).toBeVisible()
        problems.errors.length = 0
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA on a phone, with the reading, the fields and the checklist on show', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.getByRole('radio', { name: language.planted }).check()
        await page.getByTestId('start-sample').click()
        await waitForReading(page)
        await expectNoViolations(page)
      })
    })
  }
}
