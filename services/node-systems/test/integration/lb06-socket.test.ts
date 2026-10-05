// LB-06's WebSocket on a real port, over the real Redis feed: the hello with the token in the first
// frame, the `ready` with the incident and the events after the one the page holds, every event the
// worker appends arriving live and in order, a page that reconnects and gets only what it missed,
// and the refusals: no hello in time, a bad frame, a binary frame, a frame too big, a token for
// another system, somebody else's incident, a second hello, and a visitor with too many connections.
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { WebSocket } from 'ws'

import { RedisFeedWriter } from '../../src/modules/lb06/engine/feed.ts'
import { CLOSE, MAX_CONNECTIONS_PER_VISITOR } from '../../src/modules/lb06/engine/socket.ts'
import type { ServerFrame } from '../../src/modules/lb06/engine/socket.ts'
import { startIncident } from '../../src/modules/lb06/engine/service.ts'
import { lastSeq } from '../../src/modules/lb06/engine/store.ts'
import { createLb06ApiHarness } from '../support/lb06-api.ts'
import type { Lb06ApiHarness } from '../support/lb06-api.ts'
import { VISITOR_A, VISITOR_B } from '../support/lb06-engine.ts'
import { waitFor } from '../support/wait.ts'
import { Redis } from 'ioredis'

const serverUrl = inject('databaseUrl')
const redisUrl = inject('redisUrl')
const prefix = `lbtest-${randomBytes(4).toString('hex')}:`
let api: Lb06ApiHarness
let url: string
let redis: Redis

/** A socket to the server, with what it received and how it closed. */
interface Client {
  socket: WebSocket
  frames: ServerFrame[]
  closed: Promise<number>
  send: (frame: unknown) => void
  nextFrame: (match?: (frame: ServerFrame) => boolean) => Promise<ServerFrame>
}

/** Opens a socket and collects what it gets. */
async function connect(): Promise<Client> {
  const socket = new WebSocket(url)
  const frames: ServerFrame[] = []
  const waiters: ((frame: ServerFrame) => void)[] = []
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as ServerFrame
    frames.push(frame)
    for (const waiter of waiters.splice(0)) waiter(frame)
  })
  const closed = new Promise<number>(resolve => socket.on('close', code => resolve(code)))
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return {
    socket,
    frames,
    closed,
    send: frame => socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame)),
    nextFrame: match => waitFor('a frame', async () => {
      const found = frames.find(frame => !match || match(frame))
      if (found) frames.splice(frames.indexOf(found), 1)
      return found
    }, 5_000),
  }
}

beforeAll(async () => {
  api = await createLb06ApiHarness(serverUrl, { redisUrl, redisPrefix: prefix, feed: new RedisFeedWriter(new Redis(redisUrl, { maxRetriesPerRequest: null }), prefix) })
  redis = new Redis(redisUrl, { maxRetriesPerRequest: null })
  await api.app.listen({ host: '127.0.0.1', port: 0 })
  url = `ws://127.0.0.1:${(api.app.server.address() as AddressInfo).port}/ws/lb06/`
})
afterAll(async () => {
  const keys = await redis.keys(`${prefix}*`)
  if (keys.length > 0) await redis.del(...keys)
  redis.disconnect()
  await api.close()
})

