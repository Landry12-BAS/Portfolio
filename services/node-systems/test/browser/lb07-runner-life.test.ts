// The runner's life on a real Chromium over the real shop: one session at a time even when two ask at once; a
// session nobody closes is closed at its wall clock and forgotten after a grace, so the browser is free again; the
// runner says it has served its share only once its last session is closed or forgotten, never while a run is in
// the browser; a browser that dies in the middle of a run is said to have crashed and the next session gets a fresh
// one; and the sandbox process itself, started as its container starts it, exits after its share of runs once the
// last one is closed.
import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { HttpRunner } from '../../src/modules/lb07/runner/client.ts'
import { runnerKeyFrom } from '../../src/modules/lb07/runner/key.ts'
import { BrowserSessions, SessionError } from '../../src/modules/lb07/runner/session.ts'
import { BUG_COOKIE } from '../../src/modules/lb07/shop/token.ts'
import { startShop, TEST_TOKEN_KEY } from '../support/lb07-shop.ts'
import type { RunningShop } from '../support/lb07-shop.ts'

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined
let shop: RunningShop

beforeAll(async () => {
  shop = await startShop()
})

afterAll(() => shop.close())

/** Sessions over the shop with a share of runs and a grace the test chooses, and how often they said they were spent. */
function sessionsFor(runsPerLife: number, expiredGraceMs = 30_000): { sessions: BrowserSessions, spent: { count: number } } {
  const sessions = new BrowserSessions({ shopOrigin: shop.origin, executablePath, runsPerLife, bugCookie: BUG_COOKIE, expiredGraceMs })
  const spent = { count: 0 }
  sessions.whenExhausted(() => {
    spent.count += 1
  })
  return { sessions, spent }
}

/** Waits for a number of milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** A port of the loopback interface that is free now, for a process this test starts. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return port
}

/** A request to open a session, with a wall clock the test chooses. */
function opening(wallClockMs = 30_000) {
  return { runId: 'run-life-0000001', engine: 'chromium' as const, bugToken: null, wallClockMs }
}

