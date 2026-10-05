// What the browser tests of LB-07 share: the runner's sessions and server started on a free port of this
// machine over a shop started the same way, the real Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE, or
// Playwright's own), and the client the service uses, so a test drives the runner exactly as the worker does.
import type { AddressInfo } from 'node:net'

import type { Lb07Engine, Lb07Step } from '@lb/contracts'

import { HttpRunner } from '../../src/modules/lb07/runner/client.ts'
import { runnerKeyFrom } from '../../src/modules/lb07/runner/key.ts'
import type { RunnerFinding, StepResponse } from '../../src/modules/lb07/runner/protocol.ts'
import { createRunnerServer } from '../../src/modules/lb07/runner/server.ts'
import { BrowserSessions } from '../../src/modules/lb07/runner/session.ts'
import { BUG_COOKIE } from '../../src/modules/lb07/shop/token.ts'
import { startShop, TEST_TOKEN_KEY } from './lb07-shop.ts'
import type { RunningShop } from './lb07-shop.ts'

/** A runner and a shop, running, and the client to the runner. */
export interface RunnerHarness {
  shop: RunningShop
  runner: HttpRunner
  // The runner's own address.
  url: string
  sessions: BrowserSessions
  exhaustedCalls: number
  close: () => Promise<void>
}

/** The runner's key in the tests: the one the test bug-token key gives, as in the sandbox. */
export const TEST_RUNNER_KEY = runnerKeyFrom(TEST_TOKEN_KEY)

/** Starts a shop, the sessions over it and the runner's server, with a share of runs and a grace for forgotten sessions the test chooses. */
export async function startRunnerHarness(runsPerLife = 100, expiredGraceMs?: number): Promise<RunnerHarness> {
  const shop = await startShop()
  const sessions = new BrowserSessions({ shopOrigin: shop.origin, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, runsPerLife, bugCookie: BUG_COOKIE, expiredGraceMs })
  const harness: RunnerHarness = { shop, sessions, exhaustedCalls: 0, runner: new HttpRunner('', TEST_RUNNER_KEY), url: '', close: async () => {} }
  const server = createRunnerServer({
    sessions,
    key: TEST_RUNNER_KEY,
    onExhausted: () => {
      harness.exhaustedCalls += 1
    },
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  harness.url = `http://127.0.0.1:${port}`
  harness.runner = new HttpRunner(harness.url, TEST_RUNNER_KEY)
  harness.close = async () => {
    await sessions.shutdown()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await shop.close()
  }
  return harness
}

/** What one whole plan came to in the runner: every step's answer, every finding, and the sandbox's counts. */
export interface PlanRun {
  steps: StepResponse[]
  findings: RunnerFinding[]
  offOriginRequests: number
  blocked: number
}

/** Runs a whole plan in one session, as the worker does for a verification pass: axe after each page opened and at the end, then the session closed. */
export async function runPlan(runner: HttpRunner, plan: readonly Lb07Step[], options: { bugToken: string | null, engine?: Lb07Engine, runId?: string, wallClockMs?: number, axe?: boolean }): Promise<PlanRun> {
  const sessionId = await runner.open({ runId: options.runId ?? 'run-0123456789', engine: options.engine ?? 'chromium', bugToken: options.bugToken, wallClockMs: options.wallClockMs ?? 120_000 })
  const steps: StepResponse[] = []
  const findings: RunnerFinding[] = []
  let failure: unknown
  try {
    for (const [index, step] of plan.entries()) {
      const answer = await runner.step(sessionId, index, step)
      steps.push(answer)
      findings.push(...answer.findings)
      if ((options.axe ?? true) && step.action === 'goto' && answer.outcome === 'ok') findings.push(...(await runner.axe(sessionId, index)).findings)
      // As the engine does: a step that would have left the shop ends the plan, and the steps after it are not run.
      if (answer.outcome === 'blocked') break
    }
    if (options.axe ?? true) findings.push(...(await runner.axe(sessionId, null)).findings)
  }
  catch (error) {
    failure = error
  }
  const closed = await runner.close(sessionId)
  if (failure !== undefined) throw failure
  findings.push(...closed.findings)
  return { steps, findings, offOriginRequests: closed.offOriginRequests, blocked: closed.blocked }
}
