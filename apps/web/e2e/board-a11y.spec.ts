// End-to-end accessibility checks of the evaluation board and the trace page: axe finds no WCAG 2.2
// AA violation in any state a visitor can reach (nothing run yet, a replay finished, a live run
// waiting for its trace, a live run finished with its draft and an open editor, a trace page, a
// notice), in both languages and both themes. Every test also fails on a CSP violation or a console
// error (e2e/fixtures.ts).
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

const languages = [
  { code: 'en', prefix: '', counted: '20 of 20', ownTicket: 'Your own ticket', body: 'What the customer writes', sample: /Torn bag/, waiting: 'Waiting for approval', edit: 'Edit', scopeWaiting: 'Waiting for the trace' },
  { code: 'cs', prefix: '/cs', counted: '20 z 20', ownTicket: 'Vlastní požadavek', body: 'Co zákazník píše', sample: /Roztržený sáček/, waiting: 'Čeká na schválení', edit: 'Upravit', scopeWaiting: 'Čekám na záznam' },
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
        await page.goto(`${language.prefix}/systems/lb-01/board`)
        await expect(page.locator('html')).toHaveClass(themeClass[colorScheme])
        await expect(page.getByTestId('quota')).toContainText(language.counted)
      })

      test('meets WCAG 2.2 AA before anything is run', async ({ page }) => {
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with the visitor\'s own ticket form open', async ({ page }) => {
        await page.getByRole('button', { name: language.ownTicket }).click()
        await expect(page.getByLabel(language.body)).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA after a replay, with the draft, its sources and the trace', async ({ page }) => {
        await page.getByRole('radio', { name: language.sample }).check()
        await page.getByTestId('start-sample').click()
        await expect(page.getByTestId('ticket-status')).toHaveText(language.waiting, { timeout: 15_000 })
        await expect(page.getByTestId('scope-row').first()).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA after a live run, with a flagged claim and the editor open', async ({ page }) => {
        await page.getByRole('button', { name: language.ownTicket }).click()
        await page.getByLabel(language.body).fill('My order BB-1040 arrived with a torn bag and I want a refund.')
        await page.getByTestId('file-ticket').click()
        await expect(page.getByTestId('ticket-status')).toHaveText(language.waiting, { timeout: 20_000 })
        await expect(page.locator('[data-testid="draft-sentence"][data-supported="false"]')).toHaveCount(1)
        await page.getByRole('button', { name: language.edit }).click()
        await expect(page.locator('#lb01-edit')).toBeVisible()
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA while a live run waits for its trace', async ({ page }) => {
        // Hold back the answers about the ticket, so the run stays in the state under test long enough to scan.
        await page.route('**/api/lb01/tickets/*', async (route) => {
          if (route.request().method() !== 'GET') return route.continue()
          await new Promise(resolve => setTimeout(resolve, 4_000))
          return route.continue().catch(() => undefined)
        })
        await page.getByRole('button', { name: language.ownTicket }).click()
        await page.getByLabel(language.body).fill('My order BB-1040 arrived with a torn bag.')
        await page.getByTestId('file-ticket').click()
        await expect(page.getByTestId('steps-pending')).toBeVisible()
        await expect(page.getByTestId('scope')).toContainText(language.scopeWaiting)
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA with a notice shown', async ({ page, problems }) => {
        await page.route('**/api/lb01/tickets', async (route) => {
          if (route.request().method() !== 'POST') return route.continue()
          return route.fulfill({ status: 429, json: { error: { code: 'daily_limit', message: 'x', resets_at: '2026-10-03T00:00:00Z' } } })
        })
        await page.getByRole('button', { name: language.ownTicket }).click()
        await page.getByLabel(language.body).fill('Hello')
        await page.getByTestId('file-ticket').click()
        await expect(page.getByTestId('notice')).toBeVisible()
        problems.errors.length = 0
        await expectNoViolations(page)
      })
    })

    test(`the trace page meets WCAG 2.2 AA in ${language.code}, ${colorScheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme })
      await page.goto(`${language.prefix}/runs/run-doesnotexist0000`)
      await expect(page.locator('html')).toHaveClass(themeClass[colorScheme])
      await expect(page.getByTestId('scope')).toContainText(language.code === 'en' ? 'There is no trace for this run' : 'není žádný záznam')
      await expectNoViolations(page)
    })
  }
}

test('a live run\'s own trace page meets WCAG 2.2 AA with every span shown', async ({ page }) => {
  await page.goto('/systems/lb-01/board')
  await expect(page.getByTestId('quota')).toContainText('20 of 20')
  await page.getByRole('button', { name: 'Your own ticket' }).click()
  await page.getByLabel('What the customer writes').fill('Order BB-1040 arrived with a torn bag.')
  await page.getByTestId('file-ticket').click()
  await expect(page.getByTestId('ticket-status')).toHaveText('Waiting for approval', { timeout: 20_000 })
  await page.getByRole('link', { name: 'Open this trace on its own page' }).click()
  await expect(page.getByTestId('scope-row')).toHaveCount(20)
  await expectNoViolations(page)
})
