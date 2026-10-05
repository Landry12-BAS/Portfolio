// End-to-end accessibility checks of LB-10's evaluation board: axe finds no WCAG 2.2 AA violation in any state a visitor
// can reach (the board on opening with a prepared edit that has no recording, the editor's own checks, the service's
// refusal listed beside it, a replay ended with both figures, the tables and every changed case open, the same in the
// Brief reading, a run going, a run failed and given back, the busy and daily-limit notices, and the nightly's stored
// results), in both languages and both themes. Every test also fails on a CSP violation or a console error
// (e2e/fixtures.ts).
//
// The live states are scripted in the test's own page (e2e/lb10/support.ts, scriptRun), so these checks never start a
// run on the mock and never meet the mock's controls, which e2e/lb10.spec.ts sets for its own runs one after another.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'
import { answerStartWith, changeReads, chooseSample, chooseTarget, expectReport, expectState, LANGUAGES, openBoard, promptOf, scriptedView, scriptRun, setPrompt } from './lb10/support'

// The class the theme script puts on <html>, matched as a whole word.
const themeClass = { light: /\blight\b/, dark: /\bdark\b/ } as const

// A report holds every case of the sample with both replies, so axe reads a large page, several times a test.
test.describe.configure({ timeout: 90_000 })

/** Checks the page with axe against WCAG 2.2 AA and names each violation by rule and element. */
async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()
  expect(results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([])
}

/** Replays a prepared edit's recording and waits for its report. */
async function replay(page: Page, sample: 'drafter-word-limit' | 'classifier-without-json'): Promise<void> {
  await chooseSample(page, sample)
  await page.getByTestId('replay-sample').click()
  await expectReport(page)
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const language of LANGUAGES) {
    test.describe(`LB-10's board in ${language.code}, ${colorScheme} theme`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
        await openBoard(page, language)
        await expect(page.locator('html')).toHaveClass(themeClass[colorScheme])
      })

      test('meets WCAG 2.2 AA on opening, with the editor\'s own checks, and with the service\'s refusal beside the editor', async ({ page, problems }) => {
        await chooseSample(page, 'generator-without-example')
        await expect(page.getByTestId('no-recording')).toBeVisible()
        await expectNoViolations(page)

        await chooseTarget(page, 'lb02-planner')
        await setPrompt(page, `${(await promptOf(page)).replace('{{language}}', 'English')} {{tomorrow}}`)
        await expect(page.getByTestId('prompt-checks')).toBeVisible()
        await expectNoViolations(page)

        await page.getByTestId('reset-prompt').click()
        await setPrompt(page, `${await promptOf(page)}\nOne more rule.`)
        await answerStartWith(page, 422, { error: { code: 'invalid_prompt', message: 'The prompt dropped a variable.' }, problems: [{ code: 'missing_variables', message: 'The prompt dropped a variable.' }, { code: 'brand_new_rule', message: 'A rule this page has never seen.' }] })
        await page.getByTestId('run-live').click()
        await expect(page.getByTestId('prompt-refused')).toBeVisible()
        await expectNoViolations(page)
        expect(problems.errors.join(' ')).toContain('422')
        problems.errors.length = 0
      })

      test('meets WCAG 2.2 AA after a replay, with both figures, the tables and every changed case, and in the Brief reading', async ({ page }) => {
        await replay(page, 'drafter-word-limit')
        await expect(page.getByTestId('changed-case').first()).toBeVisible()
        await expectNoViolations(page)

        await replay(page, 'classifier-without-json')
        await expect(page.getByTestId('reply-malformed').first()).toBeVisible()
        await page.getByTestId('changed-case').first().getByTestId('as-written').first().click()
        await expectNoViolations(page)

        await page.getByRole('button', { name: language.brief, exact: true }).click()
        await expect(page.getByTestId('all-cases')).toHaveCount(0)
        await expectNoViolations(page)
      })

      test('meets WCAG 2.2 AA while a run is going, once it has failed and been given back, and with the busy and daily-limit notices', async ({ page, problems }) => {
        const show = await scriptRun(page)
        await setPrompt(page, `${await promptOf(page)}\nScripted.`)
        await page.getByTestId('run-live').click()
        await expectState(page, 'running')
        await expect(page.getByTestId('stop-waiting')).toBeVisible()
        await expectNoViolations(page)

        show(scriptedView({ state: 'failed', failure: 'no_answers', calls_done: 0, finished_at: new Date().toISOString() }))
        await expectState(page, 'failed')
        await expect(page.getByTestId('refund')).toHaveAttribute('data-refund', 'given')
        await expectNoViolations(page)

        await answerStartWith(page, 503, { error: { code: 'lab_busy', message: 'The lab is running as many evals as it can; try again in a minute.' } })
        await page.getByTestId('run-live').click()
        await expect(page.getByTestId('own-notice')).toHaveAttribute('data-notice', 'lab_busy')
        await expectNoViolations(page)

        await answerStartWith(page, 429, { error: { code: 'daily_limit', message: 'You have started today\'s run.', resets_at: '2026-10-06T00:00:00+00:00' } })
        await page.getByTestId('run-live').click()
        await expect(page.getByTestId('own-notice')).toHaveAttribute('data-notice', 'daily_limit')
        await expect(page.getByTestId('allowance-used')).toBeVisible()
        await expectNoViolations(page)
        expect(problems.errors.join(' ')).toContain('503')
        expect(problems.errors.join(' ')).toContain('429')
        problems.errors.length = 0
      })

      test('meets WCAG 2.2 AA with the nightly\'s results, the judge\'s standing and the baselines', async ({ page }) => {
        await changeReads(page, '/api/lb10/nightly', () => ({
          results: [
            { run_on: '2026-10-04', kind: 'eval', pack: 'lb01-drafter', pack_version: '0123456789abcdef', alias: 'lb-eval-groq-120b', report: { provider: 'groq', score: { mean: 0.8, low: 0.55, high: 1, cases: 10 }, latency_p50_ms: 900, model_calls: 2, cached_calls: 8, failed_calls: 0 } },
            { run_on: '2026-10-04', kind: 'judge', pack: 'lb01-drafter', pack_version: '0123456789abcdef', alias: 'lb-eval-groq-120b', report: { counts: true, judged: 10, unreadable_verdicts: 0, judge_pass_rate: 0.8, judge_low: 0.5, judge_high: 1, rule_pass_rate: 0.8, agreement_with_rules: 0.9 } },
          ],
        }))
        await changeReads(page, '/api/lb10/baselines', () => ({ baselines: [{ pack: 'lb01-drafter', pack_version: '0123456789abcdef', alias: 'lb-eval-groq-120b', score: 0.8, low: 0.6, high: 1, cases: 20, measured_on: '2026-10-01', source: 'live' }] }))
        await openBoard(page, language)
        await expect(page.getByTestId('nightly-results')).toBeVisible()
        await expect(page.getByTestId('baseline-row')).toHaveCount(1)
        await expectNoViolations(page)
      })
    })
  }
}
