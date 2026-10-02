// Contract test: the site's server against the REAL gateway, on a real Redis. The mock back end
// plays the gateway's Scope route well enough for the proxy's tests, but only the real one can
// prove that what the site sends is what the gateway checks: the `web` service token (EdDSA, its
// name as key ID and issuer, the gateway as audience), the route's path and query, the page it
// answers with, and its refusals. The spans are written the way the systems write them, by
// @lb/common's real tracer to the gateway's real stream, so the whole path is the production one:
// tracer, Redis, gateway, site, browser.
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

import { createRun, newRunId, RedisSpanWriter, runScope, Tracer } from '@lb/common'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { buildGateway } from '../../../../services/gateway/src/app.ts'
import { importServiceKeys } from '../../../../services/gateway/src/auth/service-token.ts'
import { loadRouting } from '../../../../services/gateway/src/routing/load.ts'
import { Browser } from '../support/browser.ts'
import { makeTestKeys, startTestSite } from '../support/site-app.ts'
import type { TestSite } from '../support/site-app.ts'

const keys = makeTestKeys()
// The gateway's own test routing: it lets `web` read LB-01's runs, and only those.
const routing = readFileSync(new URL('../../../../services/gateway/test/fixtures/routing.test.yaml', import.meta.url), 'utf8')
const prefix = `lbtest-${randomBytes(6).toString('hex')}:`
let redis: Redis
let gateway: Awaited<ReturnType<typeof buildGateway>>
let gatewayUrl = ''
let site: TestSite

beforeAll(async () => {
  redis = new Redis(inject('redisUrl'), { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: true })
  await redis.connect()
  gateway = await buildGateway({
    routing: loadRouting(routing, {}),
    profile: 'production',
    serviceKeys: await importServiceKeys({ web: keys.webPublic }),
    redis,
    prefix,
  })
  await gateway.listen({ host: '127.0.0.1', port: 0 })
  const address = gateway.server.address()
  gatewayUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  // The site's clock is the real one here, as in production: the gateway checks the token's age against its own.
  site = await startTestSite({ keys, backendUrl: gatewayUrl, clock: { now: Date.now() } })
})

afterAll(async () => {
  await site.close()
  gateway.server.closeAllConnections()
  await gateway.close()
  const stale = await redis.keys(`${prefix}*`)
  if (stale.length > 0) await redis.del(...stale)
  redis.disconnect()
})

/** Writes a small run the way a system does: a root span, a step inside it, and a detail on the step. */
async function writeRun(system: string): Promise<string> {
  const tracer = new Tracer(new RedisSpanWriter(redis, prefix))
  const run = createRun({ system, runId: newRunId(), session: `session-${randomBytes(8).toString('hex')}` })
  await runScope(run, () => tracer.span('support ticket', async () => {
    await tracer.span('classify', (step) => {
      step.set('category', 'damaged')
    })
    await tracer.span('check claims', (step) => {
      step.set('unsupported', 0)
    }, { kind: 'system.tool' })
  }, { kind: 'system.run', attrs: { language: 'en' } }))
  return run.runId
}

describe('the Scope through the real gateway', () => {
  it('reads a run the systems wrote, nested, finished, and in the order the tracer wrote it', async () => {
    const runId = await writeRun('lb-01')
    const browser = new Browser(site)

    const reply = await browser.request('GET', `/api/runs/${runId}/spans`)

    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({ runId, more: false, finished: true })
    expect(reply.json.spans.map((span: { name: string }) => span.name)).toEqual(['classify', 'check claims', 'support ticket'])
    const [classify, claims, root] = reply.json.spans
    expect(root).toMatchObject({ kind: 'system.run', attrs: { language: 'en' } })
    expect(classify.parentId).toBe(root.spanId)
    expect(claims).toMatchObject({ kind: 'system.tool', parentId: root.spanId, attrs: { unsupported: 0 } })
    expect(browser.setCookies).toEqual([])
  })

  it('pages with the cursor the gateway hands out, and a finished run stays finished past its root', async () => {
    const runId = await writeRun('lb-01')
    const browser = new Browser(site)

    const first = await browser.request('GET', `/api/runs/${runId}/spans?limit=2`)
    const second = await browser.request('GET', `/api/runs/${runId}/spans?limit=2&after=${first.json.cursor}`)
    const past = await browser.request('GET', `/api/runs/${runId}/spans?after=${second.json.cursor}`)

    expect(first.json.spans).toHaveLength(2)
    expect(first.json.more).toBe(true)
    expect(second.json.spans.map((span: { name: string }) => span.name)).toEqual(['support ticket'])
    expect(past.json).toMatchObject({ spans: [], finished: true, more: false })
  })

  it('says a run is not there when it never was, and when it is of a system the site\'s server may not read', async () => {
    const browser = new Browser(site)
    const other = await writeRun('lb-05')

    for (const runId of [newRunId(), other]) {
      const reply = await browser.request('GET', `/api/runs/${runId}/spans`)
      expect(reply.status).toBe(404)
      expect(reply.json.error.code).toBe('run_not_found')
    }
  })

  it('is refused by the gateway when the site holds a key the gateway does not know, and the visitor sees only a 502', async () => {
    const stranger = await startTestSite({ keys: { ...keys, webJwk: makeTestKeys().webJwk }, backendUrl: gatewayUrl, clock: { now: Date.now() } })
    try {
      const reply = await new Browser(stranger).request('GET', `/api/runs/${newRunId()}/spans`)

      expect(reply.status).toBe(502)
      expect(reply.json.error.code).toBe('upstream_failed')
      expect(reply.text).not.toMatch(/service token|kid/i)
    }
    finally {
      await stranger.close()
    }
  })
})
