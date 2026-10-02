// Integration tests for the Scope's route, GET /v1/runs/{runId}/spans, on a real Redis:
// who may read a trace, how a live run is polled with a cursor, how big a response can
// be, what is refused, and that a trace holds metadata and never a visitor's words.
import { randomBytes } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RedisSpanSink } from '../../src/spans.ts'
import type { Span } from '../../src/spans.ts'
import { answer } from '../support/fake-provider.ts'
import { chatBody, startGateway } from '../support/gateway.ts'
import type { TestGateway } from '../support/gateway.ts'

// The test routing table lets `web` read LB-01's runs, and only those.
const START = 1_790_000_000_000
// Words a visitor wrote and a model answered: they must never appear in a trace.
const VISITOR_WORDS = 'my gate code is 4471-PRIVATE-TICKET-TEXT'
const MODEL_WORDS = 'PRIVATE-ANSWER-TEXT: refund approved for Sam Carter'

let gw: TestGateway
let sink: RedisSpanSink

beforeEach(async () => {
  gw = await startGateway()
  sink = new RedisSpanSink(gw.redis, gw.prefix, { warn: () => undefined })
})

afterEach(async () => {
  await gw.close()
})

/** Makes a run ID of the right shape that no other test uses. */
function newRunId(): string {
  return `run-${randomBytes(6).toString('hex')}`
}

/** One page of a run's trace, as the route answers it. */
interface Page {
  runId: string
  spans: Span[]
  cursor: string
  more: boolean
  finished: boolean
}

