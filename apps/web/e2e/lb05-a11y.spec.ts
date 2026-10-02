// End-to-end accessibility checks of LB-05's evaluation board: axe finds no WCAG 2.2 AA violation in
// any state a visitor can reach (nothing asked yet, the visitor's own question open, the safety demo,
// an answer with its chart, its data table and its open definitions, an attack stopped by a layer, a
// question still waiting, a thousand-row result, a notice), in both languages and both themes. The
// chart is drawn for real, on a canvas, so its text alternative and its data table are what axe sees.
// Every test also fails on a CSP violation or a console error (e2e/fixtures.ts).
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

const languages = [
  { code: 'en', prefix: '', counted: '25 of 25', ownQuestion: 'Your own question', question: 'Your question', attackTab: 'Try to break it', product: /Revenue by product/, attack: /Drop a table/, dump: /Dump every order/, ownAttack: 'Your own attack', tryIt: 'Try it', cutText: 'cut at 1,000 rows' },
  { code: 'cs', prefix: '/cs', counted: '25 z 25', ownQuestion: 'Vlastní otázka', question: 'Vaše otázka', attackTab: 'Zkusit ho rozbít', product: /Tržby podle produktu/, attack: /Smazat tabulku/, dump: /Vypsat všechny objednávky/, ownAttack: 'Váš vlastní útok', tryIt: 'Zkusit to', cutText: '1 000' },
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

for (const colorScheme of ['light', 'dark'] as const) {
  for (const language of languages) {
    test.describe(`the board in ${language.code}, ${colorScheme} theme`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme })
        await page.goto(`${language.prefix}/systems/lb-05/board`)
        await expect(page.locator('html')).toHaveClass(themeClass[colorScheme])
        await expect(page.getByTestId('quota')).toContainText(language.counted)
      })

      test('meets WCAG 2.2 AA before anything is asked', async ({ page }) => {
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with the visitor\'s own question open', async ({ page }) => {
        await page.getByRole('button', { name: language.ownQuestion }).click()
        await expect(page.getByLabel(language.question)).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with the safety demo open', async ({ page }) => {
        await page.getByRole('button', { name: language.attackTab }).click()
        await expect(page.getByTestId('safety')).toBeVisible()
        await expect(page.getByLabel(language.ownAttack)).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA after a replay, with the chart, the table, the SQL, the steps and the trace', async ({ page }) => {
        await page.getByRole('radio', { name: language.product }).check()
        await page.getByTestId('start-sample').click()
        await expect(page.getByTestId('chart-canvas')).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
        await expect(page.getByTestId('scope-row').first()).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with the chart\'s data table and a metric\'s definition open', async ({ page }) => {
        await page.getByRole('radio', { name: language.product }).check()
        await page.getByTestId('start-sample').click()
        await expect(page.getByTestId('chart-canvas')).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
        await page.getByTestId('chart-table-toggle').click()
        await expect(page.getByTestId('chart-table')).toBeVisible()
        await page.getByTestId('semantic-metric').first().locator('summary').click()
        await expect(page.getByTestId('semantic-metric').first().getByTestId('sql-text')).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA after an attack a layer stopped, with the six layers', async ({ page }) => {
        await page.getByRole('button', { name: language.attackTab }).click()
        await page.getByRole('radio', { name: language.attack }).check()
        await page.getByTestId('start-attack').click()
        await expect(page.getByTestId('stopped-by')).toBeVisible({ timeout: 30_000 })
        await expect(page.locator('[data-testid="layer"][data-state="stopped"]')).toHaveCount(1)
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with a thousand-row result cut at the row limit', async ({ page }) => {
        await page.getByRole('button', { name: language.attackTab }).click()
        await page.getByRole('radio', { name: language.dump }).check()
        await page.getByTestId('start-attack').click()
        await expect(page.getByTestId('result-cut')).toContainText(language.cutText, { timeout: 20_000 })
        await page.getByTestId('show-more').click()
        await expect(page.getByTestId('result-row')).toHaveCount(100)
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA while a live question is still being answered', async ({ page }) => {
        // Hold back the answer, so the question stays in the state under test long enough to scan.
        await page.route('**/api/lb05/ask', async (route) => {
          await new Promise(resolve => setTimeout(resolve, 5_000))
          return route.continue().catch(() => undefined)
        })
        await page.getByRole('button', { name: language.ownQuestion }).click()
        await page.getByLabel(language.question).fill('What was our revenue by country last year?')
        await page.getByTestId('ask-own').click()
        await expect(page.getByTestId('progress')).toBeVisible()
        await expect(page.getByTestId('elapsed')).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with a notice shown', async ({ page, problems }) => {
        await page.route('**/api/lb05/ask', route => route.fulfill({ status: 429, json: { error: { code: 'daily_limit', message: 'x', resets_at: '2026-10-03T00:00:00Z' } } }))
        await page.getByRole('button', { name: language.ownQuestion }).click()
        await page.getByLabel(language.question).fill('What was our revenue by country last year?')
        await page.getByTestId('ask-own').click()
        await expect(page.getByTestId('notice')).toBeVisible()
        problems.errors.length = 0
        await expectNoViolations(page)
      })
    })
  }
}
