// End-to-end journeys of LB-08's evaluation board, in a real browser against the test build of the
// site and the mock back end: the replay of a recorded sample, opening a sample live, editing the
// workflow on the canvas and in the outline with every edit checked, running it with a test order,
// making a step fail and reading the retries, the dead letter and the replay, answering an approval,
// describing a process in the visitor's own words, the day's limit, both languages and the keyboard.
// Every test also fails on a CSP or Trusted Types violation, a page error or a console error
// (e2e/fixtures.ts). The Turnstile check is the test build's stand-in; the real widget needs
// Cloudflare and is covered by component tests only.
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

/** What differs between the two languages in these journeys. */
const languages = [
  { code: 'en', prefix: '', counted: '10 of 10', live: 'Live', replay: 'Replay', outline: 'Outline', canvas: 'Canvas', ownTab: 'Your own description', samples: { wholesale: /^Wholesale order over €500 EN/, lowStock: /^Low stock reorder/, refund: /^Refund approval/, czech: /in Czech/ } },
  { code: 'cs', prefix: '/cs', counted: '10 z 10', live: 'Živě', replay: 'Přehrání', outline: 'Osnova', canvas: 'Plátno', ownTab: 'Váš vlastní popis', samples: { wholesale: /^Velkoobchodní objednávka nad 500 € EN/, lowStock: /^Doobjednání při nízkém skladu/, refund: /^Schválení vrácení peněz/, czech: /česky/ } },
] as const

/** Opens the board and waits until it has read the session and counted the day's runs. */
async function openBoard(page: Page, prefix = '', counted = '10 of 10'): Promise<void> {
  await page.goto(`${prefix}/systems/lb-08/board`)
  await expect(page.getByTestId('quota')).toContainText(counted)
}

/** Records the requests that could change something, so a test can say that none was made. */
function watchWrites(page: Page): string[] {
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
  })
  return writes
}

/** Opens a sample as a live workflow of the visitor's and waits for the editor. */
async function openLive(page: Page, sample: RegExp): Promise<void> {
  await page.getByRole('radio', { name: sample }).check()
  await page.getByTestId('open-sample-live').click()
  await expect(page.getByTestId('editor')).toBeVisible()
  await expect(page.getByTestId('canvas-step').first()).toBeVisible()
}

/** Waits for the run on the board to end in a status. */
async function expectRunStatus(page: Page, status: 'succeeded' | 'failed' | 'awaiting_approval', timeout = 20_000): Promise<void> {
  await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', status, { timeout })
}

/** Switches the editor to the outline or the canvas. */
async function showView(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click()
}

