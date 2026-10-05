// Integration tests for what LB-10 asks of the site's server: its routes forwarded as the visitor (a run is started
// only after the check), the service's refusal of a prompt passed on with its list of problems in the platform's shape
// (each problem's code and sentence, nothing else), and a prompt at the service's limit taken however many bytes its
// letters need, while a body past the limit is refused before anything is forwarded. The mock back end plays the
// service, so its refusals are the ones the tests of the mock check.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { readLb10Seed, startMockBackend } from '@lb/api-clients/testing'
import type { MockBackend } from '@lb/api-clients/testing'
import { loadPublicKey, verifyVisitorToken } from '@lb/common/visitors'

import { Browser } from '../support/browser.ts'
import { makeTestKeys, startTestSite } from '../support/site-app.ts'
import type { TestSite } from '../support/site-app.ts'

const keys = makeTestKeys()
const START = Date.UTC(2026, 9, 5, 9, 0, 0)
const clock = { now: START }
const DRAFTER = readLb10Seed().packs.find(pack => pack.pack === 'lb01-drafter')
const PRODUCTION = DRAFTER?.systemPrompt ?? ''
// The most characters a visitor's prompt may have (services/flask-systems/lb10/limits.py).
const MAX_PROMPT_CHARS = 8_000
let mock: MockBackend
let site: TestSite

beforeAll(async () => {
  mock = await startMockBackend({ siteKey: keys.sitePublic, webKey: keys.webPublic, now: () => clock.now })
  site = await startTestSite({ keys, backendUrl: mock.url, clock })
})

afterAll(async () => {
  await site.close()
  await mock.close()
})

beforeEach(() => {
  mock.reset()
  clock.now = START
})

/** A browser that has passed the Turnstile check. */
async function verified(): Promise<Browser> {
  const browser = new Browser(site)
  expect((await browser.verify()).status).toBe(200)
  return browser
}

/** The body of a request to run a prompt on Groq. */
function runOf(prompt: string): Record<string, unknown> {
  return { target: 'lb01-drafter', prompt, providers: ['groq'] }
}

describe('LB-10\'s routes through the proxy', () => {
  it('are forwarded as the visitor, with a token for LB-10 alone, and a run starts only after the check', async () => {
    const browser = new Browser(site)
    expect((await browser.request('GET', '/api/lb10/targets')).json.targets).toHaveLength(5)
    const refused = await browser.request('POST', '/api/lb10/runs', { body: runOf(`${PRODUCTION}\nBe brief.`) })
    expect(refused.status).toBe(403)
    expect(refused.json.error.code).toBe('verification_required')
    expect(mock.requests.filter(request => request.method === 'POST')).toEqual([])

    expect((await browser.verify()).status).toBe(200)
    const started = await browser.request('POST', '/api/lb10/runs', { body: runOf(`${PRODUCTION}\nBe brief.`) })
    expect(started.status).toBe(202)
    expect(started.json.remaining_runs).toBe(0)
    const token = (mock.requests.at(-1)?.headers.authorization ?? '').replace('Bearer ', '')
    expect(verifyVisitorToken(token, 'lb-10', loadPublicKey(keys.sitePublic), () => clock.now / 1_000).system).toBe('lb-10')
    expect((await browser.request('GET', `/api/lb10/runs/${started.json.run.run_id as string}`)).json.state).toBe('running')
  })

  it('pass the service\'s refusal of a prompt on with every problem it lists, and the day\'s run untouched', async () => {
    const browser = await verified()
    const reply = await browser.request('POST', '/api/lb10/runs', { body: runOf('Reply in English. {{tomorrow}}') })
    expect(reply.status).toBe(422)
    expect(reply.json.error.code).toBe('invalid_prompt')
    expect(reply.json.problems.map((problem: { code: string }) => problem.code)).toEqual(['missing_variables', 'unknown_variables'])
    expect((await browser.request('GET', '/api/lb10/quota')).json.remaining).toBe(1)
  })

  it('keep of each problem its code and its sentence, and turn a list that is not the platform\'s shape into a generic error', async () => {
    const browser = await verified()
    mock.script({ status: 422, json: { error: { code: 'invalid_prompt', message: 'The prompt is empty.' }, problems: [{ code: 'empty', message: 'The prompt is empty.', trace: 'internal' }], debug: true } })
    const kept = await browser.request('POST', '/api/lb10/runs', { body: runOf(PRODUCTION) })
    expect(kept.json).toEqual({ error: { code: 'invalid_prompt', message: 'The prompt is empty.' }, problems: [{ code: 'empty', message: 'The prompt is empty.' }] })

    mock.script({ status: 422, json: { error: { code: 'invalid_prompt', message: 'Too many.' }, problems: Array.from({ length: 11 }, () => ({ code: 'empty', message: 'x' })) } })
    const generic = await browser.request('POST', '/api/lb10/runs', { body: runOf(PRODUCTION) })
    expect(generic.status).toBe(422)
    expect(generic.json.problems).toBeUndefined()
    expect(generic.json.error.message).not.toBe('Too many.')
  })

  it('take a prompt at the limit however many bytes its letters need, and refuse a bigger body before forwarding it', async () => {
    const browser = await verified()
    // Every character past production's prompt is a letter of four bytes in UTF-8, as the browser sends it.
    const atLimit = `${PRODUCTION}${'\u{1F600}'.repeat(MAX_PROMPT_CHARS - [...PRODUCTION].length)}`
    expect(new TextEncoder().encode(JSON.stringify(runOf(atLimit))).length).toBeGreaterThan(3 * MAX_PROMPT_CHARS)
    expect((await browser.request('POST', '/api/lb10/runs', { body: runOf(atLimit) })).status).toBe(202)

    mock.reset()
    const posts = mock.requests.length
    const tooBig = await browser.request('POST', '/api/lb10/runs', { body: runOf(`${PRODUCTION}${'\u{1F600}'.repeat(11_000)}`) })
    expect(tooBig.status).toBe(413)
    expect(tooBig.json.error.code).toBe('payload_too_large')
    expect(mock.requests.slice(posts).filter(request => request.method === 'POST')).toEqual([])
  })
})
