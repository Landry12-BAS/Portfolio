// Integration tests for the proxy that forwards the browser's calls to the back ends: only what
// the three OpenAPI documents describe is forwardable, the visitor is known to the back end only
// by a token this server made, nothing of the visitor's request but the JSON body goes along, and
// nothing of the back end's answer but a status, a JSON body and Retry-After comes back. Each
// test is a way a request, or a back end, could go wrong, answered in the platform's error shape.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { API_ROUTES } from '@lb/api-clients/routes'
import { OpenApiDocuments, startMockBackend } from '@lb/api-clients/testing'
import type { MockBackend } from '@lb/api-clients/testing'
import { verifyVisitorToken, loadPublicKey } from '@lb/common/visitors'

import { Browser } from '../support/browser.ts'
import { rawRequest } from '../support/raw.ts'
import { makeTestKeys, startTestSite } from '../support/site-app.ts'
import type { TestSite } from '../support/site-app.ts'

const keys = makeTestKeys()
const documents = new OpenApiDocuments()
// One clock for the site and the back end, so a token the site stamps is read at the same moment.
const clock = { now: Date.UTC(2026, 9, 5, 9, 0, 0) }
let mock: MockBackend
let site: TestSite

beforeAll(async () => {
  mock = await startMockBackend({ siteKey: keys.sitePublic, webKey: keys.webPublic, now: () => clock.now })
  // A short deadline for LB-01, so a slow back end is a quick test.
  site = await startTestSite({ keys, backendUrl: mock.url, clock, policies: { 'lb-01': { timeoutMs: 400 } } })
})

afterAll(async () => {
  await site.close()
  await mock.close()
})

beforeEach(() => {
  mock.reset()
  site.clock.now = Date.UTC(2026, 9, 5, 9, 0, 0)
})

/** A browser that has passed the Turnstile check. */
async function verified(): Promise<Browser> {
  const browser = new Browser(site)
  expect((await browser.verify()).status).toBe(200)
  return browser
}

/** The sample ticket the LB-01 routes take. */
const TICKET = { customer: 'cus-0001', language: 'en', body: 'Hi, my order BB-1040 came a few days ago and one of the two bags was ripped open.' }