test.describe('replaying a recorded sample', () => {
  for (const language of languages) {
    test(`plays the recording as a replay, in ${language.code}: no request makes a change and nothing is spent`, async ({ page }) => {
      const writes = watchWrites(page)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await openBoard(page, language.prefix, language.counted)
      await expect(page.getByTestId('board-state')).toHaveText(language.live)
      await expect(page.locator('.state[data-recording="yes"]')).toHaveCount(3)
      await expect(page.locator('.state[data-recording="no"]')).toHaveCount(1)

      await page.getByRole('radio', { name: language.samples.lowStock }).check()
      await page.getByTestId('start-sample').click()

      await expect(page.getByTestId('board-state')).toHaveText(language.replay)
      await expect(page.getByTestId('replay-banner')).toBeVisible()
      await expect(page.getByTestId('read-only')).toBeVisible()
      await expect(page.getByTestId('dead-letter')).toHaveCount(1)
      await expect(page.getByTestId('sent-summary')).toBeVisible()
      await expect(page.locator('[data-testid="log-event"][data-type="effect.duplicate_suppressed"]')).toHaveCount(1)
      await expect(page.getByTestId('scope-row').first()).toBeVisible()
      await expect(page.getByTestId('quota')).toContainText(language.counted)
      await expect(page.getByTestId('run')).toBeDisabled()
      await expect(page.getByTestId('approve')).toHaveCount(0)
      expect(writes).toEqual([])
    })
  }

  test('paces the recorded run when motion is allowed, and ends with the replay of the dead letter succeeding', async ({ page }) => {
    await openBoard(page)
    await page.getByRole('radio', { name: languages[0].samples.lowStock }).check()
    await page.getByTestId('start-sample').click()

    await expect(page.getByTestId('dead-letter').first()).toBeVisible({ timeout: 20_000 })
    await expectRunStatus(page, 'succeeded', 30_000)
    await expect(page.getByTestId('dead-replayed')).toHaveCount(1)
    await expect(page.getByTestId('sent-summary')).toContainText('Each thing was sent once.')
  })

  test('shows a recorded approval as waiting with nobody to answer, then answered', async ({ page }) => {
    await openBoard(page)
    await page.getByRole('radio', { name: languages[0].samples.refund }).check()
    await page.getByTestId('start-sample').click()

    await expect(page.getByTestId('approval')).toContainText('This is a replay, so there is nothing to answer.', { timeout: 15_000 })
    await expect(page.getByTestId('approve')).toHaveCount(0)
    await expectRunStatus(page, 'succeeded', 30_000)
    await expect(page.locator('[data-testid="run-step"][data-step="finance_ok"]')).toHaveAttribute('data-status', 'succeeded')
  })

  test('can be played again, and the sample can be opened live instead', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openBoard(page)
    await page.getByTestId('start-sample').click()
    await expect(page.getByTestId('replay-banner')).toBeVisible()
    await expectRunStatus(page, 'succeeded')

    await page.getByRole('button', { name: 'Replay again' }).click()
    await expectRunStatus(page, 'succeeded')

    await page.getByRole('button', { name: 'Run it live' }).click()
    await expect(page.getByTestId('board-state')).toHaveText('Live')
    await expect(page.getByTestId('replay-banner')).toHaveCount(0)
    await expect(page.getByTestId('canvas-step').first()).toBeVisible()
    await expect(page.getByTestId('run')).toBeEnabled()
  })

  for (const language of languages) {
    test(`says a sample without a recording has none, and offers to open it live, in ${language.code}`, async ({ page }) => {
      await openBoard(page, language.prefix, language.counted)
      await page.getByRole('radio', { name: language.samples.czech }).check()

      await expect(page.getByTestId('no-recording')).toBeVisible()
      await page.getByTestId('start-sample').click()
      await expect(page.getByTestId('board-state')).toHaveText(language.live)
      await expect(page.getByTestId('editor')).toBeVisible()
      await expect(page.getByTestId('canvas-step').first()).toBeVisible()
    })
  }
})