/** Asks for a run's spans as `service` (the site's server by default). `query` is the text after the `?`. */
async function readSpans(runId: string, query = '', service = 'web') {
  const url = `/v1/runs/${encodeURIComponent(runId)}/spans${query === '' ? '' : `?${query}`}`
  return gw.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${await gw.token(service)}` } })
}

/** Reads a page that is expected to succeed. */
async function pageOf(runId: string, query = ''): Promise<Page> {
  const response = await readSpans(runId, query)
  expect(response.statusCode).toBe(200)
  return response.json<Page>()
}

/** Builds a valid span of a run, number `index`, with any field overridden. */
function systemSpan(runId: string, index: number, overrides: Partial<Span> = {}): Span {
  return {
    v: 1,
    runId,
    system: 'lb-01',
    spanId: index.toString(16).padStart(16, '0'),
    parentId: undefined,
    kind: 'system.step',
    name: `step ${index}`,
    status: 'ok',
    startMs: START + index * 10,
    endMs: START + index * 10 + 5,
    attrs: { chunks: index },
    ...overrides,
  }
}

/** Writes a stream entry the way a writer would, but with any text as its span: for entries nobody should ever write. */
async function writeRaw(runId: string, text: string): Promise<void> {
  await gw.redis.xadd(`${gw.prefix}run:${runId}:spans`, '*', 'span', text)
}

/** Sends a chat call to the gateway for LB-01's run, as the Django systems do, with the visitor's words in the prompt. */
async function chatInRun(runId: string): Promise<void> {
  const body = chatBody({ messages: [{ role: 'user', content: VISITOR_WORDS }] })
  const response = await gw.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: await gw.headers({ 'x-lb-run-id': runId }), payload: body })
  expect(response.statusCode).toBe(200)
}

describe('who may read a trace', () => {
  it('lets the site\'s server read a run it may see', async () => {
    const runId = newRunId()
    await sink.emit([systemSpan(runId, 1)])

    const response = await readSpans(runId)

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toMatchObject({ runId, spans: [{ name: 'step 1' }], finished: false, more: false })
  })

  it('refuses a call without a service token', async () => {
    const runId = newRunId()
    await sink.emit([systemSpan(runId, 1)])

    const response = await gw.app.inject({ method: 'GET', url: `/v1/runs/${runId}/spans` })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'invalid_service_token' } })
  })

  it('refuses a service that makes model calls, even for a run of its own system', async () => {
    const runId = newRunId()
    await chatInRun(runId)

    for (const service of ['django-systems', 'flask-systems']) {
      const response = await readSpans(runId, '', service)

      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual({ error: { message: expect.any(String), type: 'permission_error', code: 'permission_denied' } })
    }
  })

  it('does not let the trace reader call a model, whatever it asks for', async () => {
    const authorization = `Bearer ${await gw.token('web')}`
    const headers = { authorization, 'x-lb-system': 'lb-01', 'x-lb-run-id': newRunId(), 'x-lb-data-class': 'synthetic' }
    const calls = [
      { url: '/v1/chat/completions', payload: chatBody() },
      { url: '/v1/embeddings', payload: { model: 'lb-embed', input: 'a bag of Basalt Blend' } },
      { url: '/v1/rerank', payload: { model: 'lb-rerank', query: 'torn bag', documents: ['one', 'two'] } },
      { url: '/v1/guard', payload: { model: 'lb-guard', input: 'hello there' } },
    ]

    for (const call of calls) {
      const response = await gw.app.inject({ method: 'POST', url: call.url, headers, payload: call.payload })

      expect(response.statusCode, call.url).toBe(403)
      expect(response.json(), call.url).toMatchObject({ error: { code: 'system_not_allowed' } })
    }
    const models = await gw.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization } })
    expect(models.json()).toEqual({ object: 'list', data: [] })
    for (const provider of Object.values(gw.providers)) expect(provider.requests).toHaveLength(0)
  })

  it('shows a reader only the runs of the systems it lists', async () => {
    // The test routing lets `web` read LB-01, not LB-05.
    const runId = newRunId()
    const headers = await gw.headers({ 'authorization': `Bearer ${await gw.token('flask-systems')}`, 'x-lb-system': 'lb-05', 'x-lb-run-id': runId })
    const chat = await gw.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: chatBody() })
    expect(chat.statusCode).toBe(200)
    expect(await gw.runSpans(runId)).not.toHaveLength(0)

    const response = await readSpans(runId)

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'run_not_found' } })
  })
})

describe('polling a live run', () => {
  it('returns the gateway\'s spans and the system\'s own in the order they were written, nested', async () => {
    const runId = newRunId()
    const stepId = '00000000000000aa'
    // The system's step is open while the call runs, so its span is written after the call's.
    const response = await gw.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: await gw.headers({ 'x-lb-run-id': runId, 'x-lb-parent-span': stepId }), payload: chatBody() })
    expect(response.statusCode).toBe(200)
    await sink.emit([systemSpan(runId, 1, { spanId: stepId, name: 'classify', attrs: { category: 'damaged' } })])
    await sink.emit([systemSpan(runId, 2, { kind: 'system.run', name: 'support ticket', attrs: { language: 'en' } })])

    const page = await pageOf(runId)

    expect(page.spans.map(span => [span.kind, span.name])).toEqual([
      ['gateway.attempt', 'alpha/small'],
      ['gateway.call', 'lb-fast'],
      ['system.step', 'classify'],
      ['system.run', 'support ticket'],
    ])
    const [attempt, call] = page.spans
    expect(call?.parentId).toBe(stepId)
    expect(attempt?.parentId).toBe(call?.spanId)
    expect(page.spans.every(span => span.runId === runId)).toBe(true)
    expect(page.finished).toBe(true)
    expect(page.more).toBe(false)
  })

  it('hands out a cursor, and returns only what was written after it', async () => {
    const runId = newRunId()
    await sink.emit([systemSpan(runId, 1), systemSpan(runId, 2)])

    const first = await pageOf(runId)
    expect(first.spans.map(span => span.name)).toEqual(['step 1', 'step 2'])
    expect(first.finished).toBe(false)

    const quiet = await pageOf(runId, `after=${first.cursor}`)
    expect(quiet).toEqual({ runId, spans: [], cursor: first.cursor, more: false, finished: false })

    await sink.emit([systemSpan(runId, 3)])
    const next = await pageOf(runId, `after=${first.cursor}`)
    expect(next.spans.map(span => span.name)).toEqual(['step 3'])
    expect(next.cursor).not.toBe(first.cursor)
  })

  it('says a run has finished once its root span is written, and keeps saying so to a client past it', async () => {
    const runId = newRunId()
    await sink.emit([systemSpan(runId, 1)])
    const before = await pageOf(runId)

    await sink.emit([systemSpan(runId, 2, { kind: 'system.run', name: 'support ticket' })])
    const done = await pageOf(runId, `after=${before.cursor}`)
    const later = await pageOf(runId, `after=${done.cursor}`)

    expect(before.finished).toBe(false)
    expect(done.finished).toBe(true)
    expect(done.spans.map(span => span.name)).toEqual(['support ticket'])
    expect(later).toMatchObject({ spans: [], finished: true, cursor: done.cursor })
  })

  it('does not take a nested system.run span for the end of the run', async () => {
    const runId = newRunId()
    await sink.emit([systemSpan(runId, 1, { kind: 'system.run', parentId: '00000000000000ff' })])

    expect((await pageOf(runId)).finished).toBe(false)
  })

  it('says a run that goes on in turns has finished when its root is written last, though its turns named the root before it existed', async () => {
    const runId = newRunId()
    const rootId = 'a1b2c3d4e5f60718'
    await sink.emit([systemSpan(runId, 1, { parentId: rootId }), systemSpan(runId, 2, { parentId: rootId })])
    const open = await pageOf(runId)

    await sink.emit([systemSpan(runId, 3, { kind: 'system.run', name: 'booking conversation', spanId: rootId })])
    const done = await pageOf(runId, `after=${open.cursor}`)

    expect(open.finished).toBe(false)
    expect(done.finished).toBe(true)
    expect(done.spans.map(span => span.name)).toEqual(['booking conversation'])
  })

  it('keeps saying a run has finished while a few spans written after its root pile up behind it', async () => {
    const runId = newRunId()
    await sink.emit([systemSpan(runId, 1, { kind: 'system.run', name: 'booking conversation' })])
    // The reader looks for the root among the last 32 entries, so 29 spans after it don't hide it. (LB-02 writes
    // nothing at all after the root of a conversation.)
    await sink.emit(Array.from({ length: 29 }, (_, index) => systemSpan(runId, index + 2)))

    const atTheRoot = await pageOf(runId, 'limit=1')
    const later = await pageOf(runId, `limit=5&after=${atTheRoot.cursor}`)

    expect(atTheRoot.spans.map(span => span.name)).toEqual(['booking conversation'])
    expect(later.spans.map(span => span.name)).toEqual(['step 2', 'step 3', 'step 4', 'step 5', 'step 6'])
    expect(later.finished).toBe(true)
  })

  it('pages through a long run without losing or repeating a span', async () => {
    const runId = newRunId()
    await sink.emit(Array.from({ length: 450 }, (_, index) => systemSpan(runId, index + 1)))

    const seen: string[] = []
    let query = 'limit=200'
    for (let requests = 0; requests < 10; requests += 1) {
      const page = await pageOf(runId, query)
      seen.push(...page.spans.map(span => span.name))
      expect(page.spans.length).toBeLessThanOrEqual(200)
      if (!page.more) break
      query = `limit=200&after=${page.cursor}`
    }

    expect(seen).toEqual(Array.from({ length: 450 }, (_, index) => `step ${index + 1}`))
  })
})

describe('how big a response can be', () => {
  it('answers 200 spans a page unless asked for fewer, and never more than 500', async () => {
    const runId = newRunId()
    await sink.emit(Array.from({ length: 520 }, (_, index) => systemSpan(runId, index + 1)))

    const byDefault = await pageOf(runId)
    const most = await pageOf(runId, 'limit=500')
    const refused = await readSpans(runId, 'limit=501')

    expect(byDefault.spans).toHaveLength(200)
    expect(byDefault.more).toBe(true)
    expect(most.spans).toHaveLength(500)
    expect(refused.statusCode).toBe(400)
  })

  it('cuts a page at a byte budget, and the next page carries on from the cut', async () => {
    const runId = newRunId()
    // 34 details of 200 characters make a span of about 7 KB, under the 8 KB a span may take:
    // 50 of them overflow a 256 KB page.
    const heavy = Object.fromEntries(Array.from({ length: 34 }, (_, index) => [`detail${index}`, 'x'.repeat(200)]))
    await sink.emit(Array.from({ length: 50 }, (_, index) => systemSpan(runId, index + 1, { attrs: heavy })))

    const first = await pageOf(runId, 'limit=500')
    const second = await pageOf(runId, `limit=500&after=${first.cursor}`)

    expect(first.spans.length).toBeGreaterThan(0)
    expect(first.spans.length).toBeLessThan(50)
    expect(first.more).toBe(true)
    expect(JSON.stringify(first).length).toBeLessThan(300 * 1024)
    expect(first.spans.length + second.spans.length).toBe(50)
    expect(second.spans[0]?.name).toBe(`step ${first.spans.length + 1}`)
  })

  it('passes over a span that is too big to be metadata', async () => {
    const runId = newRunId()
    const huge = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`detail${index}`, 'x'.repeat(200)]))
    await sink.emit([systemSpan(runId, 1), systemSpan(runId, 2, { attrs: huge }), systemSpan(runId, 3)])

    expect((await pageOf(runId)).spans.map(span => span.name)).toEqual(['step 1', 'step 3'])
  })
})

describe('what is refused', () => {
  it('answers 404 in the platform\'s error shape for a run that is not there', async () => {
    const response = await readSpans(newRunId())

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: { message: expect.any(String), type: 'not_found_error', code: 'run_not_found' } })
  })

  it('answers a run whose trace has expired the same way as one that never existed', async () => {
    const runId = newRunId()
    await sink.emit([systemSpan(runId, 1)])
    await gw.redis.del(`${gw.prefix}run:${runId}:spans`)

    const expired = await readSpans(runId)
    const unknown = await readSpans(newRunId())

    expect(expired.statusCode).toBe(404)
    expect(expired.json()).toEqual(unknown.json())
  })

  it('refuses a run ID or cursor of the wrong shape before it reads anything', async () => {
    const runId = newRunId()
    await sink.emit([systemSpan(runId, 1)])

    for (const bad of ['short', 'x'.repeat(65), 'run:with:colons', 'run-%2e%2e%2f..', 'run id with spaces']) {
      const response = await readSpans(bad)
      expect(response.statusCode, bad).toBe(400)
      expect(response.json(), bad).toMatchObject({ error: { code: 'invalid_request' } })
    }
    for (const query of ['after=0', 'after=abc', 'after=1-2-3', 'after=(1-0', 'after=1-0%20extra', 'limit=0', 'limit=1.5', 'limit=many']) {
      const response = await readSpans(runId, query)
      expect(response.statusCode, query).toBe(400)
    }
  })

  it('knows no other paths under a run', async () => {
    const runId = newRunId()

    for (const path of [`/v1/runs/${runId}`, `/v1/runs/${runId}/spans/extra`, `/v1/runs/${runId}/events`]) {
      const response = await gw.app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${await gw.token('web')}` } })
      expect(response.statusCode, path).toBe(404)
    }
    const post = await gw.app.inject({ method: 'POST', url: `/v1/runs/${runId}/spans`, headers: { authorization: `Bearer ${await gw.token('web')}` }, payload: {} })
    expect(post.statusCode).toBe(404)
  })

  it('fails closed when Redis is down, and says nothing about why', async () => {
    await gw.close()
    gw = await startGateway({ redisUrl: 'redis://127.0.0.1:1' })

    const response = await readSpans(newRunId())

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ error: { message: 'The trace store is unavailable.', type: 'api_error', code: 'gateway_unavailable' } })
  })
})

