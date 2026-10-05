// End-to-end journeys of LB-09's recorder, in a browser launched with a fake microphone (Chromium's
// fake device, which plays a tone): the explanation before any permission is asked, a recording made,
// counted down and listened back to, then sent through the recorder to its result, played from the
// browser's memory under the page's policy; the states when the microphone is refused and when
// the browser cannot record at all; and a file of the visitor's own, chosen, said back with its
// length and sent with no language, or refused before it is sent. The launch options are set for the
// whole file, as Playwright requires, so they are stated here with the executable the configuration
// names. Every test also fails on a CSP or Trusted Types violation, a page error or a console error
// (e2e/fixtures.ts).
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

/** A WAV file of a 440 Hz tone, 16-bit mono, `seconds` long at `rate` samples a second. */
function toneWav(seconds: number, rate = 16_000): Buffer {
  const count = Math.round(seconds * rate)
  const data = Buffer.alloc(count * 2)
  for (let index = 0; index < count; index += 1) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 8_000), index * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

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

test.describe('a file of the visitor\'s own', () => {
  test('is chosen, said back with its length, sent with no language, and played from the browser', async ({ page }) => {
    await openBoard(page)
    await page.getByRole('button', { name: 'Your own recording' }).click()
    await page.getByTestId('file-input').setInputFiles({ name: 'stand-up.wav', mimeType: 'audio/wav', buffer: toneWav(3) })
    await expect(page.getByTestId('file-chosen')).toContainText('stand-up.wav, 3 seconds')
    await expect(page.getByTestId('recorder-made').getByTestId('audio-player')).toHaveAttribute('src', /^blob:/)
    const sent = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/lb09/meetings')
    await page.getByTestId('send-recording').click()
    const body = (await sent).postDataJSON() as { source: string, language?: string }
    expect(body.source).toBe('upload')
    // The transcriber hears the language: one forced on it from the page's language would be wrong for a visitor who speaks another.
    expect(body.language).toBeUndefined()
    await expectResult(page)
    await expect(page.getByTestId('playback').getByTestId('audio-player')).toHaveAttribute('src', /^blob:/)
    await expect(page.getByTestId('quota')).toContainText('4 of 5')
  })

  test('is refused before it is sent when it is longer than a minute, and nothing is spent', async ({ page }) => {
    await openBoard(page)
    const writes: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/lb09/')) writes.push(new URL(request.url()).pathname)
    })
    await page.getByRole('button', { name: 'Your own recording' }).click()
    await page.getByTestId('file-input').setInputFiles({ name: 'long.wav', mimeType: 'audio/wav', buffer: toneWav(75, 8_000) })
    await expect(page.getByTestId('file-problem')).toContainText('75 seconds')
    await expect(page.getByTestId('send-recording')).toHaveCount(0)
    await expect(page.getByTestId('quota')).toContainText('5 of 5')
    expect(writes).toEqual([])
  })
})
