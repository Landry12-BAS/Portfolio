// LB-02's accessibility in a real browser: axe finds no WCAG 2.2 AA violation in any state a visitor can
// reach (nothing started, the own-conversation panel, a conversation open and empty, a hold with its
// countdown, a booking with the recorded email and the tools, a handoff, a finished replay, an ended
// connection, the page with no connection), in both languages and both themes. They are registered by
// e2e/lb02.spec.ts.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

import { LB02_SAMPLES } from '../../shared/data/samples/lb02'
import { expect, test } from '../fixtures'
import { control, openBoard } from './support'

const ENGLISH = LB02_SAMPLES.find(sample => sample.id === 'book-cupping-en')
const CZECH = LB02_SAMPLES.find(sample => sample.id === 'book-tasting-cs')

const languages = [
  { code: 'en', prefix: '', counted: '10 of 10', own: 'Your own conversation', connected: 'Connected', turns: ENGLISH?.turns ?? [], person: 'Can I speak to a real person please?', replay: /Book a cupping/, ended: 'The connection closed after 15 minutes' },
  { code: 'cs', prefix: '/cs', counted: '10 z 10', own: 'Vlastní konverzace', connected: 'Připojeno', turns: CZECH?.turns ?? [], person: 'Potřebuji člověka, prosím.', replay: /Rezervace cuppingu/, ended: 'Spojení se zavřelo po 15 minutách' },
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

/** Writes a message in the field and sends it; waits for the concierge's reply to appear. */
async function say(page: Page, text: string): Promise<void> {
  const before = await page.getByTestId('line-concierge').count()
  await page.getByTestId('composer-field').fill(text)
  await page.getByTestId('composer-field').press('Enter')
  await expect(page.getByTestId('line-concierge')).toHaveCount(before + 1)
  await expect(page.getByTestId('working')).toHaveCount(0)
}

/** Registers the accessibility tests. */
export function accessibility(): void {
  for (const colorScheme of ['light', 'dark'] as const) {
    for (const language of languages) {
      test.describe(`the LB-02 board in ${language.code}, ${colorScheme} theme`, () => {
        test.beforeEach(async ({ page }) => {
          await page.emulateMedia({ colorScheme })
          await openBoard(page, `${language.prefix}/systems/lb-02/board`, language.counted)
          await expect(page.locator('html')).toHaveClass(themeClass[colorScheme])
        })

        /** Starts the visitor's own conversation. */
        const begin = async (page: Page): Promise<void> => {
          await page.getByRole('button', { name: language.own }).click()
          await page.getByTestId('begin').click()
          await expect(page.getByTestId('connection')).toHaveText(language.connected)
        }

        test('meets WCAG 2.2 AA before anything is started', async ({ page }) => {
          await expectNoViolations(page)
        })

        test('meets WCAG 2.2 AA with the own-conversation panel open', async ({ page }) => {
          await page.getByRole('button', { name: language.own }).click()
          await expect(page.getByTestId('begin')).toBeVisible()
          await expectNoViolations(page)
        })

        test('meets WCAG 2.2 AA with a conversation open and empty', async ({ page }) => {
          await begin(page)
          await expectNoViolations(page)
        })

        test('meets WCAG 2.2 AA with a hold counting down on the calendar', async ({ page }) => {
          await begin(page)
          await say(page, language.turns[0]?.say ?? '')
          await say(page, language.turns[1]?.say ?? '')
          await expect(page.getByTestId('hold-timer')).toBeVisible()
          await expect(page.locator('[data-testid="slots"] [data-state="held"]')).toHaveCount(1)
          await expectNoViolations(page)
        })

        test('meets WCAG 2.2 AA with a booking, the recorded email and the tools shown', async ({ page }) => {
          await begin(page)
          for (const turn of language.turns) await say(page, turn.say)
          await expect(page.getByTestId('booking-code')).toBeVisible()
          await expect(page.getByTestId('email-badge')).toBeVisible()
          await expect(page.getByTestId('tools').first()).toBeVisible()
          await expectNoViolations(page)
        })

        test('meets WCAG 2.2 AA with the conversation handed to a person', async ({ page }) => {
          await begin(page)
          await say(page, language.person)
          await expect(page.getByTestId('handoff')).toBeVisible()
          await expectNoViolations(page)
        })

        test('meets WCAG 2.2 AA after a replay, with the booking and the recorded email', async ({ page }) => {
          await page.getByRole('radio', { name: language.replay }).check()
          await page.getByTestId('start-sample').click()
          await expect(page.getByTestId('booking-code')).toBeVisible({ timeout: 15_000 })
          await expect(page.getByTestId('email-badge')).toBeVisible()
          await expectNoViolations(page)
        })

        test('meets WCAG 2.2 AA when the connection has ended and the conversation can be continued', async ({ page }) => {
          await begin(page)
          await control(page, 'drop', { code: 4408 })
          await expect(page.getByTestId('ended')).toBeVisible({ timeout: 20_000 })
          await expect(page.getByTestId('resume-ended')).toBeVisible()
          await expectNoViolations(page)
        })

        test('meets WCAG 2.2 AA with no connection', async ({ page, context, problems }) => {
          await context.setOffline(true)
          await expect(page.getByTestId('app-offline')).toBeVisible()
          await expectNoViolations(page)
          await context.setOffline(false)
          // The browser logs the calls that failed while there was no connection.
          problems.errors.length = 0
        })
      })
    }
  }
}
