// Tests of LB-06's board state against the fake site: starting an incident and following it over the
// WebSocket, drawing its minutes as they come, the proposal that waits and the visitor's answer, the
// postmortem, ending an incident early, the day's allowance, the check a new day asks for again, a
// network that blocks WebSockets (the log is polled instead), a connection that drops and is opened
// again without losing or repeating an event, pausing the charts, opening an incident after a reload,
// a replay of a recording, and the ways the back end can say no. The back end is the mock with the real
// simulator behind it; the clock is the test's.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordingSchema } from '@lb/contracts'
import type { Recording } from '@lb/contracts'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POLL_MS, useLb06Store } from '~/boards/lb-06/store'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'
import type { FakeSiteOptions } from '../support/fake-site'
import { FakeLb06Site, SESSION } from '../support/lb06-site'

const TODAY = new Date('2026-10-02T09:30:00.000Z')
const FIXTURES = join(import.meta.dirname, '../../e2e/fixtures/recordings/lb-06')

/** One of the committed recordings, made to look like a real one (the site shows only those). */
function liveRecording(sample: string): Recording {
  return recordingSchema.parse({ ...JSON.parse(readFileSync(join(FIXTURES, `${sample}.json`), 'utf8')) as object, origin: 'live' })
}

/** Starts a fake site and a fresh store reading through it, with the session loaded. */
async function begin(options: FakeSiteOptions = {}) {
  const site = new FakeLb06Site({ verified: true, ...options })
  vi.stubGlobal('fetch', site.fetch)
  vi.stubGlobal('WebSocket', site.socketClass())
  vi.stubGlobal('location', new URL('http://site.test/'))
  setActivePinia(createPinia())
  const session = useSessionStore()
  await session.load()
  return { site, store: useLb06Store(), session, scope: useScopeStore() }
}

/** Moves the clock on and lets what is waiting settle. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** Moves the clock on in small steps until something is true, and fails if it never is. */
async function until(done: () => boolean, what: string, limitMs = 30_000): Promise<void> {
  for (let waited = 0; waited < limitMs; waited += 20) {
    if (done()) return
    await advance(20)
  }
  throw new Error(`Gave up waiting for ${what}.`)
}

