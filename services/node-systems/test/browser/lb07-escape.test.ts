// LB-07's sandbox against a page that is the enemy, on a real Chromium. The pages come from a hostile stand-in
// for the shop's origin (test/support/lb07-hostile.ts) and aim at a canary on another address of this machine,
// which writes down every request, socket upgrade and UDP packet that reaches it. The real shop is never like
// these pages: they show what holds if it were. The sessions are the runner's own, exactly as the sandbox runs
// them; the tests of each layer alone are in lb07-layers.test.ts.
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Lb07Step } from '@lb/contracts'

import { runnerFindingSchema } from '../../src/modules/lb07/runner/protocol.ts'
import type { RunnerFinding } from '../../src/modules/lb07/runner/protocol.ts'
import { createRunnerServer } from '../../src/modules/lb07/runner/server.ts'
import { BrowserSessions } from '../../src/modules/lb07/runner/session.ts'
import { BUG_COOKIE } from '../../src/modules/lb07/shop/token.ts'
import { startCanary, startHostileShop } from '../support/lb07-hostile.ts'
import type { Canary, HostileShop } from '../support/lb07-hostile.ts'
import { TEST_RUNNER_KEY } from '../support/lb07-runner.ts'

let canary: Canary
let hostile: HostileShop
let sessions: BrowserSessions
let runnerApi: Server
// Every request that reached the runner's own API: the page is pointed at it, and must never get there.
const runnerRequests: string[] = []

beforeAll(async () => {
  canary = await startCanary()
  hostile = await startHostileShop(canary)
  sessions = new BrowserSessions({ shopOrigin: hostile.origin, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, runsPerLife: 1_000, bugCookie: BUG_COOKIE })
  runnerApi = createRunnerServer({ sessions, key: TEST_RUNNER_KEY })
  runnerApi.on('request', (request: IncomingMessage) => void runnerRequests.push(`${request.method} ${request.url}`))
  await new Promise<void>(resolve => runnerApi.listen(0, '127.0.0.1', resolve))
  hostile.runnerUrl = `http://127.0.0.1:${(runnerApi.address() as AddressInfo).port}`
})

afterAll(async () => {
  await sessions.shutdown()
  await new Promise<void>(resolve => runnerApi.close(() => resolve()))
  await hostile.close()
  await canary.close()
})

beforeEach(() => {
  canary.reset()
})