test.describe('editing a workflow', () => {
  test('draws the workflow on the canvas and says whether it is valid', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.wholesale)

    await expect(page.getByTestId('canvas-step')).toHaveCount(5)
    await expect(page.locator('.vue-flow__edge')).toHaveCount(4)
    await expect(page.getByTestId('validity')).toContainText('Valid. Steps: 5. Connections: 4.')
    await expect(page.getByTestId('saved-state')).toContainText('Saved')
    await expect(page.getByTestId('save')).toBeDisabled()
    await expect(page.getByTestId('run')).toBeEnabled()
  })

  test('moves a step by dragging it, which is an edit that can be saved as the next version', async ({ page }) => {
    // No smooth scrolling under the pointer: the step is measured where it will stay.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openBoard(page)
    await openLive(page, languages[0].samples.wholesale)
    const step = page.locator('.vue-flow__node[data-id="check_stock"]')
    await step.scrollIntoViewIfNeeded()
    const box = await step.boundingBox()
    if (!box) throw new Error('the step has no box')

    await page.mouse.move(box.x + box.width / 2, box.y + 14)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + 14 + 60, { steps: 8 })
    await page.mouse.up()

    await expect(page.getByTestId('saved-state')).toContainText('Changes not saved')
    await expect(page.getByTestId('save')).toBeEnabled()
    await page.getByTestId('save').click()
    await expect(page.getByTestId('saved-state')).toContainText('Saved')
    await expect(page.getByTestId('version')).toHaveCount(2)
    await expect(page.getByTestId('said')).toContainText('Saved as version 2.')
  })

  test('picks a step on the canvas and edits its form, which is checked again at once', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.wholesale)

    await page.locator('.vue-flow__node[data-id="alert_roastery"]').click()
    const inspector = page.getByTestId('inspector')
    await expect(inspector).toContainText('Step: Alert the roastery')
    await expect(inspector).toContainText('Slack alert')

    await inspector.getByLabel('Name of the step').fill('Warn the roastery')
    await expect(page.locator('.vue-flow__node[data-id="alert_roastery"]')).toContainText('Warn the roastery')
    await expect(page.getByTestId('saved-state')).toContainText('Changes not saved')
    await expect(page.getByTestId('validity')).toContainText('Valid.')
  })

  test('refuses a workflow with a problem: the reason is at the step, in the list, and nothing can be saved or run', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.wholesale)
    await showView(page, 'Outline')

    // Taking the condition away leaves the steps after it with nothing leading to them.
    await page.locator('[data-testid="outline-step"][data-step="big_order"] [data-testid="outline-remove"]').click()

    await expect(page.getByTestId('validity')).toContainText('Problems:')
    await expect(page.locator('[data-testid="issue"][data-code="unreachable_node"]').first()).toBeVisible()
    await expect(page.locator('[data-testid="outline-step"][data-step="check_stock"] [data-testid="step-problem"]')).toContainText('cannot be reached from the trigger')
    await expect(page.getByTestId('save')).toBeDisabled()
    await expect(page.getByTestId('run')).toBeDisabled()
    await expect(page.getByTestId('run-blocked')).toContainText('Fix the problems in the workflow first.')
    await expect(page.getByTestId('save-hint')).toContainText('Fix the problems first.')

    await showView(page, 'Canvas')
    await expect(page.getByTestId('canvas-reason').first()).toContainText('cannot be reached')

    await page.getByTestId('undo').click()
    await expect(page.getByTestId('validity')).toContainText('Valid.')
    await expect(page.getByTestId('run')).toBeEnabled()
  })

  test('shows the reason on a connection the validator refuses, and removing it fixes the workflow', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.wholesale)
    await showView(page, 'Outline')

    // Leading back into the trigger is never allowed.
    const alert = page.locator('[data-testid="outline-step"][data-step="alert_roastery"]')
    await alert.getByRole('combobox', { name: /Connect Alert the roastery to/ }).selectOption({ label: '1. Wholesale order arrives' })
    await alert.getByTestId('outline-connect').click()

    await expect(page.locator('[data-testid="issue"][data-code="trigger_has_input"]')).toBeVisible()
    await expect(alert.getByTestId('edge-problem').filter({ hasText: 'leads into the trigger' })).toHaveCount(1)
    await expect(page.getByTestId('save')).toBeDisabled()
    await showView(page, 'Canvas')
    await expect(page.getByTestId('canvas-edge-label').filter({ hasText: 'leads into the trigger' })).toHaveCount(1)

    await showView(page, 'Outline')
    await alert.getByTestId('outline-cut').click()
    await expect(page.getByTestId('validity')).toContainText('Valid.')
  })

  test('adds a step, connects it, removes a connection and takes it all back', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.wholesale)
    await showView(page, 'Outline')

    await page.getByRole('combobox', { name: 'Add a step' }).selectOption('webhook')
    await page.getByTestId('add-step').click()
    await expect(page.getByTestId('outline-step')).toHaveCount(6)
    await expect(page.getByTestId('validity')).toContainText('Problems: 1')
    await expect(page.getByTestId('inspector')).toContainText('Webhook call')

    const stock = page.locator('[data-testid="outline-step"][data-step="check_stock"]')
    await stock.getByRole('combobox', { name: /Connect Check stock to/ }).selectOption('webhook')
    await stock.getByTestId('outline-connect').click()
    await expect(page.getByTestId('validity')).toContainText('Valid. Steps: 6. Connections: 5.')

    await page.getByTestId('undo').click()
    await expect(page.getByTestId('validity')).toContainText('Problems: 1')
    await page.getByTestId('discard').click()
    await expect(page.getByTestId('outline-step')).toHaveCount(5)
    await expect(page.getByTestId('saved-state')).toContainText('Saved')
  })

  test('saves each edit as a new version, listed with who made it, and keeps the workflow for the day', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.wholesale)
    await expect(page.getByTestId('version')).toHaveCount(1)
    await expect(page.getByTestId('versions')).toContainText('A hand-written sample')

    await showView(page, 'Outline')
    await page.getByTestId('outline-step').first().getByTestId('outline-edit').click()
    await page.getByTestId('inspector').getByLabel('Name of the step').fill('A different trigger name')
    await page.getByTestId('save').click()
    await expect(page.getByTestId('version')).toHaveCount(2)
    await expect(page.getByTestId('versions')).toContainText('You, by editing')

    await expect(page.getByTestId('my-workflow')).toHaveCount(1)
    await page.reload()
    await expect(page.getByTestId('quota')).toContainText('10 of 10')
    await expect(page.getByTestId('my-workflow')).toHaveCount(1)
    await page.getByRole('button', { name: /Open the workflow/ }).click()
    await expect(page.getByTestId('editor')).toBeVisible()
    await expect(page.getByTestId('version')).toHaveCount(2)
  })

  test('deletes a workflow of the visitor\'s', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.wholesale)
    await expect(page.getByTestId('my-workflow')).toHaveCount(1)

    await page.getByRole('button', { name: /Delete the workflow/ }).click()

    await expect(page.getByTestId('my-workflow')).toHaveCount(0)
    await expect(page.getByTestId('editor')).toHaveCount(0)
  })
})