describe('what is forwarded', () => {
  it('is every method and path the documents describe, to the same method and path on the back end', async () => {
    const browser = await verified()

    for (const route of API_ROUTES) {
      mock.reset()
      const operation = documents.operations.find(candidate => candidate.method === route.method && candidate.template === route.path)!
      const path = route.path.replace(/\{\w+\}/g, 'abc12345')
      const body = documents.exampleRequest(operation)
      const reply = await browser.request(route.method, path, { body })

      expect(Object.keys(operation.operation.responses ?? {}).map(Number), `${route.method} ${path} answered ${reply.status}`).toContain(reply.status)
      expect(mock.requests.map(sent => `${sent.method} ${sent.path}`), route.path).toEqual([`${route.method} ${path}`])
    }
  })

  it('is nothing the documents do not describe: health checks, other systems, other methods, other paths', async () => {
    const browser = await verified()
    const refused: [string, string][] = [
      ['GET', '/api/healthz'], ['GET', '/api/readyz'], ['GET', '/api/openapi.json'], ['GET', '/api/lb01'], ['GET', '/api/lb01/'], ['GET', '/api/lb01/nothing'],
      ['GET', '/api/lb03/anything'], ['GET', '/api/lb99/customers'], ['DELETE', '/api/lb01/customers'], ['PUT', '/api/lb01/tickets'], ['PATCH', '/api/lb08/workflows/abc12345'],
      ['POST', '/api/lb01/customers'], ['GET', '/api/lb01/tickets/abc12345/decision'], ['GET', '/api/lb01/tickets/abc12345/'], ['GET', '/api/LB01/customers'],
      ['GET', '/api/lb01/tickets/abc12345/extra'], ['GET', '/api/lb02/ws'], ['GET', '/api/runs/x/events'], ['GET', '/api/'], ['GET', '/api'], ['GET', '/api/nothing'],
    ]

    for (const [method, path] of refused) {
      const reply = await browser.request(method, path, { body: method === 'GET' ? undefined : {} })
      expect(reply.status, `${method} ${path}`).toBe(404)
      expect(reply.json).toEqual({ error: { code: 'not_found', message: expect.any(String) } })
    }
    expect(mock.requests).toEqual([])
  })

  it('is never a path that climbs out of its place, however it is written, and never an address that is not the API\'s', async () => {
    const browser = await verified()
    const paths = [
      '/api/lb01/tickets/%2e%2e%2fhealthz', '/api/lb01/tickets/..%2f..%2fadmin', '/api/lb01/tickets/%2e%2e', '/api/lb01/tickets/..;/x', '/api/lb01/tickets/%00',
      '/api/lb01/tickets/a%2fb', '/api/lb01/tickets/%5c%5cevil', '/api/lb01/tickets/http:%2f%2fevil.example', '/api/lb01//evil.example/x', '/api/lb01/tickets/a%20b',
      '/api/lb01/tickets/%e2%80%ae', '/api/lb01/tickets/' + 'x'.repeat(65), '//evil.example/api/lb01/customers', '/api/lb01/customers/../../healthz',
    ]

    for (const path of paths) {
      const reply = await rawRequest(site.url, path, { headers: { cookie: `__Host-lb_session=${browser.session}` } }).catch(() => undefined)
      expect([400, 404], path).toContain(reply?.status)
    }
    expect(mock.requests).toEqual([])
  })

  it('carries only the query a route documents, each name once, each value a short plain one', async () => {
    const browser = await verified()

    // The mock answers a conversation nobody started with a 404, as the real back end does; what matters here is what was forwarded.
    expect((await browser.request('GET', '/api/lb02/calendar?from=2026-10-05&days=7&conversation=ab12cd34')).status).toBe(404)
    expect(mock.requests.at(-1)?.query).toBe('?conversation=ab12cd34&days=7&from=2026-10-05')
    mock.reset()
    for (const query of ['?debug=1', '?days=7&days=8', '?days=%2e%2e%2f', '?days=', '?days=a b', '?DAYS=7', '?days=7&x=1']) {
      const reply = await browser.request('GET', `/api/lb02/calendar${query}`)
      expect(reply.status, query).toBe(400)
      expect(reply.json.error.code).toBe('invalid_request')
    }
    expect((await browser.request('GET', '/api/lb01/customers?x=1')).status).toBe(400)
    expect(mock.requests).toEqual([])
  })
})

describe('who the back end thinks is calling', () => {
  it('is the visitor the session names, for the one system the path belongs to, by a token that passes the real check', async () => {
    const browser = await verified()
    await browser.request('GET', '/api/lb01/customers')
    await browser.request('GET', '/api/lb02/offerings')
    await browser.request('GET', '/api/lb05/quota')
    await browser.request('GET', '/api/lb08/limits')

    const publicKey = loadPublicKey(keys.sitePublic)
    const seen = mock.requests.map((sent) => {
      const token = (sent.headers.authorization ?? '').replace('Bearer ', '')
      const system = /^\/api\/lb(\d{2})\//.exec(sent.path)?.[1]
      return verifyVisitorToken(token, `lb-${system}`, publicKey, () => site.clock.now / 1_000)
    })

    expect(seen.map(visitor => visitor.system)).toEqual(['lb-01', 'lb-02', 'lb-05', 'lb-08'])
    expect(new Set(seen.map(visitor => visitor.sessionKey)).size).toBe(1)
  })

  it('is no more than this server made, whatever the visitor sends in its own Authorization header', async () => {
    const browser = await verified()

    await browser.request('GET', '/api/lb01/customers', { headers: { 'authorization': 'Bearer attacker-token', 'x-forwarded-authorization': 'Bearer attacker-token' } })

    const sent = mock.requests[0]
    expect(sent?.headers.authorization).not.toContain('attacker')
    expect(sent?.headers['x-forwarded-authorization']).toBeUndefined()
  })
})

