// LB-02 as an installable app, in a real browser: the manifest each language names, the service worker
// registered under the site's Content Security Policy and Trusted Types policy for the board's part of
// the site only, the page opening without a connection from the copy the worker kept, the page for no
// connection when no copy was kept, and, most important, what the worker keeps: nothing but the board's
// own page and its static files, never an API answer, a token, a conversation or a WebSocket's frames.
// They are registered by e2e/lb02.spec.ts.
import type { Page } from '@playwright/test'

import { expect, test } from '../fixtures'
import { beginConversation, openBoard, say, watchSockets } from './support'

const languages = [
  { code: 'en', prefix: '', counted: '10 of 10', manifest: '/lb02.en.webmanifest', scope: '/systems/lb-02/', offline: 'You are offline' },
  { code: 'cs', prefix: '/cs', counted: '10 z 10', manifest: '/lb02.cs.webmanifest', scope: '/cs/systems/lb-02/', offline: 'Jste offline' },
] as const

/** Waits until the board's service worker is active, and returns what it was registered for. */
async function registeredWorker(page: Page): Promise<{ scope: string, script: string | undefined }> {
  return await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    return { scope: new URL(registration.scope).pathname, script: registration.active ? new URL(registration.active.scriptURL).pathname : undefined }
  })
}

/** Lists what the worker has kept on the device: every cache and the path of every file in it. */
async function keptFiles(page: Page): Promise<Record<string, string[]>> {
  return await page.evaluate(async () => {
    const kept: Record<string, string[]> = {}
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      kept[name] = (await cache.keys()).map(request => new URL(request.url).pathname)
    }
    return kept
  })
}

/** Opens the board, lets the worker install, and loads it once more so the page is controlled by the worker and kept. */
async function installAndKeep(page: Page, prefix: string, counted: string): Promise<void> {
  await openBoard(page, `${prefix}/systems/lb-02/board`, counted)
  await expect(page.getByTestId('app-preparing')).toBeVisible()
  await registeredWorker(page)
  await page.reload()
  await expect(page.getByTestId('app-cached')).toBeVisible()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
}