test.describe('running a workflow', () => {
  test('runs the sample with its test order, step by step, and logs every event', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.wholesale)
    await expect(page.getByTestId('order')).toContainText('For the event: A wholesale order arrives')
    await expect(page.getByLabel('Order number')).toHaveValue('WO-2041')

    await page.getByTestId('run').click()

    await expectRunStatus(page, 'succeeded')
    await expect(page.locator('[data-testid="run-step"][data-status="succeeded"]')).toHaveCount(5)
    await expect(page.getByTestId('quota')).toContainText('9 of 10')
    await expect(page.getByTestId('sent-summary')).toContainText('Each thing was sent once.')
    await expect(page.getByTestId('sent-row')).toHaveCount(2)
    await expect(page.locator('[data-testid="log-event"][data-type="run.succeeded"]')).toHaveCount(1)
    await expect(page.getByTestId('scope-row').first()).toBeVisible()
    await expect(page.getByTestId('run-announce')).toContainText('The run succeeded.')
    // The canvas shows what each step did.
    await expect(page.getByTestId('canvas-badge').first()).toBeVisible()
  })

  test('checks the test order with the service\'s own rules and says which field is wrong', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.wholesale)

    await page.getByLabel('Total in euros').fill('lots')
    await expect(page.getByTestId('order-problem')).toContainText('Enter a number.')
    await expect(page.getByTestId('run')).toBeDisabled()
    await expect(page.getByTestId('run-blocked')).toContainText('Fix the test order first.')

    await page.getByRole('button', { name: 'Use the examples again' }).click()
    await expect(page.getByTestId('order-problem')).toHaveCount(0)
    await expect(page.getByTestId('run')).toBeEnabled()
  })

  test('saves a draft with changes before running it, and runs the version it saved', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.wholesale)
    await showView(page, 'Outline')
    await page.getByTestId('outline-step').first().getByTestId('outline-edit').click()
    await page.getByTestId('inspector').getByLabel('Name of the step').fill('Order arrives')

    await expect(page.getByTestId('run')).toHaveText('Save and run')
    await page.getByTestId('run').click()

    await expectRunStatus(page, 'succeeded')
    await expect(page.getByTestId('run-progress')).toContainText('Run of version 2')
    await expect(page.getByTestId('version')).toHaveCount(2)
  })

  test('retries a failing step with a growing wait, shows the countdown, and the step then works', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.lowStock)
    await page.locator('[data-testid="failure"][data-step="tell_purchasing"] select').selectOption('2')
    await expect(page.locator('[data-testid="failure"][data-step="tell_purchasing"]')).toContainText('It will be retried and then work.')

    await page.getByTestId('run').click()

    await expect(page.getByTestId('retry-countdown').first()).toContainText(/Next attempt in [12] s|Trying again now/, { timeout: 15_000 })
    await expectRunStatus(page, 'succeeded', 30_000)
    await expect(page.locator('[data-testid="run-step"][data-step="tell_purchasing"]')).toContainText('3 of 3')
    await expect(page.getByTestId('dead-letter')).toHaveCount(0)
    await expect(page.locator('[data-testid="log-event"][data-type="step.failed"]')).toHaveCount(2)
    await expect(page.getByTestId('sent-summary')).toContainText('Each thing was sent once.')
    await expect(page.getByTestId('sent-row').filter({ hasText: 'Sent after 2 failed attempts, once.' })).toHaveCount(1)
  })

  test('sends a step that uses all its attempts to the dead-letter queue, and one click replays it without sending twice', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.lowStock)
    await page.locator('[data-testid="failure"][data-step="tell_purchasing"] select').selectOption('3')
    await expect(page.locator('[data-testid="failure"][data-step="tell_purchasing"]')).toContainText('dead-letter queue')

    await page.getByTestId('run').click()

    await expectRunStatus(page, 'failed', 30_000)
    await expect(page.getByTestId('dead-letter')).toHaveCount(1)
    await expect(page.locator('[data-testid="run-step"][data-step="tell_purchasing"] [data-testid="step-dead"]')).toBeVisible()
    await expect(page.getByTestId('sent-row')).toHaveCount(1)
    await expect(page.getByTestId('quota')).toContainText('9 of 10')

    await page.getByTestId('dead-replay').click()

    await expectRunStatus(page, 'succeeded', 30_000)
    await expect(page.getByTestId('dead-replayed')).toHaveCount(1)
    await expect(page.getByTestId('quota')).toContainText('8 of 10')
    await expect(page.getByTestId('sent-row')).toHaveCount(2)
    await expect(page.getByTestId('sent-summary')).toContainText('Each thing was sent once.')
    await expect(page.getByTestId('sent-figures')).toContainText('2 sent and 1 recognised and not sent again')
    await expect(page.getByTestId('sent-row').filter({ hasText: 'Recognised again in run 2, and not sent a second time.' })).toHaveCount(1)
    await expect(page.getByTestId('run-chain')).toContainText('Replay 2')
    await page.getByLabel('Read the log of').selectOption({ label: 'Replay 2' })
    await expect(page.locator('[data-testid="log-event"][data-type="effect.duplicate_suppressed"]')).toHaveCount(1)
  })

  test('replays a whole finished run in one click, which counts as a run', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.lowStock)
    await expect(page.getByTestId('replay-run')).toHaveCount(0)
    await page.getByTestId('run').click()
    await expectRunStatus(page, 'succeeded')
    await expect(page.getByTestId('replay-run')).toBeEnabled()

    await page.getByTestId('replay-run').click()

    await expect(page.getByTestId('run-chain')).toContainText('Replay 2')
    await expect(page.getByTestId('quota')).toContainText('8 of 10')
    await expectRunStatus(page, 'succeeded')
    // Everything was sent in the first run, so the replay sends nothing: both deliveries are recognised.
    await expect(page.getByTestId('sent-figures')).toContainText('2 sent and 2 recognised and not sent again')
    await expect(page.getByTestId('sent-summary')).toContainText('Each thing was sent once.')
  })

  test('waits for the person an approval asks, and goes down the branch they choose', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.refund)
    await page.getByTestId('run').click()

    await expect(page.getByTestId('approval')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('approval-question')).toContainText('is asked:')
    await expectRunStatus(page, 'awaiting_approval')
    await page.getByTestId('reject').click()

    await expectRunStatus(page, 'succeeded', 20_000)
    await expect(page.getByTestId('approval')).toHaveCount(0)
    await expect(page.locator('[data-testid="run-step"][data-status="skipped"]').first()).toBeVisible()
    await expect(page.locator('[data-testid="log-event"][data-type="step.decided"]')).toHaveCount(1)
  })

  test('says the sandbox is a mock, and what it sent is a row in the demo\'s own table', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.wholesale)

    await expect(page.getByTestId('sandbox')).toContainText('Nothing leaves the system')
    await expect(page.getByTestId('sandbox')).toContainText('.test')
  })

  test('uses up the day\'s runs, says so, and turns the run button off', async ({ page }) => {
    test.setTimeout(150_000)
    await openBoard(page)
    await openLive(page, languages[0].samples.wholesale)

    for (let used = 1; used <= 10; used += 1) {
      await page.getByTestId('run').click()
      await expect(page.getByTestId('quota')).toContainText(`${10 - used} of 10`)
      await expectRunStatus(page, 'succeeded', 30_000)
    }

    await expect(page.getByTestId('run')).toBeDisabled()
    await expect(page.getByTestId('run-blocked')).toContainText('Today\'s runs are used up')
    await expect(page.getByTestId('replay-run')).toBeDisabled()
    await expect(page.getByText('None left today.')).toBeVisible()
  })
})

