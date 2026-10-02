// Tests for the mock back end itself: it serves what the three OpenAPI documents describe, every
// answer it gives fits its document, it checks visitor tokens with the real verifier, LB-01 plays
// like the real one (a ticket's pipeline moves on as it is polled, the golden set's samples end as
// the golden set expects, a visitor sees only their own tickets) and the Scope route plays like
// the gateway's. If a document changes and the mock no longer fits it, these tests fail.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { generateKeyPairSync } from 'node:crypto'

import { mintServiceToken } from '@lb/common/tokens'
import { mintVisitorToken } from '@lb/common/visitors'

import { MOCK_IDENTITY_PATH, OpenApiDocuments, readSeed, startMockBackend } from '../src/testing/index.ts'
import type { MockBackend } from '../src/testing/index.ts'

const site = generateKeyPairSync('ed25519')
const web = generateKeyPairSync('ed25519')
const documents = new OpenApiDocuments()
const seed = readSeed()
// The clock the mock and the tokens share, in Unix milliseconds. Tests move it.
let clock = Date.UTC(2026, 9, 5, 9, 0, 0)
let mock: MockBackend

beforeAll(async () => {
  mock = await startMockBackend({
    siteKey: site.publicKey.export({ format: 'jwk' }).x ?? '',
    webKey: web.publicKey.export({ format: 'jwk' }).x ?? '',
    now: () => clock,
  })
})

afterAll(async () => {
  await mock.close()
})

beforeEach(() => {
  mock.reset()
  clock = Date.UTC(2026, 9, 5, 9, 0, 0)
})

/** Signs a visitor token for a system and a visitor, at the test clock. */
function token(system: string, visitor = 'visitor-aaaaaaaaaaaaaaaa'): string {
  return mintVisitorToken(site.privateKey, { system, sessionKey: visitor }, clock / 1000)
}

