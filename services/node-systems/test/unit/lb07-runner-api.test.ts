// The runner's API as a third layer of its own, and the worker's client as a careful reader of it. The API
// answers its health to anyone and everything else only to a caller that shows the worker's key, which a page of
// the browser never has; it refuses before it reads a body or touches the browser. The client shows the key, reads
// no answer larger than the largest honest one, and tells a crashed browser apart so the run is tried again.
// Nothing here starts a browser: the sessions are never opened.
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { reactionTo } from '../../src/modules/lb07/engine/failures.ts'
import { HttpRunner, RunnerError } from '../../src/modules/lb07/runner/client.ts'
import { keyMatches, RUNNER_KEY_HEADER, runnerKeyFrom } from '../../src/modules/lb07/runner/key.ts'
import { createRunnerServer } from '../../src/modules/lb07/runner/server.ts'
import { BrowserSessions } from '../../src/modules/lb07/runner/session.ts'
import { BUG_COOKIE } from '../../src/modules/lb07/shop/token.ts'
import { TEST_TOKEN_KEY } from '../support/lb07-shop.ts'

const KEY = runnerKeyFrom(TEST_TOKEN_KEY)

/** Starts a server on a free port of this machine and returns its address. */
async function listening(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('the runner\'s key', () => {
  it('is derived from the bug-token key, is not that key, and differs for another key', () => {
    expect(KEY).toMatch(/^[0-9a-f]{64}$/)
    expect(KEY).not.toBe(Buffer.from(TEST_TOKEN_KEY).toString('hex'))
    expect(runnerKeyFrom(new Uint8Array(32).fill(9))).not.toBe(KEY)
    expect(runnerKeyFrom(TEST_TOKEN_KEY)).toBe(KEY)
  })

  it('matches only itself, written as 64 hex digits', () => {
    expect(keyMatches(KEY, KEY)).toBe(true)
    for (const given of [undefined, '', KEY.toUpperCase(), `${KEY}0`, KEY.slice(1), [KEY, KEY], `${KEY.slice(0, -1)}${KEY.endsWith('0') ? '1' : '0'}`]) expect(keyMatches(KEY, given)).toBe(false)
  })
})

describe('the runner\'s API', () => {
  const sessions = new BrowserSessions({ shopOrigin: 'http://127.0.0.1:8007', runsPerLife: 5, bugCookie: BUG_COOKIE })
  const server = createRunnerServer({ sessions, key: KEY })
  let url = ''
  beforeAll(async () => {
    url = await listening(server)
  })
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

  it('answers its health to anyone, and nothing else to a caller without the key: no session is opened', async () => {
    expect((await fetch(`${url}/healthz`)).status).toBe(200)
    const body = JSON.stringify({ runId: 'run-from-a-page', engine: 'chromium', bugToken: null, wallClockMs: 5_000 })
    const attempts: [string, RequestInit][] = [
      ['/sessions', { method: 'POST', body, headers: { 'content-type': 'application/json' } }],
      ['/sessions', { method: 'POST', body, headers: { 'content-type': 'text/plain' } }],
      ['/sessions', { method: 'POST', body, headers: { [RUNNER_KEY_HEADER]: 'f'.repeat(64) } }],
      ['/sessions/0123456789abcdef/steps', { method: 'POST', body: '{}', headers: { [RUNNER_KEY_HEADER]: KEY.toUpperCase() } }],
      ['/sessions/0123456789abcdef', { method: 'DELETE' }],
      ['/sessions/0123456789abcdef/snapshot', { method: 'GET' }],
    ]
    for (const [path, init] of attempts) {
      const response = await fetch(`${url}${path}`, init)
      expect(response.status, path).toBe(401)
      expect(await response.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } })
    }
    expect(sessions.busy).toBe(false)
    expect(sessions.runsServed).toBe(0)
  })

  it('checks every body against the protocol before it looks for a session: an axe request with an index no plan has is malformed', async () => {
    for (const body of [{ index: 1e308 }, { index: -1 }, { index: 'first' }, { index: 1, extra: true }, {}]) {
      const response = await fetch(`${url}/sessions/0123456789abcdef/axe`, { method: 'POST', body: JSON.stringify(body), headers: { [RUNNER_KEY_HEADER]: KEY, 'content-type': 'application/json' } })
      expect(response.status, JSON.stringify(body)).toBe(422)
    }
    const fine = await fetch(`${url}/sessions/0123456789abcdef/axe`, { method: 'POST', body: JSON.stringify({ index: null }), headers: { [RUNNER_KEY_HEADER]: KEY, 'content-type': 'application/json' } })
    expect(fine.status).toBe(404)
  })

  it('refuses to be built without a key of the right form', () => {
    expect(() => createRunnerServer({ sessions, key: 'short' })).toThrow(RangeError)
  })
})