test.describe('describing a process in words', () => {
  test('turns the visitor\'s words into a workflow they can edit, and records that a model wrote it', async ({ page }) => {
    await openBoard(page)
    await page.getByRole('button', { name: languages[0].ownTab }).click()
    await page.getByLabel('What the process should do').fill('When a wholesale order over €500 arrives, check stock, alert the roastery on Slack and email the café an ETA.')

    await page.getByTestId('describe').click()

    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('canvas-step').first()).toBeVisible()
    await expect(page.getByTestId('versions')).toContainText('The model')
    await expect(page.getByTestId('generations')).toContainText('9 of 10')
    await expect(page.getByTestId('scope-row').first()).toBeVisible({ timeout: 15_000 })

    // The version names the trace of its description, which opens on its own page.
    await page.getByRole('link', { name: 'Open the trace' }).click()
    await expect(page).toHaveURL(/\/runs\/[\w-]+$/)
    await expect(page.getByTestId('scope-row').first()).toBeVisible({ timeout: 15_000 })
  })

  test('says what the checks refused when the model wrote a process that cannot be built', async ({ page, problems }) => {
    await openBoard(page)
    await page.getByRole('button', { name: languages[0].ownTab }).click()
    await page.getByLabel('What the process should do').fill('Whenever a customer leaves a review, send them an SMS to thank them.')

    await page.getByTestId('describe').click()

    await expect(page.getByTestId('refusal')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('refusal-problem').first()).toBeVisible()
    await expect(page.getByTestId('editor')).toHaveCount(0)
    // The refusal is a 422 answer, which the browser logs as an error: it is the one expected here.
    expect(problems.errors.join(' ')).toContain('422')
    problems.errors.length = 0
  })

  test('asks for at least ten characters', async ({ page }) => {
    await openBoard(page)
    await page.getByRole('button', { name: languages[0].ownTab }).click()
    await page.getByLabel('What the process should do').fill('Short')

    await expect(page.getByTestId('describe')).toBeDisabled()
    await expect(page.getByText('Write at least 10 characters.')).toBeVisible()
  })
})