describe('the hello and the feed', () => {
  it('answers a hello with the incident and its events, then every event live, in order; a reconnecting page gets only what it missed', async () => {
    const incident = await startIncident(api.engine.deps, VISITOR_A, { from: 'sample', sampleId: 'bad-deploy' })
    const client = await connect()
    client.send({ type: 'hello', token: api.tokenFor(VISITOR_A), incident: incident.id, after: 0 })
    const ready = await client.nextFrame(frame => frame.type === 'ready')
    if (ready.type !== 'ready') throw new Error('not ready')
    expect(ready.incident.id).toBe(incident.id)
    expect(ready.events.map(event => event.seq)).toEqual(ready.events.map((_, index) => index + 1))
    expect(ready.events.at(-1)?.seq).toBe(incident.lastSeq)

    const job = api.engine.drive()
    const alert = await client.nextFrame(frame => frame.type === 'event' && frame.event.kind === 'alert.fired')
    expect(alert.type).toBe('event')
    const seen = [...ready.events.map(event => event.seq), ...client.frames.flatMap(frame => (frame.type === 'event' ? [frame.event.seq] : []))]
    for (let index = 1; index < seen.length; index += 1) expect(seen[index]).toBeGreaterThan(seen[index - 1] as number)

    // A second page that joins late gets the events after the one it holds, and nothing twice.
    // It holds the first two events after the opening, so the log must reach the third before it joins: the clock ticks on its own, and a slow machine has not always got there.
    const held = incident.lastSeq + 2
    await waitFor('an event after the two the late page holds', async () => (await lastSeq(api.engine.deps.db, incident.id)) > held, 20_000)
    const late = await connect()
    late.send({ type: 'hello', token: api.tokenFor(VISITOR_A), incident: incident.id, after: held })
    const lateReady = await late.nextFrame(frame => frame.type === 'ready')
    if (lateReady.type !== 'ready') throw new Error('not ready')
    expect(lateReady.events[0]?.seq).toBe(held + 1)
    await waitFor('the proposal', async () => (lateReady.incident.state === 'awaiting_approval') || client.frames.some(frame => frame.type === 'event' && frame.event.kind === 'proposal.made') || late.frames.some(frame => frame.type === 'event' && frame.event.kind === 'proposal.made'), 20_000)
    const row = await api.engine.deps.db.query.incidents.findFirst()
    expect(row?.pendingProposal?.id).toBe('p1')
    await api.call('POST', `/incidents/${incident.id}/proposals/p1/decision`, VISITOR_A, { decision: 'approve' })
    const closedFrame = await late.nextFrame(frame => frame.type === 'event' && frame.event.kind === 'incident.closed')
    expect(closedFrame.type).toBe('event')
    await job
    const lateSeqs = [...lateReady.events.map(event => event.seq), ...late.frames.flatMap(frame => (frame.type === 'event' ? [frame.event.seq] : []))]
    expect(new Set(lateSeqs).size).toBe(lateSeqs.length)
    client.socket.close()
    late.socket.close()
  }, 40_000)
})

describe('the refusals', () => {
  it('closes a connection that says nothing in time, and one that says something other than a hello', async () => {
    const silent = await connect()
    expect(await silent.closed).toBe(CLOSE.timedOut)
    const chatty = await connect()
    chatty.send('not json')
    expect(await chatty.closed).toBe(CLOSE.badFrame)
    const wrong = await connect()
    wrong.send({ type: 'message', text: 'hi' })
    expect(await wrong.closed).toBe(CLOSE.badFrame)
  })

  it('refuses a binary frame, a frame too big, a token for another system, and somebody else\'s incident', async () => {
    const binary = await connect()
    binary.socket.send(Buffer.from([1, 2, 3]))
    expect(await binary.closed).toBe(CLOSE.unsupported)
    const big = await connect()
    big.send({ type: 'hello', token: 'x'.repeat(5_000), incident: '11111111-1111-4111-8111-111111111111' })
    expect([CLOSE.tooBig, CLOSE.badFrame]).toContain(await big.closed)
    const foreign = await connect()
    foreign.send({ type: 'hello', token: api.tokenFor(VISITOR_B, 'lb-02'), incident: '11111111-1111-4111-8111-111111111111' })
    expect(await foreign.closed).toBe(CLOSE.unauthorized)
    const incident = await startIncident(api.engine.deps, VISITOR_B, { from: 'sample', sampleId: 'cache-stampede' })
    const other = await connect()
    other.send({ type: 'hello', token: api.tokenFor('session-someone-else-000000'), incident: incident.id })
    expect(await other.closed).toBe(CLOSE.notFound)
  })

  it('answers a second hello with an error, and caps a visitor\'s connections', async () => {
    const incident = (await api.engine.deps.db.query.incidents.findFirst({ where: (table, { eq }) => eq(table.sessionKey, VISITOR_B) }))
    if (!incident) throw new Error('no incident')
    const clients: Client[] = []
    for (let index = 0; index < MAX_CONNECTIONS_PER_VISITOR; index += 1) {
      const client = await connect()
      client.send({ type: 'hello', token: api.tokenFor(VISITOR_B), incident: incident.id })
      await client.nextFrame(frame => frame.type === 'ready')
      clients.push(client)
    }
    clients[0]?.send({ type: 'hello', token: api.tokenFor(VISITOR_B), incident: incident.id })
    const again = await clients[0]?.nextFrame(frame => frame.type === 'error')
    expect(again).toEqual({ type: 'error', code: 'already_said_hello' })
    const extra = await connect()
    extra.send({ type: 'hello', token: api.tokenFor(VISITOR_B), incident: incident.id })
    const refused = await extra.nextFrame(frame => frame.type === 'error')
    expect(refused).toEqual({ type: 'error', code: 'too_many_connections' })
    expect(await extra.closed).toBe(CLOSE.tryAgainLater)
    for (const client of clients) client.socket.close()
    await waitFor('the places given back', async () => api.engine.deps !== undefined && clients.every(client => client.socket.readyState === WebSocket.CLOSED))
  })
})