/** Calls the mock as a visitor of a system, with the token in the Authorization header. */
async function call(method: string, path: string, options: { system?: string, visitor?: string, body?: unknown, authorization?: string } = {}): Promise<{ status: number, json: any, headers: Headers }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const system = options.system ?? `lb-${/^\/api\/lb(\d{2})/.exec(path)?.[1] ?? '01'}`
  const response = await fetch(`${mock.url}${path}`, {
    method,
    headers: { 'authorization': options.authorization ?? `Bearer ${token(system, options.visitor)}`, 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  return { status: response.status, json: text === '' ? undefined : JSON.parse(text), headers: response.headers }
}

/** Reads a run's spans from the mock's Scope route as the `web` service. */
async function scope(runId: string, query = ''): Promise<{ status: number, json: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const authorization = `Bearer ${mintServiceToken('web', web.privateKey, clock / 1000)}`
  const response = await fetch(`${mock.url}/v1/runs/${runId}/spans${query}`, { headers: { authorization } })
  return { status: response.status, json: await response.json() }
}

/** Files a ticket as a visitor and returns the answer. */
function file(sampleId: string, visitor?: string) {
  const sample = seed.golden.find(item => item.id === sampleId)!
  return call('POST', '/api/lb01/tickets', { visitor, body: { customer: sample.customer, language: sample.language, body: sample.ticket } })
}

describe('the operations it serves', () => {
  it('answers every operation its documents describe with a documented success, and every answer fits its schema', async () => {
    const served = documents.operations.filter(operation => /^\/api\/lb\d{2}\//.test(operation.template))
    expect(served.length).toBeGreaterThanOrEqual(29)

    for (const operation of served) {
      const path = operation.template.replace(/\{\w+\}/g, 'abc12345')
      const body = documents.exampleRequest(operation)
      const answer = await call(operation.method, path, { body })

      // A route that needs a ticket or a customer that doesn't exist answers its documented 404 or 409.
      const documented = Object.keys(operation.operation.responses ?? {}).map(Number)
      expect(documented, `${operation.method} ${path} answered ${answer.status}`).toContain(answer.status)
    }
    expect(mock.violations).toEqual([])
  })

  it('does not serve a path no document describes, or a method the path does not have', async () => {
    expect((await call('GET', '/api/lb01/nothing')).status).toBe(404)
    expect((await call('DELETE', '/api/lb01/customers', { system: 'lb-01' })).status).toBe(404)
    expect((await call('GET', '/admin')).status).toBe(404)
  })

  it('says it is the mock at the one address of its own, so a recorder can tell it from a real back end', async () => {
    const answer = await call('GET', MOCK_IDENTITY_PATH)

    expect(answer.status).toBe(200)
    expect(answer.json).toEqual({ mock: true })
    expect((await call('POST', MOCK_IDENTITY_PATH)).status).toBe(404)
  })

  it('refuses a body its document\'s schema refuses, naming the fields and not the values', async () => {
    const answer = await call('POST', '/api/lb01/tickets', { body: { customer: 'cus-0001', language: 'de', body: 'a secret request' } })

    expect(answer.status).toBe(422)
    expect(answer.json.error.code).toBe('invalid_request')
    expect(JSON.stringify(answer.json)).not.toContain('secret')
  })

  it('adds the headers a real framework adds, so tests can watch the site drop them', async () => {
    const answer = await call('GET', '/api/lb01/customers')

    expect(answer.headers.get('server')).toContain('gunicorn')
    expect(answer.headers.get('set-cookie')).toContain('mock_session')
    expect(answer.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('who may call', () => {
  it('refuses a call without a token, with another system\'s token, with an expired token and with a stranger\'s', async () => {
    const stranger = mintVisitorToken(generateKeyPairSync('ed25519').privateKey, { system: 'lb-01', sessionKey: 'visitor-aaaaaaaaaaaaaaaa' }, clock / 1000)
    const expired = mintVisitorToken(site.privateKey, { system: 'lb-01', sessionKey: 'visitor-aaaaaaaaaaaaaaaa' }, clock / 1000 - 3_600)

    expect((await call('GET', '/api/lb01/customers', { authorization: '' })).status).toBe(401)
    expect((await call('GET', '/api/lb01/customers', { authorization: `Bearer ${token('lb-02')}` })).status).toBe(401)
    expect((await call('GET', '/api/lb01/customers', { authorization: `Bearer ${expired}` })).status).toBe(401)
    expect((await call('GET', '/api/lb01/customers', { authorization: `Bearer ${stranger}` })).status).toBe(401)
    expect((await call('GET', '/api/lb01/customers')).status).toBe(200)
  })

  it('serves LB-02, LB-05 and LB-08 only to a token for that system', async () => {
    expect((await call('GET', '/api/lb02/offerings')).status).toBe(200)
    expect((await call('GET', '/api/lb05/quota')).status).toBe(200)
    expect((await call('GET', '/api/lb08/limits')).status).toBe(200)
    expect((await call('GET', '/api/lb05/quota', { authorization: `Bearer ${token('lb-01')}` })).status).toBe(401)
  })
})

describe('LB-01', () => {
  it('lists the synthetic customers of the seed', async () => {
    const answer = await call('GET', '/api/lb01/customers')

    expect(answer.json).toEqual(seed.customers)
    expect(answer.json).toHaveLength(6)
  })

  it('moves a ticket along as it is polled, and ends a sample as the golden set expects', async () => {
    const filed = await file('torn-bag')
    const id = filed.json.id as string

    expect(filed.status).toBe(202)
    expect(filed.json).toMatchObject({ status: 'received', draft: null, decision: null })
    expect((await call('GET', `/api/lb01/tickets/${id}`)).json.status).toBe('processing')
    const done = (await call('GET', `/api/lb01/tickets/${id}`)).json

    expect(done).toMatchObject({ status: 'awaiting_approval', category: 'damaged', order_number: 'BB-1040', escalation_reason: '' })
    expect(done.draft.claims_supported).toBe(true)
    expect(done.draft.sentences.every((sentence: { supported: boolean }) => sentence.supported)).toBe(true)
    expect(done.draft.sources.map((source: { id: string }) => source.id)).toEqual(['order:BB-1040', 'passage:damaged.torn-bags'])
    expect(mock.violations).toEqual([])
  })

  it('names the run only once the pipeline has finished, as Django does, and the Scope knows it then', async () => {
    const filed = await file('torn-bag')
    const id = filed.json.id as string

    expect(filed.json.run_id).toBe('')
    expect((await call('GET', `/api/lb01/tickets/${id}`)).json.run_id).toBe('')
    const done = (await call('GET', `/api/lb01/tickets/${id}`)).json
    expect(done.run_id).toMatch(/^run-[0-9a-f]{20}$/)
    expect((await scope(done.run_id)).json.finished).toBe(true)
    expect(mock.violations).toEqual([])
  })

  it('writes a Czech ticket\'s sources in Czech', async () => {
    const id = (await file('stale-decaf')).json.id as string
    await call('GET', `/api/lb01/tickets/${id}`)
    const done = (await call('GET', `/api/lb01/tickets/${id}`)).json

    expect(done.language).toBe('cs')
    const passage = done.draft.sources.find((source: { id: string }) => source.id.startsWith('passage:'))
    expect(passage.text).toMatch(/[áčďéěíňóřšťúůýž]/)
    expect(passage.title).toContain('§')
  })

  it('hands a ticket that tries to take over to a person, with the reason and no draft', async () => {
    const id = (await file('injection-admin-mode')).json.id as string
    await call('GET', `/api/lb01/tickets/${id}`)
    const done = (await call('GET', `/api/lb01/tickets/${id}`)).json

    expect(done).toMatchObject({ status: 'escalated', escalation_reason: 'injection', draft: null })
  })

  it('marks a promise no source makes as unsupported, for a ticket that asks for a refund', async () => {
    const sample = seed.golden.find(item => item.id === 'torn-bag')!
    const body = { customer: sample.customer, language: 'en', body: `${sample.ticket} I want a refund.` }
    const id = (await call('POST', '/api/lb01/tickets', { body })).json.id as string
    await call('GET', `/api/lb01/tickets/${id}`)
    const done = (await call('GET', `/api/lb01/tickets/${id}`)).json

    expect(done.draft.claims_supported).toBe(false)
    expect(done.draft.sentences.filter((sentence: { supported: boolean }) => !sentence.supported)).toHaveLength(1)
  })

  it('lets a person approve a waiting draft once, edit another, and refuses a second decision', async () => {
    const first = (await file('torn-bag')).json.id as string
    const second = (await file('late-parcel')).json.id as string
    for (const id of [first, second]) {
      await call('GET', `/api/lb01/tickets/${id}`)
      await call('GET', `/api/lb01/tickets/${id}`)
    }

    const approved = await call('POST', `/api/lb01/tickets/${first}/decision`, { body: { action: 'approve' } })
    const edited = await call('POST', `/api/lb01/tickets/${second}/decision`, { body: { action: 'edit', text: 'Hello, we are sorry.' } })
    const again = await call('POST', `/api/lb01/tickets/${first}/decision`, { body: { action: 'approve' } })

    expect(approved.json).toMatchObject({ status: 'sent', decision: { action: 'approve' } })
    expect(edited.json).toMatchObject({ status: 'sent', decision: { action: 'edit', final_text: 'Hello, we are sorry.' } })
    expect(again.status).toBe(409)
    expect((await call('GET', '/api/lb01/stats')).json).toMatchObject({ tickets: 2, sent: 2, sent_unedited: 1, deflection: 1, accuracy: 0.5 })
  })

  it('shows a visitor only their own tickets: another\'s is as missing as one that was never filed', async () => {
    const id = (await file('torn-bag', 'visitor-aaaaaaaaaaaaaaaa')).json.id as string

    expect((await call('GET', `/api/lb01/tickets/${id}`, { visitor: 'visitor-bbbbbbbbbbbbbbbb' })).status).toBe(404)
    expect((await call('POST', `/api/lb01/tickets/${id}/decision`, { visitor: 'visitor-bbbbbbbbbbbbbbbb', body: { action: 'escalate' } })).status).toBe(404)
    expect((await call('GET', '/api/lb01/tickets', { visitor: 'visitor-bbbbbbbbbbbbbbbb' })).json).toEqual([])
    expect((await call('GET', '/api/lb01/tickets', { visitor: 'visitor-aaaaaaaaaaaaaaaa' })).json).toHaveLength(1)
  })

  it('refuses the twenty-first ticket of the day, and starts counting again the next day', async () => {
    for (let count = 0; count < 20; count += 1) expect((await file('torn-bag')).status).toBe(202)

    const refused = await file('torn-bag')
    expect(refused.status).toBe(429)
    expect(refused.json.error.code).toBe('daily_limit')

    clock += 24 * 3_600_000
    expect((await file('torn-bag')).status).toBe(202)
  })

  it('answers an unknown customer with the documented 404', async () => {
    const answer = await call('POST', '/api/lb01/tickets', { body: { customer: 'cus-9999', language: 'en', body: 'Hello' } })

    expect(answer.status).toBe(404)
    expect(answer.json.error.code).toBe('unknown_customer')
  })
})

// A run's trace can be asked for while the run goes only if the back end names the run when the ticket
// is filed, so these tests use a mock that does (the default mock names it at the end, as Django does).
describe('the Scope route, for a back end that names the run when the ticket is filed', () => {
  let named: MockBackend
  let usual: MockBackend

  beforeAll(async () => {
    usual = mock
    named = await startMockBackend({
      siteKey: site.publicKey.export({ format: 'jwk' }).x ?? '',
      webKey: web.publicKey.export({ format: 'jwk' }).x ?? '',
      now: () => clock,
      runId: 'at-filing',
    })
    mock = named
  })

  afterAll(async () => {
    mock = usual
    await named.close()
  })

  /** Files the torn-bag sample and returns its run's ID. */
  async function startedRun(): Promise<string> {
    return (await file('torn-bag')).json.run_id as string
  }

  it('names the run in the answer to filing the ticket', async () => {
    const filed = await file('torn-bag')

    expect(filed.json.run_id).toMatch(/^run-[0-9a-f]{20}$/)
    expect((await call('GET', `/api/lb01/tickets/${filed.json.id}`)).json.run_id).toBe(filed.json.run_id)
    expect(mock.violations).toEqual([])
  })

  it('knows no trace until the pipeline has written something, and then returns it, finished once the run ends', async () => {
    const id = (await file('torn-bag')).json
    const runId = id.run_id as string

    expect((await scope(runId)).status).toBe(404)
    await call('GET', `/api/lb01/tickets/${id.id}`)
    const during = await scope(runId)
    expect(during.status).toBe(200)
    expect(during.json).toMatchObject({ runId, finished: false, more: false })
    expect(during.json.spans.length).toBeGreaterThan(0)

    await call('GET', `/api/lb01/tickets/${id.id}`)
    const done = await scope(runId)
    expect(done.json.finished).toBe(true)
    expect(done.json.spans.at(-1)).toMatchObject({ kind: 'system.run', name: 'support ticket' })
    expect(done.json.spans.some((span: { kind: string }) => span.kind === 'gateway.call')).toBe(true)
  })

  it('pages with a cursor, like the gateway\'s', async () => {
    const runId = await startedRun()
    const id = (await call('GET', '/api/lb01/tickets')).json[0].id as string
    await call('GET', `/api/lb01/tickets/${id}`)
    await call('GET', `/api/lb01/tickets/${id}`)

    const first = await scope(runId, '?limit=5')
    const second = await scope(runId, `?limit=5&after=${first.json.cursor}`)
    const all = await scope(runId)

    expect(first.json.spans).toHaveLength(5)
    expect(first.json.more).toBe(true)
    expect([...first.json.spans, ...second.json.spans].slice(0, 10)).toEqual(all.json.spans.slice(0, 10))
    expect((await scope(runId, `?after=${all.json.cursor}`)).json).toMatchObject({ spans: [], more: false, finished: true, cursor: all.json.cursor })
  })

  it('refuses a token that is not the web service\'s, and a run ID or limit of the wrong shape', async () => {
    const runId = await startedRun()
    const other = mintServiceToken('web', generateKeyPairSync('ed25519').privateKey, clock / 1000)

    const response = await fetch(`${mock.url}/v1/runs/${runId}/spans`, { headers: { authorization: `Bearer ${other}` } })
    expect(response.status).toBe(401)
    expect((await scope('short')).status).toBe(400)
    expect((await scope(runId, '?limit=501')).status).toBe(400)
    expect((await scope(runId, '?after=abc')).status).toBe(400)
  })
})

describe('a back end that misbehaves', () => {
  it('records what it received, headers included, and forgets it on reset', async () => {
    await call('GET', '/api/lb01/customers')

    expect(mock.requests).toHaveLength(1)
    expect(mock.requests[0]).toMatchObject({ method: 'GET', path: '/api/lb01/customers', body: '' })
    expect(mock.requests[0]?.headers.authorization).toMatch(/^Bearer /)
    mock.reset()
    expect(mock.requests).toHaveLength(0)
  })

  it('plays a scripted answer once, then answers normally again', async () => {
    mock.script({ method: 'GET', path: '/api/lb01/customers', status: 429, headers: { 'retry-after': '30' }, json: { error: { code: 'daily_limit', message: 'Slow down.' } } })

    const scripted = await call('GET', '/api/lb01/customers')
    const normal = await call('GET', '/api/lb01/customers')

    expect(scripted.status).toBe(429)
    expect(scripted.headers.get('retry-after')).toBe('30')
    expect(normal.status).toBe(200)
  })

  it('can send what is not JSON, a body of any size, a redirect, a slow answer or no answer at all', async () => {
    mock.script({ text: '<html>oops</html>', headers: { 'content-type': 'text/html' } })
    mock.script({ bytes: 3_000_000 })
    mock.script({ status: 302, headers: { location: 'http://evil.example/' } })
    mock.script({ delayMs: 150, json: [] })
    mock.script({ destroy: true })

    const html = await fetch(`${mock.url}/api/lb01/customers`)
    expect(html.headers.get('content-type')).toBe('text/html')
    expect(await html.text()).toBe('<html>oops</html>')
    expect((await (await fetch(`${mock.url}/api/lb01/customers`)).text()).length).toBe(3_000_000)
    expect((await fetch(`${mock.url}/api/lb01/customers`, { redirect: 'manual' })).headers.get('location')).toBe('http://evil.example/')
    const started = Date.now()
    await fetch(`${mock.url}/api/lb01/customers`)
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
    await expect(fetch(`${mock.url}/api/lb01/customers`)).rejects.toThrow()
  })
})