describe('what of the visitor\'s request goes along', () => {
  it('is the bearer token, and a JSON content type with the JSON body: never a cookie, an address, a referrer or an origin', async () => {
    const browser = await verified()

    await browser.request('POST', '/api/lb01/tickets', {
      body: TICKET,
      headers: { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9', 'forwarded': 'for=203.0.113.9', 'referer': 'https://site.example/secret-page', 'user-agent': 'Mozilla/5.0 Visitor', 'accept-language': 'cs', 'x-custom': 'hello', 'cf-connecting-ip': '203.0.113.9' },
    })

    const names = Object.keys(mock.requests.at(-1)?.headers ?? {})
    for (const forbidden of ['cookie', 'origin', 'referer', 'x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'x-custom', 'sec-fetch-site']) {
      expect(names, forbidden).not.toContain(forbidden)
    }
    // Node's own client adds `accept-language: *` and its own user agent; the visitor's are not passed on.
    expect(mock.requests.at(-1)?.headers['accept-language']).not.toBe('cs')
    expect(mock.requests.at(-1)?.headers['user-agent']).not.toContain('Visitor')
    expect(JSON.stringify(mock.requests)).not.toContain('203.0.113.9')
    expect(JSON.stringify(mock.requests)).not.toContain('__Host-lb_session')
    expect(mock.requests.at(-1)?.headers['content-type']).toBe('application/json')
    expect(JSON.parse(mock.requests.at(-1)?.body ?? '')).toEqual(TICKET)
  })

  it('is the JSON read back and written again, not the bytes as they came', async () => {
    const browser = await verified()
    const spaced = `{ "customer" : "cus-0001",\n "language":"en", "body":"Hello",  "body": "Hello again" }`

    const reply = await browser.request('POST', '/api/lb01/tickets', { raw: { text: spaced } })

    expect(reply.status).toBe(202)
    expect(mock.requests.at(-1)?.body).toBe('{"customer":"cus-0001","language":"en","body":"Hello again"}')
  })

  it('is no body at all for a route that takes none, even when the visitor sent one', async () => {
    const browser = await verified()

    await rawRequest(site.url, '/api/lb01/customers', { headers: { 'cookie': `__Host-lb_session=${browser.session}`, 'content-type': 'application/json', 'content-length': '17' }, chunks: ['{"smuggled":true}'] })
    await browser.request('POST', '/api/lb08/runs/abc12345/replay', { body: { smuggled: true } })

    expect(mock.requests.map(sent => sent.body)).toEqual(['', ''])
  })
})

describe('what comes back to the visitor', () => {
  it('is a status, a JSON body and nothing of the framework behind it: no banner, no cookie, no CORS, no internal host', async () => {
    const browser = await verified()
    const cookiesBefore = browser.setCookies.length

    const reply = await browser.request('GET', '/api/lb01/customers')

    expect(reply.status).toBe(200)
    expect(reply.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(reply.headers.get('cache-control')).toBe('no-store')
    for (const leaked of ['server', 'x-powered-by', 'access-control-allow-origin', 'x-internal-host', 'via']) expect(reply.headers.get(leaked), leaked).toBeNull()
    expect(browser.setCookies).toHaveLength(cookiesBefore)
    expect(reply.json).toHaveLength(6)
  })

  it('passes a documented error on, in the platform\'s shape, with when to try again', async () => {
    const browser = await verified()
    mock.script({ status: 429, headers: { 'retry-after': '120' }, json: { error: { code: 'daily_limit', message: 'A visitor may file 20 tickets a day.', stack: 'Traceback (most recent call last)', server: 'db-1' }, debug: true } })

    const reply = await browser.request('POST', '/api/lb01/tickets', { body: TICKET })

    expect(reply.status).toBe(429)
    expect(reply.headers.get('retry-after')).toBe('120')
    expect(reply.json).toEqual({ error: { code: 'daily_limit', message: 'A visitor may file 20 tickets a day.' } })
  })

  it('keeps what a back end adds to an error for a case: when a limit resets, and what a request got wrong', async () => {
    const browser = await verified()
    mock.script({ status: 429, json: { error: { code: 'daily_limit', message: 'Come back tomorrow.', resets_at: '2026-10-06T00:00:00Z', fields: null } } })

    const reply = await browser.request('POST', '/api/lb05/ask', { body: { question: 'Which roast sold most?' } })

    expect(reply.json.error).toEqual({ code: 'daily_limit', message: 'Come back tomorrow.', resets_at: '2026-10-06T00:00:00Z', fields: null })
  })

  it('passes LB-08\'s answer for a model that is out of reach on whole: the 503, its own code and when to try again', async () => {
    const browser = await verified()
    const message = 'Describing a workflow is unavailable right now: the free model quota may be spent, or a provider may be down. Try one of the samples, or come back later.'
    mock.script({ status: 503, headers: { 'retry-after': '30' }, json: { error: { code: 'generation_unavailable', message } } })

    const reply = await browser.request('POST', '/api/lb08/workflows', { body: { from: 'description', description: 'When a customer asks for a refund, ask finance and email them the answer.' } })

    // The code is what the board tells this apart by from a deployment with no back end, whose 503 says `unavailable`.
    expect(reply.status).toBe(503)
    expect(reply.headers.get('retry-after')).toBe('30')
    expect(reply.json).toEqual({ error: { code: 'generation_unavailable', message } })
  })

  it('turns an error that is not the platform\'s shape into a generic one, so nothing internal is reflected', async () => {
    const browser = await verified()
    mock.script({ status: 422, json: { detail: 'psycopg.errors.UndefinedTable: relation "lb01.ticket" does not exist', trace: ['File "/app/lb01/api.py"'] } })

    const reply = await browser.request('POST', '/api/lb01/tickets', { body: TICKET })

    expect(reply.status).toBe(422)
    expect(reply.json).toEqual({ error: { code: 'upstream_error', message: expect.any(String) } })
    expect(reply.text).not.toContain('psycopg')
    expect(reply.text).not.toContain('/app/')
  })

  it('is a 502 for what the visitor can do nothing about: a back end that fails, refuses the site, or answers with something that is not JSON', async () => {
    const browser = await verified()
    const failures: [string, Parameters<MockBackend['script']>[0]][] = [
      ['500 with a trace', { status: 500, json: { error: { code: 'x', message: 'Traceback (most recent call last): secret' } } }],
      ['500 as HTML', { status: 500, text: '<html><body>Internal Server Error: db-1</body></html>', headers: { 'content-type': 'text/html' } }],
      ['401, the site\'s token refused', { status: 401, json: { error: { code: 'unauthorized', message: 'no' } } }],
      ['403', { status: 403, json: { error: { code: 'forbidden', message: 'no' } } }],
      ['418', { status: 418, json: {} }],
      ['200 as HTML', { status: 200, text: '<html>captive portal</html>', headers: { 'content-type': 'text/html' } }],
      ['200 with broken JSON', { status: 200, text: '{"unfinished":', headers: { 'content-type': 'application/json' } }],
      ['200 with no content type', { status: 200, text: '[]', headers: { 'content-type': 'text/plain' } }],
    ]

    for (const [name, script] of failures) {
      mock.script(script)
      const reply = await browser.request('GET', '/api/lb01/customers')
      expect(reply.status, name).toBe(502)
      expect(reply.json, name).toEqual({ error: { code: 'upstream_failed', message: expect.any(String) } })
      expect(reply.text, name).not.toMatch(/Traceback|secret|db-1|captive|unfinished/)
    }
  })

  it('never follows a redirect: the answer to one is a failure, and the address it names is never asked', async () => {
    const browser = await verified()
    mock.script({ status: 302, headers: { location: `${mock.url}/api/lb01/stats` } })
    mock.script({ status: 307, headers: { location: 'http://127.0.0.1:1/evil' } })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reply = await browser.request('GET', '/api/lb01/customers')
      expect(reply.status).toBe(502)
    }
    expect(mock.requests.map(sent => sent.path)).toEqual(['/api/lb01/customers', '/api/lb01/customers'])
  })

  it('is cut off when an answer is bigger than the system\'s limit, and when it takes longer than the system\'s deadline', async () => {
    const browser = await verified()
    mock.script({ bytes: 300_000, headers: { 'content-type': 'application/json' } })
    mock.script({ delayMs: 1_500, json: [] })

    const big = await browser.request('GET', '/api/lb01/customers')
    const started = Date.now()
    const slow = await browser.request('GET', '/api/lb01/customers')

    expect(big.status).toBe(502)
    expect(slow.status).toBe(504)
    expect(slow.json.error.code).toBe('upstream_timeout')
    expect(Date.now() - started).toBeLessThan(1_200)
  })

  it('is a 502 when the back end drops the connection, and when it is not there at all', async () => {
    const browser = await verified()
    mock.script({ destroy: true })
    const dropped = await browser.request('GET', '/api/lb01/customers')

    const lonely = await startTestSite({ keys, backendUrl: 'http://127.0.0.1:1', clock })
    try {
      const other = new Browser(lonely)
      const absent = await other.request('GET', '/api/lb01/customers')

      expect(absent.status).toBe(502)
      expect(absent.json.error.code).toBe('upstream_failed')
    }
    finally {
      await lonely.close()
    }
    expect(dropped.status).toBe(502)
  })

  it('answers 204 with no body when the back end does, and keeps the platform\'s other documented statuses', async () => {
    const browser = await verified()
    mock.script({ status: 204 })
    mock.script({ status: 409, json: { error: { code: 'not_waiting', message: 'Only a draft waiting for approval can be decided.' } } })

    const deleted = await browser.request('DELETE', '/api/lb08/workflows/abc12345')
    const conflict = await browser.request('POST', '/api/lb01/tickets/abc12345/decision', { body: { action: 'approve' } })

    expect(deleted.status).toBe(204)
    expect(deleted.text).toBe('')
    expect(conflict.status).toBe(409)
    expect(conflict.json.error.code).toBe('not_waiting')
  })
})

describe('what a visitor must do before a call that changes something', () => {
  it('is pass the check: a read needs none, and a change without it is refused before its body is read or anything is forwarded', async () => {
    const browser = new Browser(site)

    expect((await browser.request('GET', '/api/lb01/customers')).status).toBe(200)
    mock.reset()
    for (const [method, path] of [['POST', '/api/lb01/tickets'], ['POST', '/api/lb01/tickets/abc12345/decision'], ['POST', '/api/lb05/ask'], ['PUT', '/api/lb08/workflows/abc12345'], ['DELETE', '/api/lb08/workflows/abc12345']] as const) {
      const reply = await browser.request(method, path, { raw: { text: 'this is not even JSON', type: 'text/plain' } })
      expect(reply.status, `${method} ${path}`).toBe(403)
      expect(reply.json.error.code).toBe('verification_required')
    }
    expect(mock.requests).toEqual([])
  })

  it('is the Origin check first: a change from another site is refused whether or not the check was passed', async () => {
    const browser = await verified()

    const reply = await browser.request('POST', '/api/lb01/tickets', { body: TICKET, origin: 'https://evil.example' })

    expect(reply.status).toBe(403)
    expect(reply.json.error.code).toBe('forbidden_origin')
    expect(mock.requests).toEqual([])
  })
})

describe('what a request body may be', () => {
  it('is JSON, as declared, of the system\'s size or less', async () => {
    const browser = await verified()

    const wrongType = await browser.request('POST', '/api/lb01/tickets', { raw: { text: JSON.stringify(TICKET), type: 'text/plain' } })
    const noType = await browser.request('POST', '/api/lb01/tickets', { raw: { text: JSON.stringify(TICKET), type: '' }, headers: { 'content-type': undefined } })
    const notJson = await browser.request('POST', '/api/lb01/tickets', { raw: { text: '{"customer":' } })
    const empty = await browser.request('POST', '/api/lb01/tickets', { raw: { text: '' } })
    const tooBig = await browser.request('POST', '/api/lb01/tickets', { raw: { text: JSON.stringify({ ...TICKET, body: 'x'.repeat(9_000) }) } })

    expect(wrongType.status).toBe(415)
    expect(noType.status).toBe(415)
    expect(notJson.status).toBe(400)
    expect(empty.status).toBe(400)
    expect(tooBig.status).toBe(413)
    expect(tooBig.json.error.code).toBe('payload_too_large')
    expect(tooBig.headers.get('connection')).toBe('close')
    expect(mock.requests).toEqual([])
  })

  it('is counted as it arrives when it declares no length, and stopped at the limit', async () => {
    const browser = await verified()
    // Twenty chunks of a kilobyte: twice what LB-01 takes, and not a word of it JSON.
    const chunk = 'x'.repeat(1_000)

    const reply = await rawRequest(site.url, '/api/lb01/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'origin': site.origin, 'cookie': `__Host-lb_session=${browser.session}` },
      chunks: Array.from({ length: 20 }, () => chunk),
    })

    expect(reply.status).toBe(413)
    expect(mock.requests).toEqual([])
  })

  it('is refused at once when its declared length is over the limit, before a byte is read', async () => {
    const browser = await verified()

    const reply = await rawRequest(site.url, '/api/lb01/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'origin': site.origin, 'cookie': `__Host-lb_session=${browser.session}`, 'content-length': '100000' },
      chunks: ['{'],
    }).catch(() => ({ status: 413, text: '', headers: {} }))

    expect(reply.status).toBe(413)
    expect(mock.requests).toEqual([])
  })

  it('cannot be smuggled in with two lengths: a request that says two different things is refused by the server itself', async () => {
    const browser = await verified()

    const reply = await rawRequest(site.url, '/api/lb01/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'origin': site.origin, 'cookie': `__Host-lb_session=${browser.session}`, 'content-length': '5', 'transfer-encoding': 'chunked' },
      chunks: ['5\r\nhello\r\n0\r\n\r\n'],
    }).catch(() => ({ status: 400, text: '', headers: {} }))

    expect([400, 413, 415]).toContain(reply.status)
    expect(mock.requests).toEqual([])
  })
})