describe('the worker\'s client', () => {
  /** A stand-in runner that answers every call with what the test chooses, and remembers the key it was shown. */
  function standIn(answer: (path: string) => { status: number, body: string, length?: number }) {
    const seen: (string | undefined)[] = []
    const server = createServer((request, response) => {
      seen.push(request.headers[RUNNER_KEY_HEADER] as string | undefined)
      const { status, body, length } = answer(request.url ?? '/')
      response.writeHead(status, { 'content-type': 'application/json', ...(length === undefined ? {} : { 'content-length': String(length) }) })
      response.end(body)
    })
    return { server, seen }
  }

  it('shows the key with every call', async () => {
    const { server, seen } = standIn(() => ({ status: 200, body: JSON.stringify({ ok: true, busy: false, runsServed: 0, exhausted: false }) }))
    const runner = new HttpRunner(await listening(server), KEY)
    try {
      await runner.health()
      expect(seen).toEqual([KEY])
    }
    finally {
      server.close()
    }
  })

  it('refuses an answer larger than any honest one without reading it to its end, whether it says so or not', async () => {
    const total = 64 * 1_048_576
    const chunk = Buffer.alloc(65_536, 'x')
    for (const declared of [true, false]) {
      let written = 0
      // A runner gone wrong: it streams 64 MB as fast as the reader takes them, and stops when the reader hangs up.
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json', ...(declared ? { 'content-length': String(total) } : {}) })
        const pump = (): void => {
          while (written < total && !response.destroyed) {
            written += chunk.length
            if (!response.write(chunk)) {
              response.once('drain', pump)
              return
            }
          }
          if (written >= total) response.end()
        }
        pump()
      })
      const runner = new HttpRunner(await listening(server), KEY)
      try {
        await expect(runner.health()).rejects.toMatchObject({ name: 'RunnerError', code: 'bad_answer' })
        await new Promise(resolve => setTimeout(resolve, 100))
        // The reader hung up near the limit: what the socket's buffers held besides, far from the 64 MB a reader of everything takes.
        expect(written, declared ? 'declared' : 'streamed').toBeLessThan(16 * 1_048_576)
      }
      finally {
        server.closeAllConnections()
        server.close()
      }
    }
  })

  it('tells a browser that crashed apart from a refusal, and the engine tries such a run again', async () => {
    const { server } = standIn(() => ({ status: 500, body: JSON.stringify({ error: { code: 'browser', message: 'The browser crashed during the run.' } }) }))
    const runner = new HttpRunner(await listening(server), KEY)
    try {
      const error = await runner.snapshot('0123456789abcdef').catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(RunnerError)
      expect(error).toMatchObject({ code: 'crashed' })
      expect(reactionTo(error)).toEqual({ kind: 'retry', retryAfterSeconds: undefined })
      expect(reactionTo(new RunnerError('refused', 'no'))).toEqual({ kind: 'fail', code: 'internal' })
    }
    finally {
      server.close()
    }
  })
})
