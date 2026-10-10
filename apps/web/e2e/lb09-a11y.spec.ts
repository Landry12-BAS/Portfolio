// End-to-end accessibility checks of LB-09's evaluation board: axe finds no WCAG 2.2 AA violation in
// any state a visitor can reach (the meetings before anything is started, the recorder with its
// explanation, a file the recorder refuses, a replayed meeting with its transcript, items and
// exports, and a meeting the worker failed, listed with the visitor's meetings), in both languages
// and both themes. Every test also fails on a CSP violation or a console
// error (e2e/fixtures.ts).
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

/** The mock back end's address, where its test controls live. */
const MOCK = `http://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 8121}`

const languages = [
  { code: 'en', prefix: '', counted: '5 of 5', record: 'Your own recording', replay: 'Replay this meeting', run: 'Run this meeting live' },
  { code: 'cs', prefix: '/cs', counted: '5 z 5', record: 'Vlastní nahrávka', replay: 'Přehrát tuto poradu', run: 'Spustit tuto poradu živě' },
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
        await page.goto(`${language.prefix}/systems/lb-09/board`)
        await expect(page.locator('html')).toHaveClass(themeClass[colorScheme])
        await expect(page.getByTestId('quota')).toContainText(language.counted)
      })

      test('meets WCAG 2.2 AA before anything is started', async ({ page }) => {
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with the recorder open', async ({ page }) => {
        await page.getByRole('button', { name: language.record }).click()
        await expect(page.getByTestId('recorder')).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with a file the recorder refuses', async ({ page }) => {
        await page.getByRole('button', { name: language.record }).click()
        await page.getByTestId('file-input').setInputFiles({ name: 'page.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('<html>not audio</html>') })
        await expect(page.getByTestId('file-problem')).toBeVisible()
        await expect(page.getByTestId('file-input')).toHaveAttribute('aria-invalid', 'true')
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with a replayed meeting, its transcript, items and exports', async ({ page }) => {
        await page.getByRole('button', { name: language.replay }).click()
        await expect(page.getByTestId('items')).toBeVisible({ timeout: 30_000 })
        await expect(page.getByTestId('export')).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with a failed meeting', async ({ page }) => {
        const answer = await page.request.post(`${MOCK}/__mock/lb09/fail`, { data: { reason: 'too_long' } })
        expect(answer.ok()).toBe(true)
        await page.getByRole('button', { name: language.run }).click()
        await expect(page.getByTestId('progress')).toHaveAttribute('data-status', 'failed', { timeout: 20_000 })
        await expectNoViolations(page)
      })
    })
  }
}
