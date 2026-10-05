// The browser the agent drives, as sessions: one browser process for the runner's life, a fresh context (its own
// cookies, storage and cache) for every run, closed when the run ends or when its wall clock runs out, whichever
// comes first. Two of the sandbox's layers live here (network.ts): every request a page makes passes interception,
// which lets through the shop's origin only and refuses every socket, and the browser is started so its own network
// reaches the shop and nothing else. A context has no window but its page (any other one a page opens is closed at
// once), keeps the shop's own Content-Security-Policy, takes no download and runs no service worker. The bug token
// goes into the context's cookie jar before the first page opens, which is the only way a bug is switched on.
//
// One session at a time: a second request to open one is refused as busy, even while the first is still opening.
// A session whose caller never closes it (a worker that died) is closed at its wall clock and forgotten after a grace,
// so the browser is never held for ever. A browser that crashed is said to have crashed, so the worker tries the run
// again with a fresh one. After its share of runs the runner declares itself exhausted, and once its last session is
// closed or forgotten it says so to whoever listens, so the process can exit and be started fresh.
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
import { DeadEnd, interceptRequests, networkWallArgs } from './network.ts'
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
  // How long a session closed at its wall clock is kept for its caller to collect what it found, before it is forgotten.
  expiredGraceMs?: number
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
  // The timer that forgets the session once its wall clock has closed it and the grace is over.
  forget: ReturnType<typeof setTimeout> | undefined
  expired: boolean
  crashed: boolean
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

// What Chromium is started with, besides Playwright's own switches and the third layer's (network.ts). Chromium's own
// sandbox needs user namespaces the hardened container does not grant (no capabilities, no new privileges), so the
// container is the sandbox and Chromium's is off (Playwright turns it off too unless asked). Shared memory is not used
// (the container's /dev/shm is small), and one renderer with a small heap is enough for the tiny shop.
const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions', '--renderer-process-limit=1', '--js-flags=--max-old-space-size=128']

// How long a session closed at its wall clock is kept before it is forgotten: a worker that is alive closes it well within this.
const EXPIRED_GRACE_MS = 30_000

/** The browser sessions of one runner process. */
export class BrowserSessions {
  readonly #options: SessionsOptions
  readonly #runsPerLife: number
  readonly #deadEnd = new DeadEnd()
  readonly #exhaustedListeners: (() => void)[] = []
  #browser: Browser | undefined
  #current: Session | undefined
  #opening = false
  #runsServed = 0
  #saidExhausted = false

  /** Prepares the sessions; the browser starts with the first one. */
  constructor(options: SessionsOptions) {
    this.#options = options
    this.#runsPerLife = options.runsPerLife ?? LB07_LIMITS.runsPerRunnerLife
  }

  /** How many runs this process has served. */
  get runsServed(): number {
    return this.#runsServed
  }

  /** Whether a session is open, or being opened. */
  get busy(): boolean {
    return this.#current !== undefined || this.#opening
  }

  /** Whether this process has served its share and should exit for a fresh start. */
  get exhausted(): boolean {
    return this.#runsServed >= this.#runsPerLife
  }

  /** How many pages the open session's context has: one, whatever its page tried to open. */
  get openPages(): number {
    return this.#current?.context.pages().length ?? 0
  }

  /** How many contexts the browser holds: at most one, the open session's. */
  get openContexts(): number {
    return this.#browser?.isConnected() ? this.#browser.contexts().length : 0
  }

  /** Calls `listener` once, when the runner is exhausted and its last session has been closed or forgotten. */
  whenExhausted(listener: () => void): void {
    this.#exhaustedListeners.push(listener)
  }

