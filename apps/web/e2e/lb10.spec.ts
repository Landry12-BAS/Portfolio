// End-to-end journeys of LB-10's evaluation board, in a real browser against the test build of the site and the mock
// back end: a prepared edit's recording replayed in both languages with no request that could change anything; an edit
// run live and followed to its report, its trace in the Scope, and the prompt kept out of the address, the title and
// the browser's storage; a prepared edit on two providers whose replies are prose; an unchanged prompt run once; the
// checks as the visitor types; the service's own refusal listed beside the editor; the day's run used; a run that
// fails and is given back; a busy lab; a lab with no gateway; stopping waiting; a run of today opened again after a
// reload; the nightly's stored results; the Brief reading; the keyboard; Czech; and a phone's width. Every test also
// fails on a CSP or Trusted Types violation, a page error or a console error (e2e/fixtures.ts). The Turnstile check is
// the test build's stand-in.
//
// The mock's controls (the next run fails, some of its calls fail, the lab is full, stored nightly results) are one for
// every visitor, as the service's state is, so these tests run one after another and each starts from a mock with no
// run made (its reset control); no other file uses LB-10's controls or starts a run on the mock (e2e/lb10-a11y.spec.ts
// scripts its live states in its own page), and a lab with no gateway is this page's alone. Each test is a new
// visitor, with a day's run of their own.
import { expect, test } from './fixtures'
import { answerStartWith, changeReads, chooseSample, chooseTarget, control, ENGLISH, expectReport, expectState, LANGUAGES, openBoard, overflowWidth, promptOf, runEdit, setPrompt, watchWrites } from './lb10/support'

test.describe.configure({ mode: 'serial', timeout: 60_000 })

test.beforeEach(async ({ page }) => {
  await control(page, 'reset')
})

test.describe('replays', () => {
  for (const language of LANGUAGES) {
    test(`replay a prepared edit's recording in ${language.code}, labelled as the mock's, with no request that could change anything`, async ({ page }) => {
      await openBoard(page, language)
      const writes = watchWrites(page)
      await chooseSample(page, 'classifier-without-json')
      await page.getByTestId('replay-sample').click()
      await expect(page.getByTestId('replay-banner')).toBeVisible()
      await expect(page.getByTestId('board-state')).toContainText(language.replay)
      await expectReport(page)
      await expect(page.getByTestId('verdict')).toHaveCount(2)
      for (const verdict of await page.getByTestId('verdict').all()) await expect(verdict).toHaveAttribute('data-verdict', 'worse')
      await expect(page.getByTestId('changed-case').first().locator('[data-side="edited"] [data-testid="reply-malformed"]')).toBeVisible()
      expect(await promptOf(page)).toContain('Describe the ticket under these headings:')
      await expect(page.getByTestId('quota')).toContainText(language.left)
      expect(writes).toEqual([])
    })
  }

  test('say there is no recording of a prepared edit yet, and offer it live only', async ({ page }) => {
    await openBoard(page)
    await chooseSample(page, 'planner-records-later')
    await expect(page.getByTestId('no-recording')).toBeVisible()
    await expect(page.getByTestId('replay-sample')).toBeDisabled()
    await expect(page.getByTestId('live-sample')).toBeEnabled()
  })
})