describe('LB-06\'s store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(TODAY)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('looks for the trace again when the incident ends if the Scope had given up: an incident that reuses an earlier run\'s answers writes only its root span, after the end', async () => {
    const { site, store, scope } = await begin()
    site.hideTraceUntilEnd = true
    await store.start({ from: 'sample', sampleId: 'bad-deploy' })
    await until(() => scope.phase === 'missing', 'the Scope to give up looking', 20_000)
    expect(scope.spans).toHaveLength(0)
    await until(() => store.pending !== undefined, 'the proposal')
    await store.decide('approve')
    await until(() => store.runPhase === 'over', 'the incident to end', 60_000)
    await until(() => scope.phase === 'finished', 'the Scope to find the trace', 20_000)
    expect(scope.spans.length).toBeGreaterThan(0)
  })

  it('starts a curated incident live, follows it over the socket, and draws its minutes as they come', async () => {
    const { site, store, scope } = await begin()
    await store.start({ from: 'sample', sampleId: 'bad-deploy' })
    expect(site.callsTo('/api/lb06/incidents', 'POST')).toHaveLength(1)
    expect(site.callsTo('/api/lb06/incidents', 'POST')[0]?.body).toEqual({ from: 'sample', sampleId: 'bad-deploy' })
    expect(store.runMode).toBe('live')
    expect(store.runPhase).toBe('following')
    expect(store.incident?.origin).toBe('sample')
    expect(scope.runId).toBe(store.incident?.runId)
    await until(() => store.feed === 'open', 'the socket to open')
    expect(store.events.length).toBeGreaterThan(30)
    const before = store.ticks.length
    await advance(300)
    expect(store.ticks.length).toBeGreaterThan(before)
    expect(JSON.parse(site.socket.sent[0] ?? '{}')).toMatchObject({ type: 'hello', incident: store.incident?.id })
    expect(site.socket.url).toBe('ws://api.test/ws/lb06/')
    store.dispose()
  })

  it('goes through a whole incident: the alert, the agents, the proposal, the visitor\'s approval, the recovery and the postmortem', async () => {
    const { site, store } = await begin()
    await store.start({ from: 'sample', sampleId: 'bad-deploy' })
    await until(() => store.pending !== undefined, 'the proposal')
    expect(store.state).toBe('awaiting_approval')
    expect(store.pending).toMatchObject({ id: 'p1', action: { kind: 'rollback', service: 'cart' } })
    expect(store.hypotheses?.[0]).toMatchObject({ service: 'cart', cause: 'bad_deploy' })
    expect(store.steps.length).toBeGreaterThan(5)
    await store.decide('approve')
    expect(site.callsTo('/api/lb06/incidents/', 'POST').some(call => call.path.endsWith('/proposals/p1/decision'))).toBe(true)
    await until(() => store.ended, 'the incident to end')
    expect(store.state).toBe('closed')
    expect(store.runPhase).toBe('over')
    expect(store.feed).toBe('idle')
    await until(() => store.postmortem !== undefined, 'the postmortem')
    expect(store.postmortem?.timeline.length).toBeGreaterThan(3)
    expect(store.pending).toBeUndefined()
    await until(() => store.incident?.modelCalls === store.modelCalls && store.incident?.state === 'closed', 'the view to catch up with the log')
    expect(store.markers.map(marker => marker.kind)).toEqual(['fault', 'alert', 'investigation', 'remediation', 'recovered'])
    expect(site.callsTo('/api/lb06/limits').length).toBeGreaterThan(0)
  })

  it('sends the agents back to work when the visitor rejects a proposal, and a new one comes', async () => {
    const { store } = await begin()
    await store.start({ from: 'sample', sampleId: 'bad-deploy' })
    await until(() => store.pending?.id === 'p1', 'the first proposal')
    await store.decide('reject')
    await until(() => store.pending?.id === 'p2', 'the second proposal')
    expect(store.state).toBe('awaiting_approval')
    store.dispose()
  })

  it('ends the incident early when asked, and says it has no postmortem', async () => {
    const { store } = await begin()
    await store.start({ from: 'sample', sampleId: 'bad-deploy' })
    await until(() => store.feed === 'open', 'the socket to open')
    await store.abort()
    await until(() => store.ended, 'the incident to end')
    expect(store.state).toBe('aborted')
    expect(store.incident?.endReason).toBe('visitor')
    expect(store.postmortem).toBeUndefined()
    expect(store.canAbort).toBe(false)
  })

  it('counts the day\'s incident as used at once, and refuses a second start without asking', async () => {
    const { site, store } = await begin()
    await store.loadLimits()
    expect(store.quota).toMatchObject({ limit: 1, used: 0, remaining: 1 })
    await store.start({ from: 'sample', sampleId: 'memory-leak' })
    expect(store.quota).toMatchObject({ used: 1, remaining: 0 })
    expect(store.canStart).toBe(false)
    await store.start({ from: 'sample', sampleId: 'bad-deploy' })
    expect(site.callsTo('/api/lb06/incidents', 'POST')).toHaveLength(1)
    store.dispose()
  })

  it('takes the service\'s word that the day\'s incident is used, and says when it starts again', async () => {
    const { site, store } = await begin()
    site.lb06.start(SESSION, { from: 'sample', sampleId: 'bad-deploy' })
    await store.start({ from: 'sample', sampleId: 'cache-stampede' })
    expect(store.problem?.kind).toBe('quota')
    expect(store.problem?.code).toBe('daily_limit')
    expect(store.problem?.resetsAt).toBe('2026-10-03T00:00:00.000Z')
    expect(store.runMode).toBe('idle')
    expect(store.incident).toBeUndefined()
  })

  it('runs the check before it starts, and again once when a new day began', async () => {
    const { site, store } = await begin({ verified: false })
    await store.start({ from: 'sample', sampleId: 'bad-deploy' })
    expect(site.callsTo('/api/session/verify', 'POST')).toHaveLength(1)
    expect(store.incident).toBeDefined()
    store.dispose()
    const again = await begin({ verified: true })
    again.site.failNext('POST /api/lb06/incidents', { status: 403, body: { error: { code: 'verification_required', message: 'x' } } })
    await again.store.start({ from: 'sample', sampleId: 'bad-deploy' })
    expect(again.site.callsTo('/api/session/verify', 'POST')).toHaveLength(1)
    expect(again.site.callsTo('/api/lb06/incidents', 'POST')).toHaveLength(2)
    expect(again.store.incident).toBeDefined()
    again.store.dispose()
  })

  it('says the browser is not keeping the session cookie when the check passes and the service still asks for it', async () => {
    const { site, store } = await begin()
    const refusal = { status: 403, body: { error: { code: 'verification_required', message: 'x' } } }
    site.failNext('POST /api/lb06/incidents', refusal)
    site.failNext('POST /api/lb06/incidents', refusal)
    await store.start({ from: 'sample', sampleId: 'bad-deploy' })
    expect(store.problem?.kind).toBe('cookie')
    expect(store.incident).toBeUndefined()
  })

  it('shows the board\'s own failures: the demo is full, and the agents\' models are out of reach', async () => {
    const { site, store } = await begin()
    site.failNext('POST /api/lb06/incidents', { status: 503, body: { error: { code: 'too_many_incidents', message: 'x' } } })
    await store.start({ from: 'sample', sampleId: 'bad-deploy' })
    expect(store.problem?.code).toBe('too_many_incidents')
    site.lb06.misbehave('agents_down')
    await store.start({ from: 'sample', sampleId: 'bad-deploy' })
    await until(() => store.ended, 'the incident to end')
    expect(store.state).toBe('failed')
    await until(() => store.incident?.endReason === 'agents_unavailable', 'the view to say why')
    // Models out of reach are not the visitor's doing: the day's incident is given back, and the board says so by counting it again.
    await until(() => store.quota?.remaining === 1, 'the day\'s incident to be given back')
  })

  it('reads the log by polling when the network will not carry a WebSocket, and still gets every event once', async () => {
    const { site, store } = await begin()
    site.refuseConnections = true
    await store.start({ from: 'sample', sampleId: 'bad-deploy' })
    await until(() => store.feed === 'polling', 'the board to fall back')
    expect(store.feedEnd).toBe('lost')
    await until(() => store.pending !== undefined, 'the proposal')
    await store.decide('approve')
    await until(() => store.ended, 'the incident to end')
    const numbers = store.events.map(event => event.seq)
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => index + 1))
    expect(site.callsTo('/api/lb06/incidents/', 'GET').filter(call => call.path.includes('/events')).length).toBeGreaterThan(2)
    expect(POLL_MS).toBeGreaterThan(0)
  })

  it('opens the connection again when it drops, and neither loses nor repeats an event', async () => {
    const { site, store } = await begin()
    await store.start({ from: 'sample', sampleId: 'bad-deploy' })
    await until(() => store.feed === 'open', 'the socket to open')
    await advance(200)
    site.socket.serverCloses(1006)
    await until(() => store.feed === 'reconnecting', 'the board to notice')
    await until(() => store.feed === 'open' && site.sockets.length === 2, 'the board to connect again', 40_000)
    await until(() => store.pending !== undefined, 'the proposal')
    const numbers = store.events.map(event => event.seq)
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => index + 1))
    expect(JSON.parse(site.sockets[1]?.sent[0] ?? '{}').after).toBeGreaterThan(30)
    store.dispose()
  })

  it('freezes the charts when paused, keeps the log filling behind them, and catches up when resumed', async () => {
    const { store } = await begin()
    await store.start({ from: 'sample', sampleId: 'bad-deploy' })
    await until(() => store.feed === 'open', 'the socket to open')
    store.pause()
    const frozen = store.ticks.length
    await advance(400)
    expect(store.paused).toBe(true)
    expect(store.ticks.length).toBe(frozen)
    expect(store.events.length).toBeGreaterThan(frozen)
    store.resume()
    expect(store.ticks.length).toBeGreaterThan(frozen)
    store.dispose()
  })

  it('opens the incident the visitor started earlier, with its whole log and its postmortem', async () => {
    const { site, store } = await begin()
    await store.start({ from: 'sample', sampleId: 'bad-deploy' })
    await until(() => store.pending !== undefined, 'the proposal')
    await store.decide('approve')
    await until(() => store.postmortem !== undefined, 'the postmortem')
    const length = store.events.length
    store.dispose()
    setActivePinia(createPinia())
    await useSessionStore().load()
    const returned = useLb06Store()
    await returned.loadMine()
    expect(returned.mine).toHaveLength(1)
    const sockets = site.sockets.length
    await returned.openMine(returned.mine[0]!)
    await advance(100)
    expect(returned.events).toHaveLength(length)
    expect(returned.state).toBe('closed')
    expect(returned.runPhase).toBe('over')
    expect(returned.postmortem).toBeDefined()
    expect(site.sockets.length).toBe(sockets)
  })

  it('plays a recording without asking the service for anything that could change something', async () => {
    const { site, store } = await begin()
    store.replayRecording(liveRecording('bad-deploy'))
    expect(store.runMode).toBe('replay')
    await until(() => useReplayStore().playing === false, 'the replay to finish', 20_000)
    expect(store.state).toBe('closed')
    expect(store.postmortem?.timeline.length).toBeGreaterThan(3)
    expect(store.ticks.length).toBeGreaterThan(30)
    expect(store.steps.length).toBeGreaterThan(5)
    expect(site.calls.filter(call => call.method !== 'GET' && !call.path.startsWith('/api/session'))).toEqual([])
    expect(site.sockets).toHaveLength(0)
  })

  it('empties the board for the next incident, and stops everything it was doing', async () => {
    const { site, store } = await begin()
    await store.start({ from: 'sample', sampleId: 'bad-deploy' })
    await until(() => store.feed === 'open', 'the socket to open')
    store.reset()
    expect(store.incident).toBeUndefined()
    expect(store.events).toHaveLength(0)
    expect(store.runMode).toBe('idle')
    expect(site.socket.readyState).toBe(3)
    const calls = site.calls.length
    await advance(1_000)
    expect(site.calls.length).toBe(calls)
  })
})