test.describe('the reading modes', () => {
  test('leaves out the ids, the event names and the validator\'s codes in the Brief reading', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.lowStock)
    await page.getByTestId('run').click()
    await expectRunStatus(page, 'succeeded')
    await expect(page.locator('[data-testid="log-event"] .type').first()).toBeVisible()

    await page.getByRole('button', { name: 'Brief', exact: true }).click()

    await expect(page.locator('[data-testid="log-event"] .type')).toHaveCount(0)
    await expect(page.locator('[data-testid="run-step"] .lb8-mono.kind')).toHaveCount(0)
  })
})

test.describe('using only the keyboard', () => {
  test('edits a workflow in the outline: adds a step, connects it, fixes the problem and saves', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.wholesale)
    await showView(page, 'Outline')

    // Pick a kind of step by typing its name, add it with Enter, and land on its form.
    await page.locator('#lb08-kind').focus()
    await page.keyboard.type('Webhook')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('outline-step')).toHaveCount(6)
    await expect(page.getByTestId('inspector').getByRole('heading', { level: 3 })).toBeFocused()
    await expect(page.getByTestId('validity')).toContainText('Problems: 1')

    // Connect the stock check to it: choose it in the select by typing, tab to the button, press Enter.
    await page.locator('#connect-check_stock').focus()
    await page.keyboard.type('6.')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('validity')).toContainText('Valid.')

    // Save with Enter on the button.
    await page.getByTestId('save').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('saved-state')).toContainText('Saved')
    await expect(page.getByTestId('version')).toHaveCount(2)
    await expect(page.getByTestId('said')).toContainText('Saved as version 2.')
  })

  test('moves and removes a step on the canvas with the arrow keys and Delete, and says so', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.lowStock)
    const step = page.locator('.vue-flow__node[data-id="reorder_task"]')
    await step.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('inspector')).toContainText('Step: Add the reorder task')
    await expect(page.getByTestId('said')).toContainText('Picked Add the reorder task.')

    const before = await step.boundingBox()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    const after = await step.boundingBox()
    expect((after?.y ?? 0) - (before?.y ?? 0)).toBeGreaterThan(10)
    await expect(page.getByTestId('said')).toContainText('Moved Add the reorder task to')

    const scrolled = await page.evaluate(() => window.scrollY)
    await page.keyboard.press('Space')
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled)

    await page.keyboard.press('Delete')
    await expect(page.getByTestId('canvas-step')).toHaveCount(2)
    await expect(page.getByTestId('said')).toContainText('Removed the step Add the reorder task.')
    await page.getByTestId('undo').click()
    await expect(page.getByTestId('canvas-step')).toHaveCount(3)
  })

  test('reaches the steps of the canvas in the tab order and shows where the focus is', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.lowStock)

    await page.getByTestId('zoom-fit').focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    // The focus moved on to the canvas: a step, or the "go to the form" button when nothing is picked.
    const focused = await page.evaluate(() => document.activeElement?.className ?? '')
    expect(focused).toContain('vue-flow__node')
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle)
    expect(outline).not.toBe('none')
  })

  test('does not take the keys for itself: Space still scrolls the page and Backspace does not delete a step', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.lowStock)
    await page.locator('body').click({ position: { x: 5, y: 5 } })

    const before = await page.evaluate(() => window.scrollY)
    await page.keyboard.press('Space')
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(before)
    await page.keyboard.press('Backspace')
    await expect(page.getByTestId('canvas-step')).toHaveCount(3)
  })
})

