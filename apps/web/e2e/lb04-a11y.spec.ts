// End-to-end accessibility checks of LB-04's evaluation board: axe finds no WCAG 2.2 AA violation in any
// state a visitor can reach (nothing chosen yet, the visitor's own PDF with a problem shown, a review in
// progress, a report with its radar, its findings, a proposed wording and its trace, a report of nothing, the
// PDF viewer with its highlights and its text alternative, a refused file, the playbook, a notice), in both
// languages and both themes. The radar is an image with a title and a description and a table that says the
// same in words; the viewer's canvas and its highlights are decoration for a reader who has the page's text.
// Every test also fails on a CSP violation or a console error (e2e/fixtures.ts).
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

const languages = [
  { code: 'en', prefix: '', counted: '3 of 3', ownTab: 'Your own PDF', show: 'Show in the contract' },
  { code: 'cs', prefix: '/cs', counted: '3 z 3', ownTab: 'Vaše vlastní PDF', show: 'Ukázat ve smlouvě' },
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

/** Chooses a sample by its ID. */
async function choose(page: Page, id: string): Promise<void> {
  await page.locator(`input[type="radio"][value="${id}"]`).check()
}

/** Replays the first sample's recording and waits for its report. */
async function replayReport(page: Page): Promise<void> {
  await page.getByTestId('replay-sample').click()
  await expect(page.getByTestId('report')).toBeVisible({ timeout: 40_000 })
  await expect(page.getByTestId('scope-row').first()).toBeVisible()
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const language of languages) {
    test.describe(`the board in ${language.code}, ${colorScheme} theme`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme })
        await page.goto(`${language.prefix}/systems/lb-04/board`)
        await expect(page.locator('html')).toHaveClass(themeClass[colorScheme])
        await expect(page.getByTestId('quota')).toContainText(language.counted)
      })

      test('meets WCAG 2.2 AA before anything is chosen', async ({ page }) => {
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with the playbook open', async ({ page }) => {
        await page.getByTestId('playbook').locator('summary').click()
        await expect(page.getByTestId('playbook').locator('h3').first()).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with the visitor\'s own PDF open and a problem shown', async ({ page }) => {
        await page.getByRole('button', { name: language.ownTab }).click()
        await page.getByTestId('upload-input').setInputFiles({ name: 'letter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('Dear sir, this is a letter') })
        await expect(page.getByTestId('upload').getByRole('alert')).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA after a replay, with the radar, the findings, a proposed wording and the trace', async ({ page }) => {
        await replayReport(page)
        await expect(page.getByTestId('redline')).toHaveCount(1)
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with the PDF viewer open and the cited words highlighted', async ({ page }) => {
        await replayReport(page)
        await page.locator('article[data-finding]').first().getByRole('button', { name: language.show }).click()
        await expect(page.getByTestId('viewer')).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
        await expect(page.getByTestId('text-agreement')).toHaveAttribute('data-state', 'match', { timeout: 60_000 })
        await expect(page.getByTestId('highlight').first()).toBeAttached()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with a page\'s text open under the viewer, the cited words marked', async ({ page }) => {
        await replayReport(page)
        await page.locator('article[data-finding]').first().getByRole('button', { name: language.show }).click()
        await expect(page.getByTestId('text-agreement')).toHaveAttribute('data-state', 'match', { timeout: 60_000 })
        await page.getByTestId('viewer').locator('summary').click()
        await expect(page.getByTestId('page-text').locator('mark').first()).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA for a report of nothing', async ({ page }) => {
        await choose(page, 'clean-supply')
        await replayReport(page)
        await expect(page.getByTestId('no-findings')).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA for a file the system refuses', async ({ page }) => {
        await choose(page, 'scanned-supply')
        await page.getByTestId('replay-sample').click()
        await expect(page.getByTestId('failure')).toBeVisible({ timeout: 40_000 })
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA while a live review is still being waited for', async ({ page }) => {
        // Hold back the reads of the contract, so the review stays in the state under test long enough to scan.
        let release: () => void = () => undefined
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        await page.route(/\/api\/lb04\/contracts\/[\w-]+$/, async (route) => {
          await held
          await route.continue().catch(() => undefined)
        })
        await choose(page, 'hostile-supply')
        await page.getByTestId('run-sample').click()
        await expect(page.getByTestId('progress')).toBeVisible()
        await expect(page.getByTestId('progress')).toHaveAttribute('data-state', 'queued')
        await expectNoViolations(page)
        release()
      })

      test('meets WCAG 2.2 AA with a notice shown', async ({ page, problems }) => {
        await page.route('**/api/lb04/contracts', route => (route.request().method() === 'POST'
          ? route.fulfill({ status: 429, json: { error: { code: 'daily_limit', message: 'x', resets_at: '2026-10-03T00:00:00Z' } } })
          : route.continue()))
        await choose(page, 'hostile-supply')
        await page.getByTestId('run-sample').click()
        await expect(page.getByTestId('notice')).toBeVisible()
        problems.errors.length = 0
        await expectNoViolations(page)
      })
    })
  }
}