test.describe('live runs', () => {
  test('run an edit live, follow it, read its report and its trace, and keep the prompt to the page', async ({ page }) => {
    await openBoard(page)
    const production = await promptOf(page)
    const secret = 'Keep the reply short, zebrapotato.'
    await setPrompt(page, `${production}\n${secret}`)
    await expect(page.getByTestId('prompt-changed')).toContainText('1 line added')
    await expect(page.getByTestId('run-cost')).toContainText('Up to 10 model calls for your prompt')
    expect(await runEdit(page)).toBe(202)
    await expect(page.getByTestId('run-panel')).toBeVisible()
    await expect(page.getByTestId('run-panel').getByRole('progressbar')).toHaveAttribute('aria-valuemax', '20')
    await expectReport(page)

    await expect(page.getByTestId('run-calls')).toHaveText('20 of 20')
    await expect(page.getByTestId('small-sample')).toContainText('Ten cases is a small sample')
    await expect(page.getByTestId('score-words')).toContainText('Groq, your prompt: 100% passed')
    await expect(page.getByTestId('report-row')).toHaveCount(2)
    await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'no_detectable_difference')
    const changed = page.getByTestId('changed-case')
    await expect(changed).toHaveCount(1)
    await expect(changed.getByTestId('reply')).toHaveCount(2)
    await expect(changed.locator('[data-side="edited"] ins').first()).toBeVisible()
    await expect(page.getByTestId('quota')).toContainText(ENGLISH.used)
    await expect(page.getByTestId('my-run')).toHaveCount(1)
    await expect(page.getByTestId('scope')).toContainText('eval run', { timeout: 15_000 })
    await expect(page.getByTestId('scope')).toContainText('read cache')

    expect(page.url()).not.toContain('zebrapotato')
    expect(await page.title()).not.toContain('zebrapotato')
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie)
    expect(stored).not.toContain('zebrapotato')
    await expect(page.getByTestId('scope')).not.toContainText('zebrapotato')
  })

  test('run a prepared edit on both providers: prose instead of JSON, never repaired, and worse on each', async ({ page }) => {
    await openBoard(page)
    await chooseSample(page, 'classifier-without-json')
    const started = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/lb10/runs'))
    await page.getByTestId('live-sample').click()
    expect((await started).status()).toBe(202)
    await expectReport(page)
    await expect(page.getByTestId('report-row')).toHaveCount(4)
    for (const verdict of await page.getByTestId('verdict').all()) await expect(verdict).toHaveAttribute('data-verdict', 'worse')
    const first = page.getByTestId('changed-case').first()
    await expect(first).toHaveAttribute('data-change', 'regressed')
    await expect(first.locator('[data-side="edited"] [data-testid="reply-malformed"]')).toContainText('it is never repaired')
    await expect(first.locator('[data-side="production"]')).toContainText('Shown re-indented')
  })

  test('run an unchanged prompt once, and say its report has nothing to compare', async ({ page }) => {
    await openBoard(page)
    await chooseTarget(page, 'lb05-sql-writer')
    await expect(page.getByTestId('prompt-unchanged')).toBeVisible()
    await expect(page.getByTestId('run-cost')).toContainText('Production\'s prompt alone: up to 10 model calls')
    expect(await runEdit(page)).toBe(202)
    await expectReport(page)
    await expect(page.getByTestId('run-calls')).toHaveText('10 of 10')
    await expect(page.getByTestId('unchanged-report')).toContainText(ENGLISH.unchangedReport)
    await expect(page.getByTestId('difference-figure')).toHaveCount(0)
  })

  test('stop waiting for a run, which goes on, and find it in the runs of today', async ({ page }) => {
    await openBoard(page)
    await setPrompt(page, `${await promptOf(page)}\nWait.`)
    expect(await runEdit(page)).toBe(202)
    await page.getByTestId('stop-waiting').click()
    await expect(page.getByTestId('stopped-waiting')).toBeVisible()
    await expect(page.getByTestId('run-panel')).toHaveCount(0)
    await expect(page.getByTestId('my-run')).toHaveCount(1)
    await expect(page.getByTestId('quota')).toContainText(ENGLISH.used)
  })

  test('open a run of today again after a reload: its report, and a note that the prompt was not kept', async ({ page }) => {
    await openBoard(page)
    await setPrompt(page, `${await promptOf(page)}\nAgain.`)
    expect(await runEdit(page)).toBe(202)
    await expectReport(page)
    await page.reload()
    await expect(page.getByTestId('quota')).toContainText(ENGLISH.used)
    await expect(page.getByTestId('run-panel')).toHaveCount(0)
    await page.getByTestId('my-run').getByTestId('open-run').click()
    await expectReport(page)
    await expect(page.getByTestId('reopened-note')).toBeVisible()
    await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'no_detectable_difference')
  })
})