describe('LB-01 through the proxy, start to finish', () => {
  it('files a ticket, follows it, and decides it, as the demo does', async () => {
    const browser = await verified()

    const filed = await browser.request('POST', '/api/lb01/tickets', { body: TICKET })
    const id = filed.json.id as string
    const polled = [await browser.request('GET', `/api/lb01/tickets/${id}`), await browser.request('GET', `/api/lb01/tickets/${id}`)]
    const decided = await browser.request('POST', `/api/lb01/tickets/${id}/decision`, { body: { action: 'approve' } })
    const stats = await browser.request('GET', '/api/lb01/stats')

    expect(filed.status).toBe(202)
    expect(polled.map(reply => reply.json.status)).toEqual(['processing', 'awaiting_approval'])
    expect(polled[1]?.json.draft.sentences.length).toBeGreaterThan(0)
    expect(decided.json.status).toBe('sent')
    expect(stats.json).toMatchObject({ tickets: 1, sent: 1, accuracy: 1 })
  })

  it('shows a visitor only their own tickets, however the ID is guessed', async () => {
    const owner = await verified()
    const stranger = await verified()
    const id = (await owner.request('POST', '/api/lb01/tickets', { body: TICKET })).json.id as string

    expect((await stranger.request('GET', `/api/lb01/tickets/${id}`)).status).toBe(404)
    expect((await stranger.request('GET', '/api/lb01/tickets')).json).toEqual([])
  })

  it('counts the visitor\'s daily tickets in the back end, whatever the cookie does', async () => {
    const browser = await verified()
    for (let count = 0; count < 20; count += 1) expect((await browser.request('POST', '/api/lb01/tickets', { body: TICKET })).status).toBe(202)

    const refused = await browser.request('POST', '/api/lb01/tickets', { body: TICKET })

    expect(refused.status).toBe(429)
    expect(refused.json.error.code).toBe('daily_limit')
  })
})