/** Waits for a number of milliseconds, for what a page's scripts do after it has loaded. */
function settle(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Runs steps in a fresh session, waits for the pages' scripts, closes it, and returns what it found. */
async function inSession(steps: readonly Lb07Step[], settleMs = 1_500): Promise<{ outcomes: string[], findings: RunnerFinding[], blocked: number, offOrigin: number }> {
  const id = await sessions.open({ runId: 'run-escape-0001', engine: 'chromium', bugToken: null, wallClockMs: 60_000 })
  const outcomes: string[] = []
  const findings: RunnerFinding[] = []
  for (const [index, step] of steps.entries()) {
    const answer = await sessions.step(id, index, step)
    outcomes.push(answer.outcome)
    findings.push(...answer.findings)
  }
  await settle(settleMs)
  const closed = await sessions.close(id)
  findings.push(...closed.findings)
  return { outcomes, findings, blocked: closed.blocked, offOrigin: closed.offOriginRequests }
}

/** The details of the blocked-navigation findings. */
function blockedDetails(findings: readonly RunnerFinding[]): string[] {
  return findings.filter(finding => finding.kind === 'blocked_navigation').map(finding => finding.detail)
}

describe('a page that tries every way out', () => {
  it('reaches nothing outside the shop: no request, socket, stream, beacon, module, frame, worker, prefetch, window or STUN packet arrives, and the runner\'s own API hears nothing', async () => {
    const run = await inSession([{ action: 'goto', path: '/escape' }], 3_000)
    expect(canary.hits).toEqual([])
    expect(canary.udpPackets()).toBe(0)
    expect(runnerRequests).toEqual([])
    expect(run.offOrigin).toBe(0)
    // Every refusal is a finding that names where the page tried to go by its scheme and host, never its path or query.
    expect(run.blocked).toBeGreaterThanOrEqual(5)
    const details = blockedDetails(run.findings)
    expect(details.some(detail => detail.includes(`http://${canary.host}:${canary.port}`))).toBe(true)
    expect(details.some(detail => detail.includes(`ws://${canary.host}:${canary.port}`))).toBe(true)
    for (const detail of details) expect(detail).not.toMatch(/secret|\/fetch|\/ws\b|\/beacon/)
    for (const finding of run.findings) expect(() => runnerFindingSchema.parse(finding)).not.toThrow()
  })

  it.each([
    ['a redirect from the shop', [{ action: 'goto', path: '/redirect' }], 'A redirect to'],
    ['a refresh to another host', [{ action: 'goto', path: '/refresh' }], 'A request to'],
    ['a form that posts to another host', [{ action: 'goto', path: '/form' }, { action: 'click', role: 'button', name: 'Send' }], 'A request to'],
    ['a link whose script swaps its target after the check', [{ action: 'goto', path: '/swap' }, { action: 'click', role: 'link', name: 'Next page' }], 'A request to'],
  ] as [string, Lb07Step[], string][])('follows no %s, and records it', async (_name, steps, words) => {
    const run = await inSession(steps)
    expect(canary.hits).toEqual([])
    expect(run.offOrigin).toBe(0)
    expect(run.blocked).toBeGreaterThanOrEqual(1)
    const details = blockedDetails(run.findings)
    expect(details.some(detail => detail.startsWith(`${words} http://${canary.host}:${canary.port} was refused`)), details.join(' | ')).toBe(true)
    for (const detail of details) expect(detail).not.toMatch(/secret|redirected|refreshed|posted|swapped/)
  })

  it('keeps one page open however many windows a page opens', async () => {
    const id = await sessions.open({ runId: 'run-escape-0002', engine: 'chromium', bugToken: null, wallClockMs: 60_000 })
    await sessions.step(id, 0, { action: 'goto', path: '/bomb' })
    await settle(1_500)
    expect(sessions.openPages).toBe(1)
    expect((await sessions.step(id, 1, { action: 'expectText', text: 'Windows' })).outcome).toBe('ok')
    await sessions.close(id)
  })

  it('turns a page\'s forged axe answer into findings that fit the protocol, and stays usable', async () => {
    const id = await sessions.open({ runId: 'run-escape-0003', engine: 'chromium', bugToken: null, wallClockMs: 60_000 })
    await sessions.step(id, 0, { action: 'goto', path: '/axe-trap' })
    const axe = await sessions.axe(id, 0)
    for (const finding of axe.findings) {
      expect(() => runnerFindingSchema.parse(finding)).not.toThrow()
      expect(finding.title).toMatch(/^Accessibility: [a-z0-9-]+ \((?:minor|moderate|serious|critical|unknown) impact\)$/)
    }
    expect((await sessions.step(id, 1, { action: 'expectText', text: 'Trap' })).outcome).toBe('ok')
    await sessions.close(id)
  })

  it('bounds what a huge page gives back, and gives up on a page that never answers or that is a download, without losing the session', async () => {
    const id = await sessions.open({ runId: 'run-escape-0004', engine: 'chromium', bugToken: null, wallClockMs: 90_000 })
    expect((await sessions.step(id, 0, { action: 'goto', path: '/huge' })).outcome).toBe('ok')
    const snapshot = await sessions.snapshot(id)
    expect(snapshot.text.length).toBeLessThanOrEqual(6_000)
    const shot = await sessions.screenshot(id)
    expect(Buffer.from(shot.base64, 'base64').byteLength).toBeLessThanOrEqual(400_000)
    expect((await sessions.step(id, 1, { action: 'goto', path: '/never' })).outcome).toBe('timeout')
    expect(['error', 'ok']).toContain((await sessions.step(id, 2, { action: 'goto', path: '/download' })).outcome)
    expect((await sessions.step(id, 3, { action: 'goto', path: '/' })).outcome).toBe('ok')
    await sessions.close(id)
  })
})
