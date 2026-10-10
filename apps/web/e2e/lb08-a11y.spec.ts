// End-to-end accessibility checks of LB-08's evaluation board: axe finds no WCAG 2.2 AA violation in
// any state a visitor can reach (nothing opened yet, a replay finished, a live workflow on the
// canvas with a step picked, the outline with a problem in it, a run waiting for its approval, a run
// with a dead letter and its replay, a described process the checks refused), in both languages and
// both themes. Every test also fails on a CSP violation or a console error (e2e/fixtures.ts).
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

const languages = [
  { code: 'en', prefix: '', counted: '10 of 10', refund: /^Refund approval/, lowStock: /^Low stock reorder/, wholesale: /^Wholesale order over €500 EN/, outline: 'Outline', own: 'Your own description', describe: 'What the process should do', brief: 'Brief' },
  { code: 'cs', prefix: '/cs', counted: '10 z 10', refund: /^Schválení vrácení peněz/, lowStock: /^Doobjednání při nízkém skladu/, wholesale: /^Velkoobchodní objednávka nad 500 € EN/, outline: 'Osnova', own: 'Váš vlastní popis', describe: 'Co má proces dělat', brief: 'Stručný' },
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

/** Opens a sample as a live workflow and waits for the canvas to be drawn. */
async function openLive(page: Page, sample: RegExp): Promise<void> {
  await page.getByRole('radio', { name: sample }).check()
  await page.getByTestId('open-sample-live').click()
  await expect(page.getByTestId('canvas-step').first()).toBeVisible()
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const language of languages) {
    test.describe(`the board in ${language.code}, ${colorScheme} theme`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme })
        await page.goto(`${language.prefix}/systems/lb-08/board`)
        await expect(page.locator('html')).toHaveClass(themeClass[colorScheme])
        await expect(page.getByTestId('quota')).toContainText(language.counted)
      })

      test('meets WCAG 2.2 AA before anything is opened', async ({ page }) => {
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with the visitor\'s own description form open', async ({ page }) => {
        await page.getByRole('button', { name: language.own }).click()
        await expect(page.getByLabel(language.describe)).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA after a replay, with the dead letter, what was sent and the log', async ({ page }) => {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
        await page.getByRole('radio', { name: language.lowStock }).check()
        await page.getByTestId('start-sample').click()
        await expect(page.getByTestId('dead-letter')).toHaveCount(1)
        await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'succeeded')
        await expect(page.getByTestId('scope-row').first()).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA on the canvas with a step picked and its form open', async ({ page }) => {
        await openLive(page, language.wholesale)
        await page.locator('.vue-flow__node[data-id="big_order"]').focus()
        await page.keyboard.press('Enter')
        await expect(page.getByTestId('inspector').getByRole('group').first()).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA in the outline with a problem at the step and in the list', async ({ page }) => {
        await openLive(page, language.wholesale)
        await page.getByRole('button', { name: language.outline, exact: true }).click()
        await page.locator('[data-testid="outline-step"][data-step="big_order"] [data-testid="outline-remove"]').click()
        await expect(page.locator('[data-testid="issue"]').first()).toBeVisible()
        await expect(page.locator('[data-testid="step-problem"]').first()).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA while a run waits for its approval, and after it', async ({ page }) => {
        await openLive(page, language.refund)
        await page.getByTestId('run').click()
        await expect(page.getByTestId('approval')).toBeVisible({ timeout: 15_000 })
        await expectNoViolations(page)
        await page.getByTestId('approve').click()
        await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'succeeded', { timeout: 20_000 })
        await expect(page.getByTestId('sent-summary')).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with a failed step, its countdown and its dead letter', async ({ page }) => {
        await openLive(page, language.lowStock)
        await page.locator('[data-testid="failure"][data-step="tell_purchasing"] select').selectOption('3')
        await page.getByTestId('run').click()
        await expect(page.getByTestId('retry-countdown').first()).toBeVisible({ timeout: 15_000 })
        await expectNoViolations(page)
        await expect(page.getByTestId('dead-letter')).toHaveCount(1, { timeout: 30_000 })
        await page.getByTestId('dead-replay').click()
        await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'succeeded', { timeout: 30_000 })
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA in the Brief reading with a finished run', async ({ page }) => {
        await openLive(page, language.lowStock)
        await page.getByTestId('run').click()
        await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'succeeded', { timeout: 20_000 })
        await page.getByRole('button', { name: language.brief, exact: true }).click()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA when the checks refused a described process', async ({ page, problems }) => {
        await page.getByRole('button', { name: language.own }).click()
        await page.getByLabel(language.describe).fill('Whenever a customer leaves a review, send them an SMS to thank them.')
        await page.getByTestId('describe').click()
        await expect(page.getByTestId('refusal')).toBeVisible({ timeout: 20_000 })
        await expectNoViolations(page)
        // The refusal is a 422 answer, which the browser logs as an error: it is the one expected here.
        expect(problems.errors.join(' ')).toContain('422')
        problems.errors.length = 0
      })
    })
  }
}