describe('the token for LB-02\'s WebSocket', () => {
  it('is made for a visitor who passed the check, for LB-02 only, valid five minutes, and the address to open is the API\'s own, with no token in it', async () => {
    const browser = await verified()

    const reply = await browser.request('POST', '/api/tokens/lb-02')

    expect(reply.status).toBe(200)
    const grant = reply.json as { system: string, token: string, expiresAt: string, socketUrl: string }
    const visitor = verifyVisitorToken(grant.token, 'lb-02', loadPublicKey(keys.sitePublic), () => site.clock.now / 1_000)
    expect(visitor.system).toBe('lb-02')
    expect(grant.system).toBe('lb-02')
    expect(grant.expiresAt).toBe(new Date(site.clock.now + 300_000).toISOString())
    expect(grant.socketUrl).toBe(`${mock.url.replace('http:', 'ws:')}/ws/lb02/`)
    expect(grant.socketUrl).not.toContain(grant.token)
    expect(() => verifyVisitorToken(grant.token, 'lb-01', loadPublicKey(keys.sitePublic))).toThrow()
  })

  it('names the same visitor as every other call of the session', async () => {
    const browser = await verified()
    await browser.request('GET', '/api/lb02/offerings')
    const subject = JSON.parse(Buffer.from((mock.requests[0]?.headers.authorization ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')).sub as string

    const grant = (await browser.request('POST', '/api/tokens/lb-02')).json.token as string

    expect(JSON.parse(Buffer.from(grant.split('.')[1] ?? '', 'base64url').toString('utf8')).sub).toBe(subject)
  })

  it('is refused without the check, from another site, and for any other system', async () => {
    const browser = new Browser(site)

    expect((await browser.request('POST', '/api/tokens/lb-02')).status).toBe(403)
    await browser.verify()
    expect((await browser.request('POST', '/api/tokens/lb-02', { origin: 'https://evil.example' })).status).toBe(403)
    for (const system of ['lb-01', 'lb-05', 'lb-08', 'lb-99', 'lb-02/extra']) {
      expect((await browser.request('POST', `/api/tokens/${system}`)).status, system).toBe(404)
    }
    expect((await browser.request('GET', '/api/tokens/lb-02')).status).toBe(404)
  })
})

describe('the token for LB-09\'s WebSocket', () => {
  it('is made for a visitor who passed the check, for LB-09 only, and names the meeting progress socket', async () => {
    const browser = await verified()

    const reply = await browser.request('POST', '/api/tokens/lb-09')

    expect(reply.status).toBe(200)
    const grant = reply.json as { system: string, token: string, expiresAt: string, socketUrl: string }
    expect(grant.system).toBe('lb-09')
    expect(verifyVisitorToken(grant.token, 'lb-09', loadPublicKey(keys.sitePublic), () => site.clock.now / 1_000).system).toBe('lb-09')
    expect(() => verifyVisitorToken(grant.token, 'lb-02', loadPublicKey(keys.sitePublic))).toThrow()
    expect(grant.socketUrl).toBe(`${mock.url.replace('http:', 'ws:')}/ws/lb09/`)
    expect(grant.socketUrl).not.toContain(grant.token)
  })

  it('is refused without the check', async () => {
    const browser = new Browser(site)

    expect((await browser.request('POST', '/api/tokens/lb-09')).status).toBe(403)
  })
})