test.describe('the prompt and the day\'s run', () => {
  test('check the prompt as it is typed, keep the run back until it can run, and put production\'s prompt back', async ({ page }) => {
    await openBoard(page)
    await chooseTarget(page, 'lb02-planner')
    const production = await promptOf(page)
    const writes = watchWrites(page)
    await setPrompt(page, `${production.replace('{{language}}', 'English')} {{tomorrow}}`)
    await expect(page.getByTestId('prompt-checks').locator('li')).toHaveCount(2)
    await expect(page.getByTestId('prompt-checks')).toContainText('Put back the variables the cases fill: {{language}}.')
    await expect(page.getByTestId('prompt-input')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByTestId('run-live')).toBeDisabled()
    await page.getByTestId('reset-prompt').click()
    expect(await promptOf(page)).toBe(production)
    await expect(page.getByTestId('prompt-checks')).toHaveCount(0)
    await expect(page.getByTestId('run-live')).toBeEnabled()
    expect(writes).toEqual([])
  })

  test('list the service\'s own refusal of a prompt beside the editor, not as a notice, until the prompt changes', async ({ page, problems }) => {
    await openBoard(page)
    await setPrompt(page, `${await promptOf(page)}\nOne more rule.`)
    await answerStartWith(page, 422, { error: { code: 'invalid_prompt', message: 'The prompt dropped a variable.' }, problems: [{ code: 'missing_variables', message: 'The prompt dropped a variable.' }, { code: 'brand_new_rule', message: 'A rule this page has never seen.' }] })
    expect(await runEdit(page)).toBe(422)
    const refused = page.getByTestId('prompt-refused')
    await expect(refused).toHaveAttribute('role', 'alert')
    await expect(refused.locator('li')).toHaveCount(2)
    await expect(refused).toContainText('A rule this page has never seen.')
    await expect(refused).toContainText('Nothing was counted')
    await expect(page.getByTestId('own-notice')).toHaveCount(0)
    await expect(page.getByTestId('quota')).toContainText(ENGLISH.left)
    await setPrompt(page, `${await promptOf(page)} Changed.`)
    await expect(refused).toHaveCount(0)
    // The browser logs the refusal it was sent; that one is expected.
    expect(problems.errors.join(' ')).toContain('422')
    problems.errors.length = 0
  })

  test('say the day\'s run is used once it ran, and keep the replays open', async ({ page }) => {
    await openBoard(page)
    await setPrompt(page, `${await promptOf(page)}\nOnce.`)
    expect(await runEdit(page)).toBe(202)
    await expectReport(page)
    await expect(page.getByTestId('allowance-used')).toBeVisible()
    await expect(page.getByTestId('run-live')).toBeDisabled()
    await chooseSample(page, 'drafter-word-limit')
    await expect(page.getByTestId('replay-sample')).toBeEnabled()
  })

  test('say a failed run in its own words, and that it was given back', async ({ page }) => {
    await openBoard(page)
    await control(page, 'fail', { code: 'no_answers' })
    await setPrompt(page, `${await promptOf(page)}\nFail.`)
    expect(await runEdit(page)).toBe(202)
    await expectState(page, 'failed')
    await expect(page.getByTestId('run-failure')).toHaveAttribute('data-failure', 'no_answers')
    await expect(page.getByTestId('run-failure')).toContainText('No model answered any call')
    await expect(page.getByTestId('refund')).toHaveAttribute('data-refund', 'given')
    await expect(page.getByTestId('quota')).toContainText(ENGLISH.left)
    await expect(page.getByTestId('report')).toHaveCount(0)
  })

  test('show a call that got no answer as a failed case naming the gateway\'s reason', async ({ page }) => {
    await openBoard(page)
    await control(page, 'fail-calls', { code: 'upstream_timeout', count: 2 })
    await setPrompt(page, `${await promptOf(page)}\nSlow provider.`)
    expect(await runEdit(page)).toBe(202)
    await expectReport(page)
    await expect(page.getByTestId('reply-no-answer').first()).toContainText('No answer: the provider took too long.')
  })

  test('say the lab is busy and that nothing was counted', async ({ page, problems }) => {
    await openBoard(page)
    await control(page, 'busy')
    await setPrompt(page, `${await promptOf(page)}\nBusy.`)
    expect(await runEdit(page)).toBe(503)
    await expect(page.getByTestId('own-notice')).toHaveAttribute('data-notice', 'lab_busy')
    await expect(page.getByTestId('own-notice')).toContainText('nothing was counted')
    await expect(page.getByTestId('quota')).toContainText(ENGLISH.left)
    await expect(page.getByTestId('run-live')).toBeEnabled()
    expect(problems.errors.join(' ')).toContain('503')
    problems.errors.length = 0
  })

  test('say when the lab has no gateway, and run nothing', async ({ page }) => {
    // The service says so in its list of prompts; the change is this page's alone, so no other test sees a lab without one.
    await changeReads(page, '/api/lb10/targets', body => ({ ...body, can_run: false }))
    await openBoard(page)
    await expect(page.getByTestId('no-gateway')).toBeVisible()
    await expect(page.getByTestId('run-live')).toBeDisabled()
    await expect(page.getByTestId('live-sample')).toBeDisabled()
    await chooseSample(page, 'drafter-word-limit')
    await expect(page.getByTestId('replay-sample')).toBeEnabled()
  })
})