/** Registers the tests of the installable app. */
export function installableApp(): void {
  for (const language of languages) {
    test.describe(`the installable app in ${language.code}`, () => {
      test('names its manifest in the page, and the manifest describes an app that opens on the board', async ({ page }) => {
        await openBoard(page, `${language.prefix}/systems/lb-02/board`, language.counted)
        await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', language.manifest)
        const answer = await page.request.get(language.manifest)
        expect(answer.ok()).toBe(true)
        expect(answer.headers()['content-type']).toMatch(/json/)
        const manifest = await answer.json() as Record<string, unknown> & { icons: { src: string, type: string }[] }
        expect(manifest).toMatchObject({ lang: language.code, display: 'standalone', scope: language.scope, start_url: `${language.prefix}/systems/lb-02/board` })
        expect(String(manifest.start_url).startsWith(String(manifest.scope))).toBe(true)
        const icon = await page.request.get(manifest.icons[0]?.src ?? '/missing')
        expect(icon.ok()).toBe(true)
        expect(icon.headers()['content-type']).toContain('image/svg+xml')
        await expect(page.locator('html')).toHaveAttribute('lang', language.code)
      })

      test('registers the worker for the board\'s part of the site and no other, under the page\'s Trusted Types policy, with no default policy', async ({ page }) => {
        await openBoard(page, `${language.prefix}/systems/lb-02/board`, language.counted)
        expect(await registeredWorker(page)).toEqual({ scope: language.scope, script: '/lb02-sw.js' })
        expect(await page.evaluate(() => (window as unknown as { trustedTypes?: { defaultPolicy: unknown } }).trustedTypes?.defaultPolicy ?? null)).toBeNull()
        const all = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(registration => new URL(registration.scope).pathname))
        expect(all).toEqual([language.scope])
      })

      test('is installable as far as the browser can tell', async ({ page }) => {
        await openBoard(page, `${language.prefix}/systems/lb-02/board`, language.counted)
        await registeredWorker(page)
        const client = await page.context().newCDPSession(page)
        const { installabilityErrors } = await client.send('Page.getInstallabilityErrors') as { installabilityErrors: { errorId: string }[] }
        // A test's browser context is a private window, where a browser never installs an app: that is the one thing it may report.
        expect(installabilityErrors.map(problem => problem.errorId).filter(id => id !== 'in-incognito')).toEqual([])
      })

      test('says the page is being saved on the first visit and is on the device after one more load', async ({ page }) => {
        await openBoard(page, `${language.prefix}/systems/lb-02/board`, language.counted)
        await expect(page.getByTestId('app-preparing')).toBeVisible()
        await expect(page.getByTestId('app-cached')).toHaveCount(0)
        await registeredWorker(page)
        await page.reload()
        await expect(page.getByTestId('app-cached')).toBeVisible()
        await expect(page.getByTestId('app-preparing')).toHaveCount(0)
      })

      test('opens without a connection from the copy the worker kept, and is honest that the concierge, the calendar and the recordings need one', async ({ page, context, problems }) => {
        await installAndKeep(page, language.prefix, language.counted)
        await context.setOffline(true)
        await page.reload()
        await expect(page.getByTestId('board-state')).toBeVisible()
        await expect(page.getByTestId('app-offline')).toContainText(language.offline)
        await expect(page.getByTestId('start-sample')).toBeDisabled()
        await context.setOffline(false)
        // The failed calls are logged by the browser itself.
        problems.errors.length = 0
      })

      test('shows the page for no connection when no copy of the board was kept', async ({ page, context, problems }) => {
        await openBoard(page, `${language.prefix}/systems/lb-02/board`, language.counted)
        await registeredWorker(page)
        await context.setOffline(true)
        await page.goto(`${language.prefix}/systems/lb-02/board`)
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(language.offline)
        await expect(page.getByRole('link', { name: language.code === 'en' ? 'Try again' : 'Zkusit znovu' })).toHaveAttribute('href', `${language.prefix}/systems/lb-02/board`)
        await context.setOffline(false)
        problems.errors.length = 0
      })
    })
  }

  test.describe('what the worker keeps', () => {
    test('keeps only the board\'s page and its static files after a visit that used the API, a conversation and a replay, and answers no API call itself', async ({ page }) => {
      const fromWorker: string[] = []
      page.on('response', (response) => {
        if (response.fromServiceWorker()) fromWorker.push(new URL(response.url()).pathname)
      })
      const sockets = watchSockets(page)
      await installAndKeep(page, '', '10 of 10')
      fromWorker.length = 0

      await page.getByTestId('start-sample').click()
      await expect(page.getByTestId('booking-code')).toHaveText(/^BB-/, { timeout: 15_000 })
      await page.getByTestId('again').click()
      await page.getByRole('button', { name: 'Your own conversation' }).click()
      await page.getByTestId('begin').click()
      await expect(page.getByTestId('connection')).toHaveText('Connected')
      await say(page, 'Hello! I would like a cupping for two tomorrow at 14:30. I am Jana Novak, jana@example.test.')
      await page.reload()
      await expect(page.getByTestId('app-cached')).toBeVisible()

      const kept = await keptFiles(page)
      expect(Object.keys(kept).sort()).toEqual(['lb02-offline-v1', 'lb02-shell-v1'])
      const everything = Object.values(kept).flat()
      expect(everything.length).toBeGreaterThan(5)
      expect(everything.filter(path => path.startsWith('/api/'))).toEqual([])
      expect(everything.filter(path => path.includes('/ws/'))).toEqual([])
      expect(everything.filter(path => !/^(?:\/_nuxt\/(?:builds\/meta\/)?[\w.-]+|\/lb02[\w.-]+|\/systems\/lb-02\/board|\/cs\/systems\/lb-02\/board)$/.test(path))).toEqual([])
      expect(everything).not.toContain('/_nuxt/builds/latest.json')
      expect(kept['lb02-shell-v1']).toContain('/systems/lb-02/board')
      expect(kept['lb02-offline-v1']).toEqual(['/lb02-offline.en.html'])
      // No answer to an API call, a token or a recording ever came from the worker, and the socket never did.
      expect(fromWorker.filter(path => path.startsWith('/api/'))).toEqual([])
      expect(sockets.opened.length).toBeGreaterThan(0)
      expect(sockets.opened.every(address => !address.includes(new URL(page.url()).host))).toBe(true)
    })

    test('keeps the Czech page apart from the English one, with the offline page of its own language', async ({ page }) => {
      await installAndKeep(page, '/cs', '10 z 10')
      const kept = await keptFiles(page)
      expect(kept['lb02-shell-v1']).toContain('/cs/systems/lb-02/board')
      expect(kept['lb02-shell-v1']).not.toContain('/systems/lb-02/board')
      expect(kept['lb02-offline-v1']).toEqual(['/lb02-offline.cs.html'])
    })
  })

  test.describe('the install prompt', () => {
    test('is offered only when the browser offers it, and shown only when the visitor asks for it', async ({ page }) => {
      await openBoard(page)
      await registeredWorker(page)
      await expect(page.getByTestId('app-hint')).toBeVisible()
      await expect(page.getByTestId('app-install')).toHaveCount(0)
      await page.evaluate(() => {
        const offer = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
          prompt: () => {
            (window as unknown as { __prompted: number }).__prompted = ((window as unknown as { __prompted?: number }).__prompted ?? 0) + 1
            return Promise.resolve()
          },
          userChoice: Promise.resolve({ outcome: 'dismissed' as const }),
        })
        window.dispatchEvent(offer)
      })
      await expect(page.getByTestId('app-install')).toBeVisible()
      expect(await page.evaluate(() => (window as unknown as { __prompted?: number }).__prompted ?? 0)).toBe(0)
      await page.getByTestId('app-install').click()
      await expect(page.getByTestId('app-install')).toHaveCount(0)
      expect(await page.evaluate(() => (window as unknown as { __prompted?: number }).__prompted ?? 0)).toBe(1)
    })
  })

  test('the board still works with the worker in control: a conversation reaches its booking', async ({ page }) => {
    await installAndKeep(page, '', '10 of 10')
    await beginConversation(page)
    await say(page, 'Hello! I would like a cupping for two tomorrow at 14:30. I am Jana Novak, jana@example.test.')
    await say(page, 'Yes, that one.')
    await say(page, 'Yes, please confirm it.')
    await expect(page.getByTestId('booking-code')).toHaveText(/^BB-/)
  })
}
