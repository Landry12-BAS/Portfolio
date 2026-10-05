// End-to-end journeys of LB-09's evaluation board, in a real browser against the test build of the
// site and the mock back end: a recorded meeting replayed in both languages with no request made, a
// curated meeting run live and followed over the WebSocket to its items and exports, a jump to the
// second an item was said, the visitor's meetings listed after a reload and opened again, a meeting
// the worker fails (and one that gives its place back), the fallback to reading the meeting when the
// socket is dropped, and the keyboard with its focus. The recorder's own journeys, which need a
// browser launched with a fake microphone, and the visitor's own files are in
// lb09-recorder.spec.ts. Every test also fails on a CSP or Trusted Types violation, a page error or a
// console error (e2e/fixtures.ts). The Turnstile check is the test build's stand-in; the real widget
// needs Cloudflare.
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

/** The mock back end's address, where its test controls live. */
const MOCK = `http://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 8121}`

/** Opens the board and waits until it has read the session and counted the day's recordings. */
async function openBoard(page: Page, path = '/systems/lb-09/board', counted = '5 of 5'): Promise<void> {
  await page.goto(path)
  await expect(page.getByTestId('quota')).toContainText(counted)
}

/** Sends a control to the mock's LB-09. */
async function control(page: Page, action: string, data: object = {}): Promise<void> {
  const answer = await page.request.post(`${MOCK}/__mock/lb09/${action}`, { data })
  expect(`${answer.status()} ${await answer.text()}`).toMatch(/^200 /)
}

/** Records the requests that could change something, so a test can say that none was made. */
function watchWrites(page: Page): string[] {
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
  })
  return writes
}

/** Chooses a curated meeting by its radio button's position. */
async function chooseSample(page: Page, index: number): Promise<void> {
  await page.getByTestId('sample-picker').getByRole('radio').nth(index).check()
}

/** Waits for the result of a meeting: its items and its transcript. */
async function expectResult(page: Page): Promise<void> {
  await expect(page.getByTestId('items')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('transcript')).toBeVisible()
}

test.describe('replays', () => {
  for (const language of [
    { code: 'en', prefix: '', counted: '5 of 5', replay: 'Replay this meeting', done: 'The meeting is done' },
    { code: 'cs', prefix: '/cs', counted: '5 z 5', replay: 'Přehrát tuto poradu', done: 'Porada je hotová' },
  ]) {
    test(`replay the roasting plan in ${language.code} with no request to the back end`, async ({ page }) => {
      await openBoard(page, `${language.prefix}/systems/lb-09/board`, language.counted)
      const writes = watchWrites(page)
      await page.getByRole('button', { name: language.replay }).click()
      await expect(page.getByTestId('replay-banner')).toBeVisible()
      await expect(page.getByTestId('progress')).toBeVisible()
      await expectResult(page)
      await expect(page.getByTestId('announcement')).toHaveText(language.done)
      await expect(page.getByTestId('decisions').getByRole('listitem')).toHaveCount(2)
      await expect(page.getByTestId('actions').getByRole('listitem')).toHaveCount(3)
      // The sample's file is fetched from the site and played from the page's memory, so it can be sought.
      await expect(page.getByTestId('audio-player')).toHaveAttribute('data-source', '/lb09/monday-roasting-plan.mp3')
      await expect(page.getByTestId('audio-player')).toHaveAttribute('src', /^blob:/)
      await expect(page.getByTestId('quota')).toContainText(language.counted)
      expect(writes).toEqual([])
    })
  }
})

