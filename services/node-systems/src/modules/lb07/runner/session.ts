// The browser the agent drives, as sessions: one browser process for the runner's life, a fresh
// context (its own cookies, storage and cache) for every run, closed when the run ends or when its
// wall clock runs out, whichever comes first. The second of the sandbox's two layers lives here: every
// request the page makes passes a route handler that lets through the shop's origin and aborts
// everything else, recording it. The bug token goes into the context's cookie jar before the first page
// opens, which is the only way a bug is switched on. After its share of runs the runner declares itself
// exhausted, so the process can exit and be started fresh.
import { randomUUID } from 'node:crypto'

import { LB07_LIMITS } from '@lb/contracts'
import type { Lb07Engine, Lb07Step } from '@lb/contracts'
import { chromium } from 'playwright-core'
import type { Browser, BrowserContext, LaunchOptions, Page } from 'playwright-core'

import { runAxe } from './axe.ts'
import { runStep } from './executor.ts'
import type { StepResult } from './executor.ts'
import { FindingCollector } from './findings.ts'
import { FIREFOX_USER_AGENT, shopPathOf } from './guard.ts'
import type { CloseResponse, OpenSessionRequest, RunnerFinding } from './protocol.ts'
import { trimSnapshot } from './snapshot.ts'

/** How the sessions are set up. */
export interface SessionsOptions {
  shopOrigin: string
  // The browser to start: Playwright's own Chromium when absent.
  executablePath?: string
  // How many runs this process serves before it is exhausted.
  runsPerLife?: number
  // The cookie the bug token travels in (the shop's name for it).
  bugCookie: string
}

/** One open session. */
interface Session {
  id: string
  engine: Lb07Engine
  context: BrowserContext
  page: Page
  findings: FindingCollector
  startedAt: number
  timer: ReturnType<typeof setTimeout>
  expired: boolean
}

/** The errors the sessions raise, with a code the server answers with. */
export class SessionError extends Error {
  readonly code: 'busy' | 'exhausted' | 'no_session' | 'expired' | 'browser'
  readonly status: number

  constructor(code: SessionError['code'], message: string) {
    super(message)
    this.name = 'SessionError'
    this.code = code
    this.status = code === 'busy' ? 409 : code === 'exhausted' ? 503 : code === 'no_session' ? 404 : code === 'expired' ? 410 : 500
  }
}

// What Chromium is started with. Its own sandbox needs user namespaces the hardened container does
// not grant (no capabilities, no new privileges), so the container is the sandbox and Chromium's
// is off; the rest keeps one renderer and a small heap, since the shop is tiny.
const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions', '--renderer-process-limit=1', '--js-flags=--max-old-space-size=128']

/** The browser sessions of one runner process. */
export class BrowserSessions {
  readonly #options: SessionsOptions
  readonly #runsPerLife: number
  #browser: Browser | undefined
  #current: Session | undefined
  #runsServed = 0

  /** Prepares the sessions; the browser starts with the first one. */
  constructor(options: SessionsOptions) {
    this.#options = options
    this.#runsPerLife = options.runsPerLife ?? LB07_LIMITS.runsPerRunnerLife
  }

  /** How many runs this process has served. */
  get runsServed(): number {
    return this.#runsServed
  }

  /** Whether a session is open. */
  get busy(): boolean {
    return this.#current !== undefined
  }

  /** Whether this process has served its share and should exit for a fresh start. */
  get exhausted(): boolean {
    return this.#runsServed >= this.#runsPerLife
  }

  /** Starts the browser, once. */
  async #browserReady(): Promise<Browser> {
    if (this.#browser?.isConnected()) return this.#browser
    const launch: LaunchOptions = { headless: true, args: LAUNCH_ARGS }
    if (this.#options.executablePath) launch.executablePath = this.#options.executablePath
    this.#browser = await chromium.launch(launch)
    return this.#browser
  }

  /** The open session, or a refusal. */
  #session(id: string): Session {
    const session = this.#current
    if (!session || session.id !== id) throw new SessionError('no_session', 'There is no such session.')
    if (session.expired) throw new SessionError('expired', 'The session reached its wall clock and was closed.')
    return session
  }