test.describe('the page policy', () => {
  for (const language of languages) {
    test(`needs nothing the other boards do not have, in ${language.code}: a nonce policy with Trusted Types and no eval`, async ({ request }) => {
      const response = await request.get(`${language.prefix}/systems/lb-08/board`)
      const csp = response.headers()['content-security-policy'] ?? ''

      expect(csp).toMatch(/script-src 'self' 'strict-dynamic' 'nonce-[\w+/=-]{16,}'/)
      expect(csp).not.toContain('unsafe-eval')
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/)
      expect(csp).toContain('require-trusted-types-for \'script\'')
      // The one list every board has: Vue's, and the check's own. The canvas adds no policy.
      expect(csp).toContain('trusted-types vue lb-turnstile')
      expect(csp).toContain('frame-ancestors \'none\'')
    })
  }

  test('lets the canvas draw its steps and connections with no violation of it', async ({ page }) => {
    await openBoard(page)
    await openLive(page, languages[0].samples.wholesale)
    await expect(page.locator('.vue-flow__edge')).toHaveCount(4)
    await expect(page.locator('.vue-flow__node').first()).toHaveCSS('position', 'absolute')
    // The fixture fails the test on any CSP or Trusted Types violation; this says it looked.
    expect(await page.evaluate(() => window.__cspViolations)).toEqual([])
  })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('starts on the outline, scrolls nothing sideways, and runs a workflow', async ({ page }) => {
    await openBoard(page)
    await page.getByTestId('open-sample-live').click()
    await expect(page.getByTestId('outline')).toBeVisible()
    await expect(page.getByTestId('canvas')).toHaveCount(0)

    await page.getByTestId('run').click()
    await expectRunStatus(page, 'succeeded')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
})
