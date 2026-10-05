// End-to-end accessibility checks of LB-06's evaluation board: axe finds no WCAG 2.2 AA violation in
// any state a visitor can reach (nothing started yet, the visitor's own incident form open, a replay
// finished, a live incident with the fix waiting for approval, the same with the tables of numbers
// open and in the Brief reading, an incident closed with its postmortem, an incident ended early),
// in both languages and both themes. Every test also fails on a CSP violation or a console error
// (e2e/fixtures.ts).
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

const languages = [
  { code: 'en', prefix: '', left: '1 of 1', badDeploy: /^The cart release that broke checkout/, brief: 'Brief' },
  { code: 'cs', prefix: '/cs', left: '1 z 1', badDeploy: /^Vydání košíku/, brief: 'Stručný' },
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

/** Runs the curated incident live and waits for the proposal that waits for the visitor. */
async function runToProposal(page: Page, sample: RegExp): Promise<void> {
  await page.getByRole('radio', { name: sample }).check()
  await page.getByTestId('live-sample').click()
  await expect(page.getByTestId('approval-action')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('incident-state')).toHaveAttribute('data-state', 'awaiting_approval')
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const language of languages) {
    test.describe(`the board in ${language.code}, ${colorScheme} theme`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme })
        await page.goto(`${language.prefix}/systems/lb-06/board`)
        await expect(page.locator('html')).toHaveClass(themeClass[colorScheme])
        await expect(page.getByTestId('quota')).toContainText(language.left)
      })

      test('meets WCAG 2.2 AA before anything is started', async ({ page }) => {
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with the visitor\'s own incident form open and a text it refuses', async ({ page }) => {
        await page.getByTestId('own-details').locator('summary').click()
        await page.getByTestId('own-seed').fill('12x')
        await expect(page.getByTestId('own-seed')).toHaveAttribute('aria-invalid', 'true')
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA after a replay, with the postmortem and the timeline', async ({ page }) => {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
        await page.getByRole('radio', { name: language.badDeploy }).check()
        await page.getByTestId('replay-sample').click()
        await expect(page.getByTestId('incident-state')).toHaveAttribute('data-state', 'closed')
        await expect(page.getByTestId('postmortem-prose')).toBeVisible()
        await expect(page.getByTestId('scope-row').first()).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA while the fix waits for the visitor, with the charts failing', async ({ page }) => {
        await runToProposal(page, language.badDeploy)
        await expect(page.getByTestId('chart-cart')).toHaveAttribute('data-health', 'failing')
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with the tables of numbers open and the charts paused', async ({ page }) => {
        await runToProposal(page, language.badDeploy)
        await page.getByTestId('table-toggle').click()
        await expect(page.getByTestId('data-table')).toBeVisible()
        await page.getByTestId('pause').click()
        await expect(page.getByTestId('paused-note')).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA in the Brief reading', async ({ page }) => {
        await runToProposal(page, language.badDeploy)
        await page.getByRole('button', { name: language.brief, exact: true }).click()
        await expect(page.getByTestId('burn-table')).toHaveCount(0)
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA after the approval, with the shop recovered and the postmortem written', async ({ page }) => {
        await runToProposal(page, language.badDeploy)
        await page.getByTestId('approve').click()
        await expect(page.getByTestId('incident-state')).toHaveAttribute('data-state', 'closed', { timeout: 60_000 })
        await expect(page.getByTestId('postmortem-prose')).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA after an incident ended early', async ({ page }) => {
        await page.getByRole('radio', { name: language.badDeploy }).check()
        await page.getByTestId('live-sample').click()
        await expect(page.getByTestId('feed')).toBeVisible()
        await page.getByTestId('abort').click()
        await expect(page.getByTestId('incident-state')).toHaveAttribute('data-state', 'aborted')
        await expect(page.getByTestId('postmortem-none')).toBeVisible()
        await expectNoViolations(page)
      })
    })
  }
}
