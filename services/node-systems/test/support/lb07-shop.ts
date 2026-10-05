// What LB-07's tests share about the staging shop: a shop started on a free port of this machine with a
// throwaway key, a client that keeps cookies as a browser does, and a signed bug token for a run.
import type { AddressInfo } from 'node:net'

import type { Lb07BugId } from '@lb/contracts'

import { createShopServer } from '../../src/modules/lb07/shop/server.ts'
import { BUG_COOKIE, signBugToken, TOKEN_LIFETIME_MS } from '../../src/modules/lb07/shop/token.ts'

/** A throwaway key: 32 bytes, the same in every test. */
export const TEST_TOKEN_KEY = new Uint8Array(32).map((_, index) => index * 7 + 1)

/** A running shop and how to reach it. */
export interface RunningShop {
  origin: string
  port: number
  close: () => Promise<void>
}

/** Starts the shop on a free port, with the test key and, when given, a clock. */
export async function startShop(now: () => Date = () => new Date()): Promise<RunningShop> {
  const server = createShopServer({ tokenKey: TEST_TOKEN_KEY, now })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  }
}

/** Makes a signed bug token for a run, good from `now`. */
export function tokenFor(bugs: readonly Lb07BugId[], runId = 'run-0123456789', now = Date.now()): string {
  return signBugToken(TEST_TOKEN_KEY, { runId, bugs: [...bugs], exp: now + TOKEN_LIFETIME_MS })
}

/** A client that holds cookies between requests, as a browser does, and follows the shop's redirects. */
export class ShopClient {
  readonly #origin: string
  readonly #cookies = new Map<string, string>()
  readonly #userAgent: string

  /** Starts with the bug token as the runner would set it, when one is given. */
  constructor(origin: string, bugToken?: string, userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36') {
    this.#origin = origin
    this.#userAgent = userAgent
    if (bugToken) this.#cookies.set(BUG_COOKIE, bugToken)
  }

  /** Remembers the cookies an answer set. */
  #take(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';')[0] ?? ''
      const separator = pair.indexOf('=')
      if (separator > 0) this.#cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
    }
  }

  /** The cookie header to send. */
  #cookieHeader(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  /** GETs a path and returns the status and the page's text. */
  async get(path: string): Promise<{ status: number, text: string }> {
    const response = await fetch(`${this.#origin}${path}`, { headers: { 'cookie': this.#cookieHeader(), 'user-agent': this.#userAgent }, redirect: 'manual' })
    this.#take(response)
    return { status: response.status, text: await response.text() }
  }

  /** POSTs a form and follows the redirect it answers with, returning the page it lands on. */
  async post(path: string, form: Record<string, string>): Promise<{ status: number, text: string, location: string | null }> {
    const response = await fetch(`${this.#origin}${path}`, {
      method: 'POST',
      headers: { 'cookie': this.#cookieHeader(), 'content-type': 'application/x-www-form-urlencoded', 'user-agent': this.#userAgent },
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
    })
    this.#take(response)
    const location = response.headers.get('location')
    if (response.status === 303 && location) {
      const landed = await this.get(location)
      return { ...landed, location }
    }
    return { status: response.status, text: await response.text(), location }
  }
}