describe('what a trace holds', () => {
  it('passes over entries that are not valid spans, spans of another run, and spans of a system the reader may not see', async () => {
    const runId = newRunId()
    await sink.emit([systemSpan(runId, 1)])
    await writeRaw(runId, 'not json at all')
    await writeRaw(runId, JSON.stringify({ ...systemSpan(runId, 2), prompt: VISITOR_WORDS }))
    await writeRaw(runId, JSON.stringify(systemSpan(runId, 3, { attrs: { note: VISITOR_WORDS.repeat(10) } })))
    await writeRaw(runId, JSON.stringify(systemSpan(runId, 4, { name: `${VISITOR_WORDS}\n` })))
    await writeRaw(runId, JSON.stringify(systemSpan(newRunId(), 5)))
    await writeRaw(runId, JSON.stringify(systemSpan(runId, 6, { system: 'lb-05' })))
    await writeRaw(runId, JSON.stringify(systemSpan(runId, 7, { attrs: { nested: { words: VISITOR_WORDS } as unknown as string } })))
    await sink.emit([systemSpan(runId, 8)])

    const page = await pageOf(runId)

    expect(page.spans.map(span => span.name)).toEqual(['step 1', 'step 8'])
    // The cursor moved past everything that was passed over, so a poll never stalls on it.
    expect((await pageOf(runId, `after=${page.cursor}`)).spans).toEqual([])
    expect(JSON.stringify(page)).not.toContain('PRIVATE-TICKET-TEXT')
  })

  it('never carries a visitor\'s words or a model\'s answer, in spans the gateway really wrote', async () => {
    const runId = newRunId()
    // The first provider fails and echoes the prompt in its error message, as providers do.
    gw.providers.alpha.enqueue({ kind: 'json', status: 500, body: { error: { message: `bad request: ${VISITOR_WORDS}` } } })
    gw.providers.beta.enqueue(answer(MODEL_WORDS))
    gw.providers.alpha.enqueue(answer(MODEL_WORDS))
    await chatInRun(runId)
    await chatInRun(runId)
    await sink.emit([systemSpan(runId, 1, { kind: 'system.run', name: 'support ticket' })])

    const response = await readSpans(runId)
    const page = response.json<Page>()

    expect(page.spans.length).toBeGreaterThanOrEqual(4)
    expect(response.body).not.toContain('PRIVATE-TICKET-TEXT')
    expect(response.body).not.toContain('PRIVATE-ANSWER-TEXT')
    expect(response.body).not.toContain('Sam Carter')
    for (const span of page.spans) {
      expect(Object.keys(span).sort()).toEqual(expect.arrayContaining(['attrs', 'endMs', 'kind', 'name', 'runId', 'spanId', 'startMs', 'status', 'system', 'v']))
      for (const value of Object.values(span.attrs)) {
        expect(['string', 'number', 'boolean']).toContain(typeof value)
        if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(200)
      }
    }
  })
})
