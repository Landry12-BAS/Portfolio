// Each of the sandbox's layers inside the browser, on its own, on a real Chromium, against the hostile pages and
// the canary of test/support/lb07-hostile.ts:
//
//   1. the plan's check (guard.ts, used by the executor): a step that would leave the shop is refused before the
//      browser is asked, here in a browser that has no other layer at all;
//   2. interception (network.ts): every request and socket a page starts, in a browser started with no switches;
//   3. the browser's own network (network.ts): the dead-end proxy, the resolver rules and the WebRTC policy, in a
//      context that intercepts nothing;
//   4. the shop's own Content-Security-Policy (shop/server.ts), on the real shop in a browser with none of the above.
//
// Where a layer cannot see something by design, a test says so, so the README's account of the layers stays true:
// interception does not see the second hop of a redirect (Playwright's documented behaviour) nor WebRTC's UDP, and
// the shop's policy governs what a page loads and connects to, not where it navigates.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Lb07Step } from '@lb/contracts'
import { chromium } from 'playwright-core'
import type { Browser, BrowserContext, Page } from 'playwright-core'

import { runStep } from '../../src/modules/lb07/runner/executor.ts'
import { FindingCollector } from '../../src/modules/lb07/runner/findings.ts'
import { DeadEnd, interceptRequests, networkWallArgs } from '../../src/modules/lb07/runner/network.ts'
import { startCanary, startHostileShop } from '../support/lb07-hostile.ts'
import type { Canary, HostileShop } from '../support/lb07-hostile.ts'
import { startShop } from '../support/lb07-shop.ts'
import type { RunningShop } from '../support/lb07-shop.ts'

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined
let canary: Canary
let hostile: HostileShop

beforeAll(async () => {
  canary = await startCanary()
  hostile = await startHostileShop(canary)
})

afterAll(async () => {
  await hostile.close()
  await canary.close()
})

beforeEach(() => {
  canary.reset()
})

/** Waits for what a page's scripts do after it has loaded. */
function settle(ms = 2_000): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** A browser with the given switches only, a context with no layer of the sandbox, and a page in it. */
async function bareBrowser(args: string[] = []): Promise<{ browser: Browser, context: BrowserContext, page: Page }> {
  const browser = await chromium.launch({ headless: true, executablePath, args })
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false })
  return { browser, context, page: await context.newPage() }
}

describe('the plan\'s check alone, in a browser with no other layer', () => {
  it('refuses every step that would leave the shop before the browser moves, so nothing reaches the canary', async () => {
    const { browser, page } = await bareBrowser()
    const findings = new FindingCollector('chromium', hostile.origin)
    const out = `${canary.host}:${canary.port}`
    try {
      const steps = [
        `http://${out}/x`, `//${out}/x`, `\\\\${out}\\x`, `/\\${out}/x`, `http://shop@${out}/`, `http://${out}#@${hostile.origin.slice(7)}/`, 'http://2130706434:1/', `http://0x7f000002:${canary.port}/`,
        'file:///etc/passwd', ['javascript', 'fetch(1)'].join(':'), 'data:text/html,x', 'view-source:http://127.0.0.2/', 'http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/',
      ].map((path): Lb07Step => ({ action: 'goto', path }))
      for (const step of steps) expect((await runStep(page, step, hostile.origin, findings)).outcome, step.action === 'goto' ? step.path : '').toBe('blocked')
      // A link whose href leads out is refused before the click; the plan cannot reach it any other way.
      await page.goto(`${hostile.origin}/`)
      await page.setContent(`<a href="http://${out}/link">Partner</a>`)
      expect((await runStep(page, { action: 'click', role: 'link', name: 'Partner' }, hostile.origin, findings)).outcome).toBe('blocked')
      await settle(500)
      expect(canary.hits).toEqual([])
      expect(findings.blocked).toBe(steps.length + 1)
    }
    finally {
      await browser.close()
    }
  })
})

