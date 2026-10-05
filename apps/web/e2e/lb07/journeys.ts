// LB-07's journeys in a real browser, against the test build of the site and the mock back end: the replay of
// a recorded run, a curated run live from the queue to the report, the verdict, the test and the evidence (the
// screenshots through the site's own picture route), a run that re-plans, the visitor's own goal checked before
// it is sent and run with the bugs they switched on, the queue counting down, the busy browser, the day's two
// runs used in another tab, the failures and the refusals in their own words, the code view with its copy and
// download, the visitor's runs of the hour after a reload, stopping waiting, deleting a run, the Brief reading,
// the keyboard, and both languages. They are registered by e2e/lb07.spec.ts, which runs them one after another.
import { readFileSync } from 'node:fs'

import { expect, test } from '../fixtures'
import { choose, control, drawnWidth, ENGLISH, expectFinished, expectState, LANGUAGES, openBoard, overflowWidth, replay, runLive, runStarted, watchWrites } from './support'

// The address of a screenshot the site's own server answers as a picture.
const PICTURE = /^\/api\/lb07\/runs\/[\da-f-]{36}\/evidence\/e\d+\/image$/

/** Registers the journeys. */
export function journeys(): void {
  test.describe('replaying a recorded run', () => {
    for (const language of LANGUAGES) {
      test(`plays the recording as a replay in ${language.code}, with its re-plan and evidence, makes no request that changes anything and leaves the day's runs alone`, async ({ page }) => {
        const writes = watchWrites(page)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await openBoard(page, language)
        await expect(page.getByTestId('board-state')).toHaveText(language.live)

        await replay(page, 'cart-count')
        await expect(page.getByTestId('board-state')).toHaveText(language.replay)
        await expect(page.getByTestId('replay-banner')).toBeVisible()
        await expect(page.getByTestId('replaying-note')).toBeVisible()
        await expect(page.getByTestId('run-state')).toHaveText(language.done)
        await expect(page.getByTestId('plan')).toHaveCount(2)
        await expect(page.getByTestId('verdict')).toHaveText(language.kept)
        await expect(page.getByTestId('test-code')).toBeVisible()
        const picture = page.getByTestId('screenshot').first().locator('img')
        await expect(picture).toHaveAttribute('src', /^data:image\/png;base64,/)
        expect(await drawnWidth(picture)).toBeGreaterThan(0)
        await expect(page.getByTestId('stop-waiting')).toHaveCount(0)
        await expect(page.getByTestId('delete-run')).toHaveCount(0)
        await expect(page.getByTestId('scope-row').first()).toBeVisible()
        await expect(page.getByTestId('quota')).toContainText(language.full)
        expect(writes).toEqual([])
      })
    }

    test('offers a replay only for the runs that were recorded, and says so for the others', async ({ page }) => {
      await openBoard(page)
      await choose(page, 'clean-shop')
      await expect(page.getByTestId('no-recording')).toBeVisible()
      await expect(page.getByTestId('replay-sample')).toBeDisabled()
      await expect(page.getByTestId('live-sample')).toBeEnabled()
      await choose(page, 'coupon-double-discount')
      await expect(page.getByTestId('no-recording')).toHaveCount(0)
      await expect(page.getByTestId('replay-sample')).toBeEnabled()
    })
  })

  test.describe('a curated run live', () => {
    for (const language of LANGUAGES) {
      test(`runs a curated run live in ${language.code} to its report, its verdict, its test and its evidence`, async ({ page }) => {
        await openBoard(page, language)
        const pictureAnswer = page.waitForResponse(response => PICTURE.test(new URL(response.url()).pathname))
        await runLive(page, 'coupon-double-discount')
        await expect(page.getByTestId('stepper').locator('[aria-current="step"]')).toHaveCount(1)
        await expectFinished(page)

        await expect(page.getByTestId('run-state')).toHaveText(language.done)
        await expect(page.getByTestId('stepper').locator('[aria-current="step"]')).toHaveCount(0)
        await expect(page.getByTestId('model-calls')).toHaveText(/^2\D+8$/)
        await expect(page.getByTestId('replans')).toHaveText(/^0\D+2$/)
        await expect(page.getByTestId('quota')).toContainText(language.one)
        await expect(page.getByTestId('step').first()).toContainText(language.firstStep)
        await expect(page.getByTestId('finding').first()).toContainText('expected "Total €26.10"; the page says "Total Total €23.20"')
        await expect(page.getByTestId('report')).toHaveCount(1)
        await expect(page.getByTestId('report').locator('h3')).toHaveAttribute('lang', 'en')
        await expect(page.getByTestId('verdict')).toHaveText(language.kept)
        const results = await page.getByTestId('passes').locator('tbody tr').evaluateAll(rows => rows.map(row => row.getAttribute('data-result')))
        expect(results).toEqual(['red', 'red', 'green'])
        await expect(page.getByTestId('test-filename')).toHaveText(/\.spec\.ts$/)

        // The screenshot comes from the site's own route, as a checked PNG that is never cached.
        const picture = page.getByTestId('screenshot').first().locator('img')
        await expect(picture).toHaveAttribute('src', PICTURE)
        await expect(picture).toHaveAttribute('alt', /.+/)
        expect(await drawnWidth(picture)).toBeGreaterThan(0)
        const answer = await pictureAnswer
        expect(answer.status()).toBe(200)
        expect(answer.headers()['content-type']).toBe('image/png')
        expect(answer.headers()['x-content-type-options']).toBe('nosniff')
        expect(answer.headers()['cache-control']).toContain('no-store')

        // The page's tree at the end, as text in a fold-out, which never widens the page however long its lines.
        const tree = page.getByTestId('snapshot')
        await tree.locator('summary').click()
        await expect(tree.locator('pre')).toBeVisible()
        await expect(tree.locator('pre')).not.toBeEmpty()
        expect(await overflowWidth(page)).toBe(0)
        await expect(page.getByTestId('scope-row').first()).toBeVisible()
      })
    }

    test('fits a phone: a finished run with its tree open, its test and its table never widens the page', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await openBoard(page)
      await replay(page, 'cart-count')
      await page.getByTestId('snapshot').locator('summary').click()
      await expect(page.getByTestId('snapshot').locator('pre')).toBeVisible()
      await expect(page.getByTestId('test-code')).toBeVisible()
      expect(await overflowWidth(page)).toBe(0)
    })

    test('shows a re-plan as a plan of its own, introduced by the step whose failure asked for it', async ({ page }) => {
      await openBoard(page)
      await runLive(page, 'cart-count')
      await expectFinished(page)
      const plans = page.getByTestId('plan')
      await expect(plans).toHaveCount(2)
      await expect(plans.nth(1)).toContainText('Re-plan 1')
      await expect(page.getByTestId('replan-intro')).toHaveText('Step 2 failed, so the agent asked the model for new steps from there.')
      await expect(page.getByTestId('replans')).toHaveText('1 of 2')
      await expect(page.getByTestId('step').nth(1)).toContainText('nothing with that name on the page')
      await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'kept')
    })
  })

  test.describe('the visitor\'s own run', () => {
    test('checks the goal before it is sent, then runs it with the bugs the visitor switched on and shows both back as text', async ({ page }) => {
      await openBoard(page)
      await page.getByTestId('own-details').locator('summary').click()
      const goal = page.getByTestId('own-goal')
      await goal.fill('ab')
      await goal.blur()
      await expect(goal).toHaveAttribute('aria-invalid', 'true')
      await expect(page.getByTestId('goal-problem')).toHaveText('Write at least 3 characters.')
      await expect(page.getByTestId('own-submit')).toBeDisabled()
      await goal.fill('Buy a bag​ of Decaf Mexico.')
      await expect(page.getByTestId('goal-problem')).toHaveText('Use plain text only, with no control or formatting characters.')
      await expect(page.getByTestId('own-submit')).toBeDisabled()

      const text = 'Buy two bags of Brazil Cerrado and check the cart says 2 items <b>today</b>.'
      await goal.fill(text)
      await expect(goal).toHaveAttribute('aria-invalid', 'false')
      await expect(page.getByTestId('goal-count')).toHaveText(`${text.length} of 300 characters`)
      await page.getByTestId('bug-cart-off-by-one').locator('input').check()
      await page.getByTestId('bug-broken-image').locator('input').check()
      const sent = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/lb07/runs')
      await goal.press('Enter')
      expect((await sent).postDataJSON()).toEqual({ from: 'custom', goal: text, bugs: ['cart-off-by-one', 'broken-image'] })

      await expect(page.getByTestId('run-goal')).toHaveText(text)
      await expect(page.getByTestId('run-goal').locator('b')).toHaveCount(0)
      await expect(page.getByTestId('run-bugs').locator('li')).toHaveText(['The cart count is one too high', 'The front picture is missing'])
      await expectFinished(page)
      await expect(page.getByTestId('reading')).toContainText('add 2 bags')
      await expect(page.getByTestId('finding')).not.toHaveCount(0)
    })
  })

  test.describe('the queue, the busy browser and the day\'s runs', () => {
    test('says how many runs are ahead while the run waits for the one browser, counts down, then runs it in the shop only', async ({ page }) => {
      await openBoard(page)
      await control(page, 'occupy', { runs: 2, ms: 4_000 })
      await runLive(page, 'hostile-goal')
      await expectState(page, 'queued')
      await expect(page.getByTestId('queue')).toContainText(ENGLISH.queued)
      await expect(page.getByTestId('stepper').locator('[data-stage="queue"]')).toHaveAttribute('data-status', 'current')
      await expect(page.getByTestId('queue')).toContainText('1 run is ahead of yours.', { timeout: 15_000 })
      await expect(page.getByTestId('queue')).toHaveCount(0, { timeout: 15_000 })
      await expectFinished(page)
      // The goal told the agent to leave the shop; the plan it ran stayed in it.
      await expect(page.getByTestId('steps')).not.toContainText('169.254')
      await expect(page.getByTestId('steps')).not.toContainText('file:')
      await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'passing')
    })

    test('says the browser is busy when the queue is full, starts nothing and takes nothing, and keeps the replays open', async ({ page, problems }) => {
      await openBoard(page)
      await control(page, 'occupy', { runs: 4, ms: 60_000 })
      await choose(page, 'coupon-double-discount')
      await page.getByTestId('live-sample').click()
      const notice = page.getByTestId('own-notice')
      await expect(notice).toHaveAttribute('data-notice', 'busy')
      await expect(notice).toContainText('The browser is busy')
      await expect(page.getByTestId('run-panel')).toHaveCount(0)
      await expect(page.getByTestId('quota')).toContainText(ENGLISH.full)
      await expect(page.getByTestId('live-sample')).toBeEnabled()
      await expect(page.getByTestId('replay-sample')).toBeEnabled()
      expect(problems.errors.join(' ')).toContain('503')
      problems.errors.length = 0
    })

    test('says the day\'s two runs are used when another tab used them, and keeps the replays open', async ({ page, context, problems }) => {
      await openBoard(page)
      const other = await context.newPage()
      await openBoard(other)
      for (const sample of ['hostile-goal', 'clean-shop'] as const) {
        await runLive(other, sample)
        await other.getByTestId('stop-waiting').click()
        await expect(other.getByTestId('stopped-waiting')).toBeVisible()
      }
      await expect(other.getByTestId('quota')).toContainText(ENGLISH.none)
      await expect(other.getByTestId('allowance-used')).toBeVisible()
      await expect(other.getByTestId('live-sample')).toBeDisabled()
      await other.close()

      // This tab still counts two runs left, so it asks, and the service says no.
      await choose(page, 'coupon-double-discount')
      await page.getByTestId('live-sample').click()
      await expect(page.getByTestId('notice')).toHaveAttribute('data-kind', 'quota')
      await expect(page.getByTestId('notice')).toContainText('Today\'s allowance is used up')
      await expect(page.getByTestId('quota')).toContainText(ENGLISH.none)
      await expect(page.getByTestId('allowance-used')).toBeVisible()
      await expect(page.getByTestId('live-sample')).toBeDisabled()
      await expect(page.getByTestId('replay-sample')).toBeEnabled()
      expect(problems.errors.join(' ')).toContain('429')
      problems.errors.length = 0

      await page.reload()
      await expect(page.getByTestId('quota')).toContainText(ENGLISH.none)
      await expect(page.getByTestId('my-run')).toHaveCount(2)
    })
  })

  test.describe('failures and refusals', () => {
    test('says why a run failed, in its own words, and gives the day\'s run back when the system was at fault', async ({ page }) => {
      await openBoard(page)
      await control(page, 'fail', { code: 'planning_unavailable' })
      await runLive(page, 'coupon-double-discount')
      await expectState(page, 'failed')
      await expect(page.getByTestId('failure')).toHaveAttribute('data-code', 'planning_unavailable')
      await expect(page.getByTestId('failure-text')).toHaveText('The model could not be reached, or its free quota for today is spent.')
      await expect(page.getByTestId('failure-day')).toContainText('the run is given back')
      await expect(page.getByTestId('stepper').locator('[data-status="failed"]')).toHaveAttribute('data-stage', 'plan')
      await expect(page.getByTestId('verification')).toHaveCount(0)
      await expect(page.getByTestId('test')).toHaveCount(0)
      await expect(page.getByTestId('quota')).toContainText(ENGLISH.full)

      await control(page, 'fail', { code: 'run_timeout' })
      await runLive(page, 'coupon-double-discount')
      await expectState(page, 'failed')
      await expect(page.getByTestId('failure')).toHaveAttribute('data-code', 'run_timeout')
      await expect(page.getByTestId('failure-text')).toHaveText('The run used its three minutes of browser time and was stopped.')
      await expect(page.getByTestId('failure-day')).toHaveText('It still counts as one of your runs today.')
      await expect(page.locator('[data-testid="step"][data-status="passed"]').first()).toBeVisible()
      await expect(page.getByTestId('quota')).toContainText(ENGLISH.one)
    })

    test('shows a refused goal as a refusal, and a link out of the shop stopped at the sandbox as a step and a finding', async ({ page }) => {
      await openBoard(page)
      await control(page, 'fail', { code: 'goal_refused' })
      await page.getByTestId('own-details').locator('summary').click()
      await page.getByTestId('own-goal').fill('Check that the About page names the roastery.')
      const started = runStarted(page)
      await page.getByTestId('own-submit').click()
      await started
      await expectState(page, 'failed')
      await expect(page.getByTestId('failure')).toHaveAttribute('data-code', 'goal_refused')
      await expect(page.getByTestId('failure-text')).toHaveText('The goal was refused before anything ran.')
      await expect(page.getByTestId('failure-day')).toHaveText('It still counts as one of your runs today.')

      await runLive(page, 'partner-link')
      await expectState(page, 'done')
      const blocked = page.locator('[data-testid="step"][data-status="blocked"]')
      await expect(blocked).toHaveCount(1)
      await expect(blocked).toContainText('Stopped at the sandbox')
      await expect(page.locator('[data-testid="finding"][data-kind="blocked_navigation"]')).toContainText('was refused: the browser may reach only the staging shop')
      await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'not_verified')
    })
  })

  test.describe('the generated test', () => {
    test('shows the test in a code view that can be copied, downloaded and reached from the keyboard', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await openBoard(page)
      await replay(page, 'coupon-double-discount')
      const code = page.getByTestId('test-code')
      await expect(code).toHaveAttribute('aria-label', /^The generated test, \d+ lines$/)
      await expect(code.locator('a, img, script, iframe')).toHaveCount(0)
      await expect(page.getByTestId('never-runs')).toContainText('This service never runs it')

      await page.getByTestId('copy-test').click()
      await expect(page.getByTestId('copy-status')).toHaveText('Copied')
      await expect(page.getByTestId('copy-test')).toHaveText('Copied')
      const copied = await page.evaluate(() => navigator.clipboard.readText())
      expect(copied).toContain('import { expect, test } from \'@playwright/test\'')
      await expect(code.locator('.line')).toHaveCount(copied.replace(/\n$/, '').split('\n').length)

      const download = page.waitForEvent('download')
      await page.getByTestId('download-test').click()
      const file = await download
      expect(file.suggestedFilename()).toBe(await page.getByTestId('test-filename').innerText())
      expect(readFileSync(await file.path(), 'utf8')).toBe(copied)

      await page.getByTestId('copy-test').focus()
      await page.keyboard.press('Tab')
      await expect(page.getByTestId('download-test')).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(code).toBeFocused()
    })
  })

  test.describe('the visitor\'s runs of the hour', () => {
    test('lists a run left while it goes after a reload, follows it again to its end, and reads a finished one whole', async ({ page }) => {
      await openBoard(page)
      await runLive(page, 'hostile-goal')
      await page.reload()
      await expect(page.getByTestId('quota')).toContainText(ENGLISH.one)
      await expect(page.getByTestId('run-panel')).toHaveCount(0)
      await expect(page.getByTestId('my-run')).toHaveCount(1)
      await page.getByTestId('open-run').click()
      await expect(page.getByTestId('run-panel')).toBeVisible()
      await expectFinished(page)
      await expect(page.getByTestId('my-run')).toContainText('On the board')

      await page.reload()
      await expect(page.getByTestId('my-run')).toContainText('A goal that talks to the agent: Done')
      await page.getByTestId('open-run').click()
      await expectFinished(page)
      await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'passing')
    })

    test('stops waiting on request, says the run goes on and still counts, and opens it again from the list', async ({ page }) => {
      await openBoard(page)
      await runLive(page, 'clean-shop')
      await page.getByTestId('stop-waiting').click()
      await expect(page.getByTestId('stopped-waiting')).toBeVisible()
      await expect(page.getByTestId('run-panel')).toHaveCount(0)
      await expect(page.getByTestId('quota')).toContainText(ENGLISH.one)
      await page.getByTestId('open-run').click()
      await expect(page.getByTestId('stopped-waiting')).toHaveCount(0)
      await expectFinished(page)
      await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'passing')
    })

    test('deletes a finished run at once, takes it off the list, and does not give the run back', async ({ page }) => {
      await openBoard(page)
      await runLive(page, 'hostile-goal')
      await expectFinished(page)
      await expect(page.getByTestId('kept-until')).toBeVisible()
      await page.getByTestId('delete-run').click()
      await expect(page.getByTestId('run-panel')).toHaveCount(0)
      await expect(page.getByTestId('my-run')).toHaveCount(0)
      await expect(page.getByTestId('quota')).toContainText(ENGLISH.one)
    })
  })

  test.describe('the reading modes and the keyboard', () => {
    for (const language of LANGUAGES) {
      test(`takes the technical details out of the Brief reading in ${language.code}, keeps the demo, and puts them back`, async ({ page }) => {
        await openBoard(page, language)
        await runLive(page, 'pictures-have-alt-text')
        await expectFinished(page)
        await expect(page.getByTestId('snapshot')).toHaveCount(1)
        await expect(page.getByTestId('kept-until')).toBeVisible()
        await page.getByRole('button', { name: language.brief, exact: true }).click()
        await expect(page.getByTestId('snapshot')).toHaveCount(0)
        await expect(page.getByTestId('kept-until')).toHaveCount(0)
        await expect(page.getByTestId('verdict')).toBeVisible()
        await expect(page.getByTestId('test-code')).toBeVisible()
        await expect(page.getByTestId('screenshot').first()).toBeVisible()
        await page.getByRole('button', { name: language.technical, exact: true }).click()
        await expect(page.getByTestId('snapshot')).toHaveCount(1)
      })
    }

    test('runs a curated run and the visitor\'s own with the keyboard alone, and keeps the focus where the visitor put it', async ({ page }) => {
      await openBoard(page)
      const first = page.getByTestId('sample-coupon-double-discount').locator('input')
      await first.focus()
      await page.keyboard.press('ArrowDown')
      const second = page.getByTestId('sample-cart-count').locator('input')
      await expect(second).toBeChecked()
      await expect(second).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(page.getByTestId('replay-sample')).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(page.getByTestId('live-sample')).toBeFocused()
      const started = runStarted(page)
      await page.keyboard.press('Enter')
      await started
      // The board redraws as the run moves and re-plans; the focus stays on the button the visitor is on.
      await page.getByTestId('stop-waiting').focus()
      await expect(page.getByTestId('plan')).toHaveCount(2, { timeout: 30_000 })
      await expect(page.getByTestId('stop-waiting')).toBeFocused()
      await expectFinished(page)

      const summary = page.getByTestId('own-details').locator('summary')
      await summary.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('own-details')).toHaveAttribute('open', '')
      await page.keyboard.press('Tab')
      await expect(page.getByTestId('bug-coupon-twice').locator('input')).toBeFocused()
      await page.keyboard.press('Space')
      await expect(page.getByTestId('bug-coupon-twice').locator('input')).toBeChecked()
      await page.getByTestId('own-goal').focus()
      await page.keyboard.type('Buy two bags of Ethiopia Guji with the coupon WELCOME10 and check the total.')
      const own = runStarted(page)
      await page.keyboard.press('Enter')
      await own
      await expect(page.getByTestId('run-goal')).toHaveText('Buy two bags of Ethiopia Guji with the coupon WELCOME10 and check the total.')
      await expectState(page, 'done')
    })
  })
}
