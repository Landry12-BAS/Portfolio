// LB-07's accessibility in a real browser: axe finds no WCAG 2.2 AA violation in any state a visitor can
// reach (nothing started with a run that has no recording chosen, the own-run form open with bugs switched on
// and a goal it refuses, a replay ended with its re-plan, findings, reports, verdict, test, evidence and the
// page's tree open, a live run waiting in the queue, running, done with its evidence and in the Brief reading,
// the busy notice, a failed run and the day's runs used), in both languages and both themes. They are
// registered by e2e/lb07.spec.ts.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

import { expect, test } from '../fixtures'
import { choose, control, expectFinished, expectState, holdRunAt, LANGUAGES, openBoard, replay, runLive } from './support'

// The class the theme script puts on <html>, matched as a whole word.
const themeClass = { light: /\blight\b/, dark: /\bdark\b/ } as const

/** Checks the page with axe against WCAG 2.2 AA and names each violation by rule and element. */
async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()
  expect(results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([])
}

/** Registers the accessibility checks. */
export function accessibility(): void {
  for (const colorScheme of ['light', 'dark'] as const) {
    for (const language of LANGUAGES) {
      test.describe(`LB-07's board in ${language.code}, ${colorScheme} theme`, () => {
        test.beforeEach(async ({ page }) => {
          await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
          await openBoard(page, language)
          await expect(page.locator('html')).toHaveClass(themeClass[colorScheme])
        })

        test('meets WCAG 2.2 AA before anything is started, and with the own-run form open, bugs on and a goal it refuses', async ({ page }) => {
          await choose(page, 'clean-shop')
          await expect(page.getByTestId('no-recording')).toBeVisible()
          await expectNoViolations(page)
          await page.getByTestId('own-details').locator('summary').click()
          await page.getByTestId('bug-coupon-twice').locator('input').check()
          await page.getByTestId('own-goal').fill('ab')
          await page.getByTestId('own-goal').blur()
          await expect(page.getByTestId('own-goal')).toHaveAttribute('aria-invalid', 'true')
          await expectNoViolations(page)
        })

        test('meets WCAG 2.2 AA after a replay, with the re-plan, the findings, the reports, the verdict, the test, the evidence and the page\'s tree open', async ({ page }) => {
          await replay(page, 'cart-count')
          await expect(page.getByTestId('screenshot').first()).toBeVisible()
          await page.getByTestId('snapshot').locator('summary').click()
          await expect(page.getByTestId('snapshot').locator('pre')).toBeVisible()
          await expectNoViolations(page)
        })

        // Each moment of a live run is its own test: held at one, the board shows the run there for as long as the
        // check takes, so the checks need not race a run that goes on beneath them (a slow machine once let it
        // finish while the queued page was still being scanned).
        test('meets WCAG 2.2 AA while a live run waits in the queue', async ({ page }) => {
          const letGo = await holdRunAt(page, 'queued')
          await control(page, 'occupy', { runs: 1, ms: 60_000 })
          await runLive(page, 'coupon-double-discount')
          await expectState(page, 'queued')
          await expect(page.getByTestId('queue')).toBeVisible()
          await expectNoViolations(page)
          await letGo()
        })

        test('meets WCAG 2.2 AA while a live run goes, once it is done and in the Brief reading', async ({ page }) => {
          const letGo = await holdRunAt(page, 'running')
          await runLive(page, 'coupon-double-discount')
          await expect(page.locator('[data-testid="step"][data-status="passed"]').first()).toBeVisible({ timeout: 30_000 })
          await expectState(page, 'running')
          await expectNoViolations(page)
          await letGo()

          await expectFinished(page)
          await page.getByTestId('snapshot').locator('summary').click()
          await expectNoViolations(page)
          await page.getByRole('button', { name: language.brief, exact: true }).click()
          await expect(page.getByTestId('snapshot')).toHaveCount(0)
          await expectNoViolations(page)
        })

        test('meets WCAG 2.2 AA with the busy notice, then with a failed run and the day\'s runs used', async ({ page, problems }) => {
          await control(page, 'occupy', { runs: 4, ms: 60_000 })
          await choose(page, 'coupon-double-discount')
          await page.getByTestId('live-sample').click()
          await expect(page.getByTestId('own-notice')).toHaveAttribute('data-notice', 'busy')
          await expectNoViolations(page)
          expect(problems.errors.join(' ')).toContain('503')
          problems.errors.length = 0

          await control(page, 'reset')
          for (const sample of ['coupon-double-discount', 'cart-count'] as const) {
            await control(page, 'fail', { code: 'run_timeout' })
            await runLive(page, sample)
            await expectState(page, 'failed')
          }
          await expect(page.getByTestId('failure')).toBeVisible()
          await expect(page.getByTestId('allowance-used')).toBeVisible()
          await expect(page.getByTestId('quota')).toContainText(language.none)
          await expectNoViolations(page)
        })
      })
    }
  }
}