  /** Opens a session for a run: a fresh context with the bug token in its cookie jar, the sandbox's route and the collectors attached. */
  async open(request: OpenSessionRequest): Promise<string> {
    if (this.#current) throw new SessionError('busy', 'A run is in the browser. Try again when it has ended.')
    if (this.exhausted) throw new SessionError('exhausted', 'This runner has served its share of runs and is about to restart.')
    const browser = await this.#browserReady()
    const context = await browser.newContext({
      viewport: { width: 1_024, height: 768 },
      userAgent: request.engine === 'firefox-ua' ? FIREFOX_USER_AGENT : undefined,
      // axe is injected into the shop's pages; the shop sets no policy, and this keeps the injection working if one day it does.
      bypassCSP: true,
      javaScriptEnabled: true,
      acceptDownloads: false,
      serviceWorkers: 'block',
    })
    const findings = new FindingCollector(request.engine, this.#options.shopOrigin)
    const shop = new URL(this.#options.shopOrigin)
    if (request.bugToken !== null) {
      await context.addCookies([{ name: this.#options.bugCookie, value: request.bugToken, domain: shop.hostname, path: '/', httpOnly: true, sameSite: 'Lax' }])
    }
    // The second layer: nothing leaves for another origin, whatever the page asks for.
    await context.route('**/*', async (route) => {
      const url = route.request().url()
      if (new URL(url).origin === this.#options.shopOrigin) {
        await route.continue()
        return
      }
      findings.blockedNavigation(FindingCollector.targetOf(url), 'request')
      await route.abort('blockedbyclient')
    })
    const page = await context.newPage()
    page.on('dialog', dialog => void dialog.dismiss().catch(() => undefined))
    findings.attach(page)
    const id = randomUUID()
    const session: Session = { id, engine: request.engine, context, page, findings, startedAt: Date.now(), expired: false, timer: setTimeout(() => void this.#expire(id), request.wallClockMs) }
    session.timer.unref()
    this.#current = session
    this.#runsServed += 1
    return id
  }

  /** Closes a session whose wall clock ran out; its findings stay until it is closed by the caller. */
  async #expire(id: string): Promise<void> {
    const session = this.#current
    if (!session || session.id !== id) return
    session.expired = true
    await session.context.close().catch(() => undefined)
  }

  /** Runs one step in the session. */
  async step(id: string, index: number, step: Lb07Step): Promise<StepResult & { path: string, findings: RunnerFinding[] }> {
    const session = this.#session(id)
    session.findings.stepIndex = index
    const result = await runStep(session.page, step, this.#options.shopOrigin, session.findings)
    return { ...result, path: shopPathOf(session.page.url(), this.#options.shopOrigin), findings: session.findings.drain() }
  }

  /** The page's accessibility tree, trimmed. */
  async snapshot(id: string): Promise<{ text: string, path: string }> {
    const session = this.#session(id)
    const raw = await session.page.locator('body').ariaSnapshot({ timeout: 5_000 }).catch(() => '')
    return { text: trimSnapshot(raw), path: shopPathOf(session.page.url(), this.#options.shopOrigin) }
  }

  /** A screenshot of the page as PNG, or an empty picture when the page cannot be drawn in time. */
  async screenshot(id: string): Promise<{ base64: string, path: string }> {
    const session = this.#session(id)
    let bytes: Buffer
    try {
      bytes = await session.page.screenshot({ type: 'png', timeout: 5_000, fullPage: false })
    }
    catch {
      bytes = Buffer.alloc(0)
    }
    if (bytes.byteLength > LB07_LIMITS.maxScreenshotBytes) bytes = Buffer.alloc(0)
    return { base64: bytes.toString('base64'), path: shopPathOf(session.page.url(), this.#options.shopOrigin) }
  }

  /** Runs axe in the page and returns its findings. An axe that cannot run is one finding of its own, never a crash of the run. */
  async axe(id: string, index: number | null): Promise<{ findings: RunnerFinding[], path: string }> {
    const session = this.#session(id)
    session.findings.stepIndex = index
    const path = shopPathOf(session.page.url(), this.#options.shopOrigin)
    try {
      for (const finding of await runAxe(session.page, path)) session.findings.add(finding)
    }
    catch {
      session.findings.add({ kind: 'console_error', title: 'The accessibility check could not run on this page', detail: 'axe-core could not be run in the page.', rule: null, path })
    }
    return { findings: session.findings.drain(), path }
  }

  /** Closes the session and returns what is left: the findings not yet handed over and the sandbox's counts. */
  async close(id: string): Promise<CloseResponse> {
    const session = this.#current
    if (!session || session.id !== id) throw new SessionError('no_session', 'There is no such session.')
    clearTimeout(session.timer)
    this.#current = undefined
    await session.context.close().catch(() => undefined)
    return { findings: session.findings.drain(), offOriginRequests: session.findings.offOrigin, blocked: session.findings.blocked }
  }

  /** Closes everything, for the process's end. */
  async shutdown(): Promise<void> {
    if (this.#current) await this.close(this.#current.id).catch(() => undefined)
    await this.#browser?.close().catch(() => undefined)
    this.#browser = undefined
  }
}