test.describe('live meetings', () => {
  test('run a meeting with no recording live, follow it over the socket, and export the result', async ({ page }) => {
    await openBoard(page)
    await chooseSample(page, 2)
    await expect(page.getByTestId('sample-no-recording')).toBeVisible()
    await expect(page.getByTestId('replay-sample')).toHaveCount(0)
    await page.getByTestId('run-sample').click()
    await expect(page.getByTestId('progress')).toBeVisible()
    await expect(page.getByTestId('progress-feed')).toContainText('WebSocket')
    await expect(page.locator('[data-stage="transcribing"]')).toHaveAttribute('data-mark', 'done', { timeout: 15_000 })
    await expectResult(page)
    await expect(page.getByTestId('quota')).toContainText('4 of 5')
    await expect(page.getByTestId('facts').locator('[data-fact="transcriber"]')).toHaveText('lb-stt')
    await expect(page.getByTestId('export-content')).toHaveValue(/Speaker labels are inferred from the words/)
    await page.getByRole('button', { name: 'CSV' }).click()
    await expect(page.getByTestId('export-content')).toHaveValue(/^"kind","text","owner"/)
    await expect(page.getByTestId('scope')).toBeVisible()
  })

  test('jump the player to an item\'s evidence, at the second it was said', async ({ page }) => {
    await openBoard(page)
    await page.getByRole('button', { name: 'Replay this meeting' }).click()
    await expectResult(page)
    // The first action, the order of bags, is said from 20.1 s of the sample's recording.
    await page.getByTestId('actions').getByRole('button').first().click()
    const player = page.getByTestId('playback').getByTestId('audio-player')
    await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.currentTime), { timeout: 10_000 }).toBeGreaterThanOrEqual(20)
    expect(await player.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeLessThan(23)
    await expect(page.getByTestId('transcript').locator('[aria-current="true"]')).toContainText('two thousand')
  })

  test('list the visitor\'s meetings after a reload, and open one again without spending another', async ({ page }) => {
    await openBoard(page)
    await chooseSample(page, 2)
    await page.getByTestId('run-sample').click()
    await expectResult(page)
    await expect(page.getByTestId('quota')).toContainText('4 of 5')
    const writes = watchWrites(page)
    await page.reload()
    await expect(page.getByTestId('quota')).toContainText('4 of 5')
    await expect(page.getByTestId('my-meeting')).toHaveCount(1)
    await expect(page.getByTestId('my-meeting')).toContainText('Newsletter draft')
    await expect(page.getByTestId('my-meeting')).toContainText('done')
    await page.getByTestId('open-meeting').click()
    await expectResult(page)
    await expect(page.getByTestId('my-meetings')).toContainText('On the board now')
    await expect(page.getByTestId('quota')).toContainText('4 of 5')
    expect(writes.filter(write => write === 'POST /api/lb09/meetings')).toEqual([])
  })

  test('give the day\'s place back when the service could not finish the meeting', async ({ page }) => {
    await openBoard(page)
    await control(page, 'fail', { reason: 'model' })
    await page.getByTestId('run-sample').click()
    await expect(page.getByTestId('progress')).toHaveAttribute('data-status', 'failed', { timeout: 20_000 })
    await expect(page.locator('[data-stage="labelling"]')).toHaveAttribute('data-mark', 'failed')
    await expect(page.getByTestId('progress-failure')).toContainText('could not be reached')
    await expect(page.getByTestId('progress-given-back')).toContainText('does not count')
    await expect(page.getByTestId('quota')).toContainText('5 of 5')
  })

  test('show the worker\'s failure with its reason', async ({ page }) => {
    await openBoard(page)
    await control(page, 'fail', { reason: 'no_speech' })
    await page.getByTestId('run-sample').click()
    await expect(page.getByTestId('progress')).toHaveAttribute('data-status', 'failed', { timeout: 20_000 })
    await expect(page.getByTestId('progress-failure')).toContainText('No speech was heard')
    await expect(page.getByTestId('items')).toHaveCount(0)
  })

  test('read the meeting instead when the socket is dropped, and still finish', async ({ page }) => {
    await openBoard(page)
    await page.getByTestId('run-sample').click()
    await expect(page.getByTestId('progress-feed')).toContainText('WebSocket')
    await control(page, 'drop', { code: 1012 })
    await expect(page.getByTestId('progress-feed')).toContainText('read again', { timeout: 10_000 })
    await expectResult(page)
  })

  test('the keyboard reaches the meetings and starts one', async ({ page }) => {
    await openBoard(page)
    const first = page.getByTestId('sample-picker').getByRole('radio').first()
    await first.focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('sample-picker').getByRole('radio').nth(1)).toBeChecked()
    await expect(page.getByTestId('sample-facts')).toContainText('Speakers: 3')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Replay this meeting' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('replay-banner')).toBeVisible()
  })

  test('the keyboard\'s focus follows a live meeting from its button to the progress, then to the result', async ({ page }) => {
    await openBoard(page)
    await chooseSample(page, 2)
    await page.getByTestId('run-sample').focus()
    await page.keyboard.press('Enter')
    // The run button is switched off while the meeting runs, so the focus goes to the progress rather than nowhere.
    await expect(page.locator('#lb09-progress-title')).toBeFocused()
    await expectResult(page)
    await expect(page.locator('#lb09-items-title')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('items').getByRole('button').first()).toBeFocused()
  })
})
