// A runner that is a script, for the tests of the agent and the engine that need no browser: each step
// gets the outcome and the findings the test scripted for it (every step passes with no findings unless
// told otherwise), axe answers what the test queued for a path, and the snapshot is a fixed text. It
// records every call so a test can say what the agent asked of the browser, pass by pass.
import type { Lb07Engine, Lb07Step } from '@lb/contracts'

import type { Runner } from '../../src/modules/lb07/runner/client.ts'
import { RunnerError } from '../../src/modules/lb07/runner/client.ts'
import type { CloseResponse, HealthResponse, RunnerFinding, StepOutcome, StepResponse } from '../../src/modules/lb07/runner/protocol.ts'

/** What a scripted step answers: its outcome, and the findings the runner "made" on it. */
export interface ScriptedStep {
  outcome?: StepOutcome
  findings?: Omit<RunnerFinding, 'engine' | 'stepIndex'>[]
}

/** Decides what a step answers from the step itself, the engine and whether the bugs are on. */
export type StepScript = (step: Lb07Step, context: { engine: Lb07Engine, bugsOn: boolean, index: number }) => ScriptedStep | undefined

/** One session the fake runner opened. */
export interface FakeSession {
  id: string
  engine: Lb07Engine
  bugToken: string | null
  steps: { index: number, step: Lb07Step }[]
  closed: boolean
  axeRuns: number
}

/** The fake runner. */
export class FakeRunner implements Runner {
  readonly sessions: FakeSession[] = []
  // What the next `open` answers with instead of a session, once each.
  readonly openFailures: RunnerError[] = []
  // Axe findings by path, for a `goto` to that path and the end-of-pass run; given once per pass.
  readonly axeFindings = new Map<string, Omit<RunnerFinding, 'engine' | 'stepIndex'>[]>()
  snapshotText = 'heading "Basalt & Bean shop" button "Add Ethiopia Guji to cart"'
  screenshotBase64 = Buffer.from('png').toString('base64')
  #script: StepScript
  #current: FakeSession | undefined
  #count = 0

  /** Starts with a script; the default passes every step. */
  constructor(script: StepScript = () => undefined) {
    this.#script = script
  }

  /** Replaces the script. */
  set script(script: StepScript) {
    this.#script = script
  }

  /** The runner's health. */
  async health(): Promise<HealthResponse> {
    return { ok: true, busy: this.#current !== undefined, runsServed: this.#count, exhausted: false }
  }

  /** Opens a session, or fails as scripted. */
  async open(request: { runId: string, engine: Lb07Engine, bugToken: string | null, wallClockMs: number }): Promise<string> {
    const failure = this.openFailures.shift()
    if (failure) throw failure
    if (this.#current) throw new RunnerError('busy', 'busy')
    this.#count += 1
    const session: FakeSession = { id: `fake-session-${this.#count.toString().padStart(4, '0')}`, engine: request.engine, bugToken: request.bugToken, steps: [], closed: false, axeRuns: 0 }
    this.sessions.push(session)
    this.#current = session
    return session.id
  }

  /** The open session, or a refusal. */
  #session(id: string): FakeSession {
    if (!this.#current || this.#current.id !== id) throw new RunnerError('refused', 'no such session')
    return this.#current
  }

  /** Runs one step as scripted. */
  async step(sessionId: string, index: number, step: Lb07Step): Promise<StepResponse> {
    const session = this.#session(sessionId)
    session.steps.push({ index, step })
    const scripted = this.#script(step, { engine: session.engine, bugsOn: session.bugToken !== null, index }) ?? {}
    const outcome = scripted.outcome ?? 'ok'
    const path = step.action === 'goto' ? step.path : '/cart'
    return { outcome, durationMs: 12, path, findings: (scripted.findings ?? []).map(finding => ({ ...finding, engine: session.engine, stepIndex: index })) }
  }

  /** The fixed snapshot. */
  async snapshot(sessionId: string): Promise<{ text: string, path: string }> {
    this.#session(sessionId)
    return { text: this.snapshotText, path: '/cart' }
  }

  /** The fixed screenshot. */
  async screenshot(sessionId: string): Promise<{ base64: string, path: string }> {
    this.#session(sessionId)
    return { base64: this.screenshotBase64, path: '/cart' }
  }

  /** Axe: the findings queued for the page's path, only when the bugs are on. */
  async axe(sessionId: string, index: number | null): Promise<{ findings: RunnerFinding[], path: string }> {
    const session = this.#session(sessionId)
    session.axeRuns += 1
    const last = session.steps.findLast(entry => entry.step.action === 'goto')
    const path = last?.step.action === 'goto' ? last.step.path : '/'
    const findings = session.bugToken === null ? [] : (this.axeFindings.get(path) ?? []).map(finding => ({ ...finding, engine: session.engine, stepIndex: index }))
    return { findings, path }
  }

  /** Closes the session. */
  async close(sessionId: string): Promise<CloseResponse> {
    const session = this.#session(sessionId)
    session.closed = true
    this.#current = undefined
    return { findings: [], offOriginRequests: 0, blocked: session.steps.filter(entry => entry.step.action === 'click' && entry.step.role === 'link' && entry.step.name.includes('weather')).length }
  }
}

/** A step script that makes a bug's finding when its bugs are on: the expectation that fails, the console error, the failed request. */
export function bugScript(bugs: readonly string[]): StepScript {
  return (step, context) => {
    if (!context.bugsOn) return undefined
    if (step.action === 'expectText' && step.text.startsWith('Total') && bugs.includes('coupon-twice')) {
      return { outcome: 'expectation', findings: [{ kind: 'expectation_failed', title: 'The page does not say what was expected', detail: `expected "${step.text}"; the page says "Total €23.20"`, rule: null, path: '/cart' }] }
    }
    if (step.action === 'expectText' && /\d items?$/.test(step.text) && bugs.includes('cart-off-by-one')) {
      return { outcome: 'expectation', findings: [{ kind: 'expectation_failed', title: 'The page does not say what was expected', detail: `expected "${step.text}"; the page says "3 items"`, rule: null, path: '/cart' }] }
    }
    if (((step.action === 'goto' && step.path === '/checkout') || (step.action === 'click' && step.name === 'Go to checkout')) && bugs.includes('script-error')) {
      return { findings: [{ kind: 'console_error', title: 'The page threw an error', detail: 'TypeError: Cannot set properties of null', rule: null, path: '/checkout' }] }
    }
    if (step.action === 'goto' && step.path === '/' && bugs.includes('broken-image')) {
      return { findings: [{ kind: 'failed_request', title: 'A request was answered with 404', detail: 'GET /images/hero-missing.svg was answered with 404.', rule: null, path: '/images/hero-missing.svg' }] }
    }
    if (step.action === 'click' && step.name === 'Place order' && bugs.includes('checkout-engine') && context.engine === 'firefox-ua') {
      return { findings: [{ kind: 'failed_request', title: 'A request was answered with 500', detail: 'POST /checkout was answered with 500 (a page).', rule: null, path: '/checkout' }] }
    }
    return undefined
  }
}