describe('interception alone, in a browser started with no switches', () => {
  it('stops every request and socket a page starts: fetch, XHR, sockets, streams, beacons, images, modules, frames, workers, prefetches, windows', async () => {
    const { browser, context, page } = await bareBrowser()
    const findings = new FindingCollector('chromium', hostile.origin)
    try {
      await interceptRequests(context, hostile.origin, findings)
      findings.attach(page)
      await page.goto(`${hostile.origin}/escape`)
      await settle()
      // Only WebRTC's UDP is beyond it: that is the browser's own network's to stop, below.
      expect(canary.hits).toEqual([])
      expect(findings.blocked).toBeGreaterThanOrEqual(5)
      expect(findings.offOrigin).toBe(0)
    }
    finally {
      await browser.close()
    }
  })

  it('does not see the second hop of a redirect, by design: which is why the browser\'s own network is a layer of its own', async () => {
    const { browser, context, page } = await bareBrowser()
    const findings = new FindingCollector('chromium', hostile.origin)
    try {
      await interceptRequests(context, hostile.origin, findings)
      await page.goto(`${hostile.origin}/redirect`).catch(() => undefined)
      await settle(500)
      expect(canary.hits.some(hit => hit.startsWith('GET /redirected'))).toBe(true)
    }
    finally {
      await browser.close()
    }
  })
})

describe('the browser\'s own network alone, in a context that intercepts nothing', () => {
  it('reaches nothing but the shop: no request, redirect hop, socket, stream or STUN packet leaves, and the shop still answers', async () => {
    const deadEnd = new DeadEnd()
    const { browser, page } = await bareBrowser(networkWallArgs(hostile.origin, await deadEnd.start()))
    try {
      expect((await page.goto(`${hostile.origin}/`))?.status()).toBe(200)
      await page.goto(`${hostile.origin}/escape`)
      await settle()
      await page.goto(`${hostile.origin}/redirect`).catch(() => undefined)
      await page.goto(`http://${canary.host}:${canary.port}/direct`).catch(() => undefined)
      await page.goto(`http://localhost:${canary.port}/by-name`).catch(() => undefined)
      await settle(500)
      expect(canary.hits).toEqual([])
      expect(canary.udpPackets()).toBe(0)
    }
    finally {
      await browser.close()
      await deadEnd.close()
    }
  })
})

describe('the shop\'s own policy alone, in a browser with none of the layers above', () => {
  let shop: RunningShop
  beforeAll(async () => {
    shop = await startShop()
  })
  afterAll(() => shop.close())

  it('keeps a script that got into a shop page from loading or connecting anywhere else, and from running inline', async () => {
    const { browser, page } = await bareBrowser()
    const out = `http://${canary.host}:${canary.port}`
    try {
      await page.goto(`${shop.origin}/`)
      // What a script that got into the page would try, written for the page (so as text, which only the page reads).
      const attempt = `(async (target) => {
        const results = []
        await fetch(target + '/fetch').then(() => results.push('fetch reached'), () => results.push('fetch refused'))
        await new Promise((resolve) => {
          const image = new Image()
          image.onload = () => resolve(results.push('image reached'))
          image.onerror = () => resolve(results.push('image refused'))
          image.src = target + '/img.png'
        })
        await new Promise((resolve) => {
          const socket = new WebSocket(target.replace('http', 'ws'))
          socket.onopen = () => resolve(results.push('socket reached'))
          socket.onerror = () => resolve(results.push('socket refused'))
        })
        return results
      })(${JSON.stringify(out)})`
      const tried = await page.evaluate(attempt) as string[]
      // What decides is the canary: a page sees a refusal both when the policy stopped a request and when the request left and failed.
      expect(canary.hits).toEqual([])
      expect(tried).toEqual(['fetch refused', 'image refused', 'socket refused'])
      // A script tag a hostile hand adds to the page does not run: the policy allows no inline script on it.
      await page.addScriptTag({ content: 'document.title = "ran"' }).catch(() => undefined)
      expect(await page.title()).not.toBe('ran')
    }
    finally {
      await browser.close()
    }
  })
})