describe('the runner\'s sessions', () => {
  it('open one session when two ask at once: the second is told the browser is busy, and no context is left behind', async () => {
    const { sessions } = sessionsFor(10)
    try {
      const results = await Promise.allSettled([sessions.open(opening()), sessions.open(opening())])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const refusal = results.find(result => result.status === 'rejected')
      expect(refusal?.status === 'rejected' ? refusal.reason : undefined).toMatchObject({ code: 'busy' })
      expect(sessions.runsServed).toBe(1)
      expect(sessions.openContexts).toBe(1)
    }
    finally {
      await sessions.shutdown()
    }
  })

  it('close a session nobody closes at its wall clock, and forget it after the grace, so the next run gets the browser', async () => {
    const { sessions } = sessionsFor(10, 500)
    try {
      const forgotten = await sessions.open(opening(1_000))
      await sessions.step(forgotten, 0, { action: 'goto', path: '/' })
      await pause(1_200)
      // Closed, and kept for its caller to collect what it found.
      await expect(sessions.step(forgotten, 1, { action: 'goto', path: '/' })).rejects.toMatchObject({ code: 'expired' })
      expect(sessions.busy).toBe(true)
      await pause(600)
      expect(sessions.busy).toBe(false)
      expect(sessions.openContexts).toBe(0)
      const next = await sessions.open(opening())
      expect((await sessions.step(next, 0, { action: 'goto', path: '/cart' })).outcome).toBe('ok')
      await sessions.close(next)
    }
    finally {
      await sessions.shutdown()
    }
  })

  it('say they have served their share only when the last session is closed, never while a run is in the browser', async () => {
    const { sessions, spent } = sessionsFor(2)
    try {
      await sessions.close(await sessions.open(opening()))
      const last = await sessions.open(opening())
      expect(sessions.exhausted).toBe(true)
      expect(spent.count).toBe(0)
      // The run in flight goes on to its end.
      expect((await sessions.step(last, 0, { action: 'goto', path: '/' })).outcome).toBe('ok')
      expect(spent.count).toBe(0)
      await expect(sessions.open(opening())).rejects.toMatchObject({ code: 'busy' })
      await sessions.close(last)
      expect(spent.count).toBe(1)
      await expect(sessions.open(opening())).rejects.toMatchObject({ code: 'exhausted' })
    }
    finally {
      await sessions.shutdown()
    }
    expect(spent.count).toBe(1)
  })

  it('say so too when the last session is forgotten because its worker died, so the process is not held for ever', async () => {
    const { sessions, spent } = sessionsFor(1, 300)
    try {
      await sessions.open(opening(800))
      await pause(700)
      expect(spent.count).toBe(0)
      await pause(800)
      expect(spent.count).toBe(1)
    }
    finally {
      await sessions.shutdown()
    }
  })

  it('say a browser that died in the middle of a run crashed, and give the next session a fresh one', async () => {
    const { sessions } = sessionsFor(10)
    try {
      const id = await sessions.open(opening())
      await sessions.step(id, 0, { action: 'goto', path: '/' })
      // The browser's main process: a child of this one, started by Playwright.
      const browsers = execFileSync('ps', ['-o', 'pid=,args=', '--ppid', String(process.pid)], { encoding: 'utf8' }).split('\n').filter(line => /chrom/i.test(line) && line.includes('--remote-debugging-pipe'))
      expect(browsers).toHaveLength(1)
      process.kill(Number.parseInt(browsers[0]?.trim() ?? '0', 10), 'SIGKILL')
      await pause(500)
      const error = await sessions.step(id, 1, { action: 'goto', path: '/cart' }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(SessionError)
      expect(error).toMatchObject({ code: 'browser' })
      await sessions.close(id)
      const fresh = await sessions.open(opening())
      expect((await sessions.step(fresh, 0, { action: 'goto', path: '/cart' })).outcome).toBe('ok')
      await sessions.close(fresh)
    }
    finally {
      await sessions.shutdown()
    }
  })
})

describe('the sandbox process', () => {
  let child: ChildProcess | undefined
  afterAll(() => {
    child?.kill('SIGKILL')
  })

  it('serves its share of runs, keeps the last one to its end, exits on its own once it is closed, and writes nothing in its home', async () => {
    const tokenKeyHex = Buffer.from(TEST_TOKEN_KEY).toString('hex')
    // The container's home is on its read-only root: whatever the process or its browser writes must go to the temporary folder.
    const home = mkdtempSync(join(tmpdir(), 'lb07-home-'))
    const [shopPort, runnerPort] = [await freePort(), await freePort()]
    child = spawn(process.execPath, [fileURLToPath(new URL('../../src/sandbox.ts', import.meta.url))], {
      env: { PATH: process.env.PATH, HOME: home, LB07_SHOP_PORT: String(shopPort), LB07_SANDBOX_PORT: String(runnerPort), LB07_SANDBOX_HOST: '127.0.0.1', LB07_SHOP_TOKEN_KEY: tokenKeyHex, LB07_BROWSER_PATH: executablePath ?? '', LB07_RUNS_PER_LIFE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = new Promise<number | null>(resolve => child?.once('exit', code => resolve(code)))
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the sandbox did not start')), 30_000)
      child?.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('lb07 sandbox: the shop on')) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    const runner = new HttpRunner(`http://127.0.0.1:${runnerPort}`, runnerKeyFrom(TEST_TOKEN_KEY))
    const id = await runner.open(opening())
    expect((await runner.health()).exhausted).toBe(true)
    await pause(1_000)
    expect(child.exitCode).toBeNull()
    expect((await runner.step(id, 0, { action: 'goto', path: '/' })).outcome).toBe('ok')
    // The shop it serves sends its own policy.
    expect((await fetch(`http://127.0.0.1:${shopPort}/`)).headers.get('content-security-policy')).toContain('default-src \'self\'')
    await runner.close(id)
    const code = await Promise.race([exited, pause(10_000).then(() => 'still running')])
    expect(code).toBe(0)
    expect(readdirSync(home, { recursive: true })).toEqual([])
    rmSync(home, { recursive: true, force: true })
  })
})
