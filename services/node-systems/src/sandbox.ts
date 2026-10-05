// LB-07's sandbox as a process: the one process on the platform that drives a browser, in a container of
// its own on the sandbox network (infra/docker-compose.yml, lb07-sandbox). It holds two servers:
//
//   - the staging shop (src/modules/lb07/shop), on the loopback interface only, which is the one place
//     the browser may go;
//   - the runner (src/modules/lb07/runner), on the container's own network address, which the service's
//     worker calls to open a session, run a step, read the page and close the session.
//
// Why one process and not two containers: the box's memory budget. Measured on an x86 machine with
// scripts/lb07-memory.ts (README, "LB-07: what a run costs in memory"), the process alone is about 125 MiB
// as a cgroup charges it (180 MiB RSS; Playwright's library is most of it), and the whole tree with the
// browser peaks at about 365 MiB charged (550 to 575 MiB summed PSS) on the heaviest golden case; a second
// Node runtime for the shop alone would cost about another 110 MiB. The shop in the same process adds a few
// megabytes. What the two share is harmless: the shop's only secret is the key that verifies bug tokens, and
// a process that could forge them could only switch on bugs in its own shop. The browser cannot reach the
// runner's API: the plan's check, interception and the browser's own network all refuse any address but the
// shop's (runner/network.ts), and the API answers nothing but its health without the worker's key, which is
// derived from the token key (runner/key.ts).
//
//   just lb07-sandbox          (development)
//   node src/sandbox.ts        (production)
//
// Settings: LB07_SANDBOX_PORT (default 8008) and LB07_SANDBOX_HOST (the container's own address by
// default, 127.0.0.1 for development), LB07_SHOP_PORT (default 8007, loopback only), LB07_SHOP_TOKEN_KEY
// (the key the service signs bug tokens with, as hex; the runner's key comes from it), LB07_BROWSER_PATH (a
// Chromium to start; Playwright's own when empty), LB07_RUNS_PER_LIFE (default 20: the process exits after
// that many browser sessions, and a run opens one to three of them, one for each pass).
import { lookup } from 'node:dns/promises'
import type { Server } from 'node:http'
import { hostname } from 'node:os'

import { LB07_LIMITS } from '@lb/contracts'

import { runnerKeyFrom } from './modules/lb07/runner/key.ts'
import { createRunnerServer } from './modules/lb07/runner/server.ts'
import { BrowserSessions } from './modules/lb07/runner/session.ts'
import { createShopServer } from './modules/lb07/shop/server.ts'
import { BUG_COOKIE, tokenKeyFromHex } from './modules/lb07/shop/token.ts'

/** Reads a port setting. */
function portSetting(name: string, fallback: number): number {
  const port = Number(process.env[name]?.trim() || String(fallback))
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be a port number.`)
  return port
}

/** The address the runner's API listens on: the setting, or the container's own network address. */
async function runnerHost(): Promise<string> {
  const setting = process.env.LB07_SANDBOX_HOST?.trim()
  if (setting) return setting
  const { address } = await lookup(hostname(), { family: 4 })
  return address
}

/** Starts a server and waits until it listens. */
function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })
}

const shopPort = portSetting('LB07_SHOP_PORT', 8007)
const runnerPort = portSetting('LB07_SANDBOX_PORT', 8008)
const keyHex = process.env.LB07_SHOP_TOKEN_KEY?.trim()
if (!keyHex) throw new Error('LB07_SHOP_TOKEN_KEY is required: the key the bug tokens are signed with, as hex.')
const tokenKey = tokenKeyFromHex(keyHex)
// The key is read once; nothing else in the process should find it in the environment.
delete process.env.LB07_SHOP_TOKEN_KEY
const runsPerLife = Number(process.env.LB07_RUNS_PER_LIFE?.trim() || String(LB07_LIMITS.runsPerRunnerLife))
if (!Number.isInteger(runsPerLife) || runsPerLife < 1 || runsPerLife > 1_000) throw new Error('LB07_RUNS_PER_LIFE must be a whole number from 1 to 1000.')

const shopOrigin = `http://127.0.0.1:${shopPort}`
const shop = createShopServer({ tokenKey })
const sessions = new BrowserSessions({ shopOrigin, executablePath: process.env.LB07_BROWSER_PATH?.trim() || undefined, runsPerLife, bugCookie: BUG_COOKIE })

/** Closes the browser and both servers, then exits. */
async function shutDown(code: number): Promise<void> {
  runner.close()
  shop.close()
  await sessions.shutdown()
  process.exit(code)
}

// After its share of runs the process exits once the last session is closed (or, when its worker never closed it,
// forgotten after its wall clock and a grace); Compose starts a fresh one. A run still in the browser is never cut short.
const runner = createRunnerServer({
  sessions,
  key: runnerKeyFrom(tokenKey),
  onExhausted: () => {
    console.log('lb07 sandbox has served its share of runs and is restarting')
    setTimeout(() => void shutDown(0), 500).unref()
  },
})

await listen(shop, shopPort, '127.0.0.1')
const host = await runnerHost()
await listen(runner, runnerPort, host)
console.log(`lb07 sandbox: the shop on ${shopOrigin} (loopback), the runner's API on ${host}:${runnerPort}`)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void shutDown(0))
