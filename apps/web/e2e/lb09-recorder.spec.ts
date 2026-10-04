// End-to-end journeys of LB-09's recorder, in a browser launched with a fake microphone (Chromium's
// fake device, which plays a tone): the explanation before any permission is asked, a recording made,
// counted down and listened back to, then sent through the recorder to its result, played from the
// browser's memory under the page's policy; and the states when the microphone is refused and when
// the browser cannot record at all. The launch options are set for the whole file, as Playwright
// requires, so they are stated here with the executable the configuration names. Every test also
// fails on a CSP or Trusted Types violation, a page error or a console error (e2e/fixtures.ts).
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

// Playwright replaces the launch options whole, so the executable the configuration names is repeated here.
test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--use-fake-device-for-media-stream'] } })

/** Opens the board and waits until it has read the session and counted the day's recordings. */
async function openBoard(page: Page): Promise<void> {
  await page.goto('/systems/lb-09/board')
  await expect(page.getByTestId('quota')).toContainText('5 of 5')
}

/** Waits for the result of a meeting: its items and its transcript. */
async function expectResult(page: Page): Promise<void> {
  await expect(page.getByTestId('items')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('transcript')).toBeVisible()
}

test.describe('the recorder with a microphone', () => {
  test.use({ permissions: ['microphone'] })

  test('explains, records from the microphone, counts down, lets the visitor listen back, and sends the recording', async ({ page }) => {
    await openBoard(page)
    await page.getByRole('button', { name: 'Your own recording' }).click()
    await expect(page.getByTestId('recorder')).toContainText('the browser asks you for the microphone')
    await page.getByTestId('record').click()
    await expect(page.getByTestId('recorder-live')).toContainText('s left of 60')
    await expect(page.getByTestId('recorder-live')).toContainText(/5[0-7] s left of 60/, { timeout: 15_000 })
    await page.getByTestId('stop-recording').click()
    await expect(page.getByTestId('recorder-made')).toBeVisible()
    await expect(page.getByTestId('recorder-made').getByTestId('audio-player')).toHaveAttribute('src', /^blob:/)
    await page.getByTestId('send-recording').click()
    await expect(page.getByTestId('playback')).toContainText('Your recording')
    await expect(page.getByTestId('playback').getByTestId('audio-player')).toHaveAttribute('src', /^blob:/)
    await expectResult(page)
    await expect(page.getByTestId('actions').getByRole('listitem')).toHaveCount(1)
    await expect(page.getByTestId('facts').locator('[data-fact="audio"]')).toContainText('Deleted')
    await expect(page.getByTestId('quota')).toContainText('4 of 5')
  })
})

test.describe('the recorder without a microphone', () => {
  test('says the microphone was refused, and how to allow it', async ({ page }) => {
    // A headless browser leaves the permission prompt open for ever, so the refusal is made the way a visitor's "Block" makes it.
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
    })
    await openBoard(page)
    await page.getByRole('button', { name: 'Your own recording' }).click()
    await page.getByTestId('record').click()
    await expect(page.getByTestId('recorder-denied')).toContainText('address bar')
    await expect(page.getByTestId('recorder-made')).toHaveCount(0)
  })

  test('says when the browser cannot record at all', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'MediaRecorder', { value: undefined, configurable: true })
    })
    await openBoard(page)
    await page.getByRole('button', { name: 'Your own recording' }).click()
    await page.getByTestId('record').click()
    await expect(page.getByTestId('recorder-unsupported')).toContainText('cannot record')
  })
})