  /** Starts the browser, once, with the third layer's switches; a browser that died is started again. */
  async #browserReady(): Promise<Browser> {
    if (this.#browser?.isConnected()) return this.#browser
    const deadEndPort = await this.#deadEnd.start()
    const launch: LaunchOptions = { headless: true, args: [...LAUNCH_ARGS, ...networkWallArgs(this.#options.shopOrigin, deadEndPort)] }
    if (this.#options.executablePath) launch.executablePath = this.#options.executablePath
    const browser = await chromium.launch(launch)
    browser.on('disconnected', () => this.#crashed(browser))
    this.#browser = browser
    return browser
  }

  /** Marks the open session as crashed when the browser it lives in has gone. */
  #crashed(browser: Browser): void {
    if (this.#browser === browser && this.#current) this.#current.crashed = true
  }

  /** The open session, or a refusal. */
  #session(id: string): Session {
    const session = this.#current
    if (!session || session.id !== id) throw new SessionError('no_session', 'There is no such session.')
    if (session.expired) throw new SessionError('expired', 'The session reached its wall clock and was closed.')
    if (session.crashed) throw new SessionError('browser', 'The browser crashed during the run.')
    return session
  }

  /** Opens a session for a run: a fresh context with the bug token in its cookie jar, the sandbox's layers and the collectors attached. */
  async open(request: OpenSessionRequest): Promise<string> {
    if (this.busy) throw new SessionError('busy', 'A run is in the browser. Try again when it has ended.')
    if (this.exhausted) throw new SessionError('exhausted', 'This runner has served its share of runs and is about to restart.')
    // Taken before the first wait, so a second request that arrives while this one opens is refused.
    this.#opening = true
    try {
      const session = await this.#newSession(request)
      this.#current = session
      this.#runsServed += 1
      return session.id
    }
    finally {
      this.#opening = false
    }
  }

  /** Makes the context and the page of a new session. */
  async #newSession(request: OpenSessionRequest): Promise<Session> {
    const browser = await this.#browserReady()
    const context = await browser.newContext({
      viewport: { width: 1_024, height: 768 },
      userAgent: request.engine === 'firefox-ua' ? FIREFOX_USER_AGENT : undefined,
      javaScriptEnabled: true,
      acceptDownloads: false,
      serviceWorkers: 'block',
    })
    try {
      const findings = new FindingCollector(request.engine, this.#options.shopOrigin)
      const shop = new URL(this.#options.shopOrigin)
      if (request.bugToken !== null) {
        await context.addCookies([{ name: this.#options.bugCookie, value: request.bugToken, domain: shop.hostname, path: '/', httpOnly: true, sameSite: 'Lax' }])
      }
      await interceptRequests(context, this.#options.shopOrigin, findings)
      const page = await context.newPage()
      // The session has one window: any other a page opens is closed at once.
      context.on('page', (other) => {
        if (other !== page) void other.close().catch(() => undefined)
      })
      page.on('dialog', dialog => void dialog.dismiss().catch(() => undefined))
      findings.attach(page)
      const id = randomUUID()
      const session: Session = { id, engine: request.engine, context, page, findings, startedAt: Date.now(), expired: false, crashed: false, forget: undefined, timer: setTimeout(() => void this.#expire(id), request.wallClockMs) }
      page.on('crash', () => {
        session.crashed = true
      })
      session.timer.unref()
      return session
    }
    catch (error) {
      await context.close().catch(() => undefined)
      throw error
    }
  }

  /** Closes a session whose wall clock ran out; its findings stay until it is closed by the caller, or until the grace is over and it is forgotten. */
  async #expire(id: string): Promise<void> {
    const session = this.#current
    if (!session || session.id !== id) return
    session.expired = true
    session.forget = setTimeout(() => this.#forget(id), this.#options.expiredGraceMs ?? EXPIRED_GRACE_MS)
    session.forget.unref()
    await session.context.close().catch(() => undefined)
  }

  /** Forgets a session nobody closed, so the browser is free for the next run. */
  #forget(id: string): void {
    if (this.#current?.id !== id) return
    this.#current = undefined
    this.#released()
  }

  /** Says the runner is spent, once, when it is exhausted and holds no session. */
  #released(): void {
    if (!this.exhausted || this.busy || this.#saidExhausted) return
    this.#saidExhausted = true
    for (const listener of this.#exhaustedListeners) listener()
  }

  /** Runs one step in the session. */
  async step(id: string, index: number, step: Lb07Step): Promise<StepResult & { path: string, findings: RunnerFinding[] }> {
    const session = this.#session(id)
    session.findings.stepIndex = index
    const result = await runStep(session.page, step, this.#options.shopOrigin, session.findings)
    // A browser that went away during the step is a crash, not an outcome of the plan.
    this.#session(id)
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
    if (session.forget) clearTimeout(session.forget)
    this.#current = undefined
    await session.context.close().catch(() => undefined)
    this.#released()
    return { findings: session.findings.drain(), offOriginRequests: session.findings.offOrigin, blocked: session.findings.blocked }
  }

  /** Closes everything, for the process's end. */
  async shutdown(): Promise<void> {
    if (this.#current) await this.close(this.#current.id).catch(() => undefined)
    await this.#browser?.close().catch(() => undefined)
    this.#browser = undefined
    await this.#deadEnd.close()
  }
}