test.describe('the nightly, the reading modes, the keyboard, Czech and a phone', () => {
  test('say plainly that nothing is measured yet, and show the nightly\'s results and the baselines once stored', async ({ page }) => {
    await openBoard(page)
    await expect(page.getByTestId('no-nightly')).toContainText('it has not been run live')
    await expect(page.getByTestId('no-baselines')).toContainText('No baseline is committed until one is measured on a live run')
    await control(page, 'nightly', {
      results: [
        { run_on: '2026-10-04', kind: 'eval', pack: 'lb01-drafter', pack_version: '0123456789abcdef', alias: 'lb-eval-groq-120b', report: { provider: 'groq', score: { mean: 0.8, low: 0.55, high: 1, cases: 10 }, latency_p50_ms: 900, model_calls: 2, cached_calls: 8, failed_calls: 0 } },
        { run_on: '2026-10-04', kind: 'judge', pack: 'lb01-drafter', pack_version: '0123456789abcdef', alias: 'lb-eval-groq-120b', report: { counts: false, judged: 10, unreadable_verdicts: 0, judge_pass_rate: 0.7, judge_low: 0.4, judge_high: 0.9, rule_pass_rate: 0.8, agreement_with_rules: 0.9 } },
      ],
    })
    await control(page, 'baselines', { baselines: [{ pack: 'lb01-drafter', pack_version: '0123456789abcdef', alias: 'lb-eval-groq-120b', score: 0.8, low: 0.6, high: 1, cases: 20, measured_on: '2026-10-01', source: 'live' }] })
    await openBoard(page)
    await expect(page.getByTestId('nightly-results')).toContainText('LB-01 reply drafter')
    await expect(page.getByTestId('judge-row')).toHaveAttribute('data-counts', 'false')
    await expect(page.getByTestId('baseline-row')).toHaveCount(1)
  })

  for (const language of LANGUAGES) {
    test(`take the technical details out of the Brief reading in ${language.code}, keep the report, and put them back`, async ({ page }) => {
      await openBoard(page, language)
      await chooseSample(page, 'drafter-word-limit')
      await page.getByTestId('replay-sample').click()
      await expectReport(page)
      await expect(page.getByTestId('all-cases')).toBeVisible()
      await page.getByRole('button', { name: language.brief, exact: true }).click()
      await expect(page.getByTestId('all-cases')).toHaveCount(0)
      await expect(page.getByTestId('report-pack')).toHaveCount(0)
      await expect(page.getByTestId('verdict')).toBeVisible()
      await expect(page.getByTestId('changed-case').first()).toBeVisible()
      await page.getByRole('button', { name: language.technical, exact: true }).click()
      await expect(page.getByTestId('all-cases')).toBeVisible()
    })
  }

  test('reach every part with the keyboard: the prompts by arrows, the editor left by Tab, and a run started by Enter', async ({ page }) => {
    await openBoard(page)
    const drafter = page.getByTestId('target-lb01-drafter').locator('input')
    await drafter.focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('target-lb02-planner').locator('input')).toBeChecked()
    await expect(page.getByTestId('target-details')).toHaveAttribute('data-pack', 'lb02-planner')
    const editor = page.getByTestId('prompt-input')
    await editor.focus()
    await page.keyboard.press('End')
    await page.keyboard.type(' Be brief.')
    await expect(page.getByTestId('prompt-changed')).toBeVisible()
    // Tab leaves the editor, as in any text field, and inserts nothing.
    const before = await promptOf(page)
    await page.keyboard.press('Tab')
    await expect(editor).not.toBeFocused()
    expect(await promptOf(page)).toBe(before)
    await page.keyboard.press('Shift+Tab')
    await expect(editor).toBeFocused()
    await page.getByTestId('run-live').focus()
    const started = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/lb10/runs'))
    await page.keyboard.press('Enter')
    expect((await started).status()).toBe(202)
    await expectReport(page)
  })

  test('say all of it in Czech: the prompts, the editor, the run and the report', async ({ page }) => {
    const czech = LANGUAGES[1]
    await openBoard(page, czech)
    // Czech groups digits with a no-break space, and vlna binds the one-letter word to the number after it.
    await expect(page.getByTestId('prompt-count')).toHaveText(/^1\s563 z\s8\s000 znaků$/)
    await setPrompt(page, `${await promptOf(page)}\nKrátce.`)
    await expect(page.getByTestId('prompt-changed')).toContainText('1 řádek přidán')
    expect(await runEdit(page)).toBe(202)
    await expectReport(page)
    await expect(page.getByTestId('run-state')).toContainText(czech.done)
    await expect(page.getByTestId('small-sample')).toContainText('Deset případů je malý vzorek')
    await expect(page.getByTestId('verdict')).toContainText(czech.noDifference)
    await expect(page.getByTestId('report')).not.toContainText('Production\'s prompt')
  })

  test('fit a phone\'s width with the report open, the replies side by side turned into one column', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openBoard(page)
    expect(await overflowWidth(page)).toBe(0)
    await chooseSample(page, 'classifier-without-json')
    await page.getByTestId('replay-sample').click()
    await expectReport(page)
    expect(await overflowWidth(page)).toBe(0)
    const replies = page.getByTestId('changed-case').first().getByTestId('reply')
    const production = await replies.nth(0).boundingBox()
    const edited = await replies.nth(1).boundingBox()
    expect(edited && production && edited.y > production.y).toBe(true)
  })
})
