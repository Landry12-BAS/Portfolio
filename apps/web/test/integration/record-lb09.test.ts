// Tests of recording LB-09's samples: against the test mock (a real HTTP server that plays the meeting
// service, its worker's stages and the gateway's trace route) the recorder starts a sample meeting, reads it
// until the worker is done, then reads its transcript and its items. A curated meeting is recorded only when
// it found the decisions and actions its card promises. They run on the mock and say so: a recording made
// here is labelled the mock's and is never shown to a visitor of the real site.
import { startMockBackend } from '@lb/api-clients/testing'
import type { MockBackend } from '@lb/api-clients/testing'
import { ServiceTokens, privateKeyFromJwk } from '@lb/common/tokens'
import { recordingSchema } from '@lb/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Backend } from '../../scripts/record/backend.ts'
import type { Clock } from '../../scripts/record/backend.ts'
import { recordSample } from '../../scripts/record/record.ts'
import { makeTestKeys } from '../support/site-app.ts'

const keys = makeTestKeys()
let now = Date.now()
let mock: MockBackend

/** A clock that moves only when the recorder waits, shared by the recorder, its tokens and the mock. */
const clock: Clock = {
  now: () => now,
  sleep: (ms) => {
    now += ms
    return Promise.resolve()
  },
}

/** A recorder pointed at the mock, optionally through a different `fetch`. */
function backend(fetchThrough: typeof fetch = fetch): Backend {
  return new Backend({
    apiUrl: new URL(mock.url),
    gatewayUrl: new URL(mock.url),
    signingKey: privateKeyFromJwk(JSON.parse(keys.siteJwk)),
    gatewayTokens: new ServiceTokens('web', privateKeyFromJwk(JSON.parse(keys.webJwk)), () => now / 1_000),
    fetch: fetchThrough,
    clock,
  })
}

/** A `fetch` that answers a meeting's items with what `change` makes of them, as a weaker extraction would. */
function itemsChangedBy(change: (items: { kind: string }[]) => { kind: string }[]): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init)
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (!url.pathname.endsWith('/items')) return response
    const found = await response.json() as { items: { kind: string }[], dropped: number }
    return Response.json({ ...found, items: change(found.items), dropped: found.dropped + 1 })
  }
}

beforeAll(async () => {
  mock = await startMockBackend({ siteKey: keys.sitePublic, webKey: keys.webPublic, now: clock.now })
})

beforeEach(() => {
  mock.reset()
})

afterAll(async () => {
  await mock.close()
})

describe('recording LB-09 samples against the mock', () => {
  it('records a meeting that found the decisions and actions its card promises, ending with its items', async () => {
    const recording = await recordSample(backend(), 'lb-09', 'monday-roasting-plan')

    expect(recordingSchema.safeParse(recording).success).toBe(true)
    expect(recording).toMatchObject({ system: 'lb-09', sample: 'monday-roasting-plan', origin: 'mock', language: 'en' })
    expect(recording.exchanges.at(-1)?.request.path).toMatch(/\/items$/)
  })

  it('does not record a meeting that lost an item to the checks, since the card would promise what the replay lacks', async () => {
    const lost = itemsChangedBy(items => items.slice(1))

    await expect(recordSample(backend(lost), 'lb-09', 'monday-roasting-plan')).rejects.toThrow(/came out with 1 decisions and 3 actions \(1 dropped by the checks\), where its card promises 2 and 3/)
  })

  it('does not record a meeting that found an item its card does not promise', async () => {
    const extra = itemsChangedBy(items => [...items, { ...items[0]!, kind: 'decision' }])

    await expect(recordSample(backend(extra), 'lb-09', 'weekend-staffing')).rejects.toThrow(/where its card promises 0 and 1/)
  })
})
