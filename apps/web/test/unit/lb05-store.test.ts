// Unit tests for LB-05's board store, against the fake site: a question asked live (the check, the one
// long request, the day's count, the Scope reading the finished trace), every way the request can fail
// or take too long, stopping the wait, and a replay that shows its work first and its answer at the end
// without a single request to the back end.
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LB05_ATTACKS, LB05_SAMPLES } from '#shared/data/samples/lb05'

import { ASK_PATIENCE_MS } from '~/boards/lb-05/limits'
import { useLb05Store } from '~/boards/lb-05/store'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import { FakeSite } from '../support/fake-site'
import { recordLb05Sample } from '../support/lb05-recording'

const QUESTION = LB05_SAMPLES[0].question

/** Starts a fake site and fresh stores; the session is read, as the board does when it opens. */
async function start(options: ConstructorParameters<typeof FakeSite>[0] = {}) {
  const site = new FakeSite(options)
  vi.stubGlobal('fetch', site.fetch)
  vi.stubGlobal('location', new URL('http://site.test/'))
  setActivePinia(createPinia())
  const store = useLb05Store()
  const session = useSessionStore()
  await session.load()
  return { site, store, session, scope: useScopeStore() }
}

/** Lets time pass with the board's timers running. */
async function seconds(count: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(count * 1_000)
}

describe('LB-05\'s store: what the board reads when it opens', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reads the questions left today and the limits the back end enforces', async () => {
    const { store } = await start()
    await store.loadQuota()

    expect(store.quota).toEqual({ limit: 25, used: 0, remaining: 25, resetsAt: '2026-10-03T00:00:00+00:00' })
    expect(store.limits).toMatchObject({ row_cap: 1_000, query_timeout_seconds: 5, question_deadline_seconds: 90 })
  })

  it('keeps the datasheet\'s limits when the back end cannot say its own', async () => {
    const { site, store } = await start()
    site.failNext('GET /api/lb05/quota', { status: 503, body: { error: { code: 'unavailable', message: 'x' } } })
    await store.loadQuota()

    expect(store.quota).toBeUndefined()
    expect(store.limits.row_cap).toBe(1_000)
  })

  it('reads the semantic layer, and says when it could not', async () => {
    const { site, store } = await start()
    await store.loadLayer()
    expect(store.layerStatus).toBe('ready')
    expect(store.layer?.metrics).toHaveLength(12)

    site.failNext('GET /api/lb05/semantic-layer', { status: 503, body: { error: { code: 'unavailable', message: 'x' } } })
    await store.loadLayer()
    expect(store.layerStatus).toBe('failed')
    expect(store.layer).toBeUndefined()
  })
})

describe('LB-05\'s store: a live question', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('asks after the check, shows the answer, counts it against the day, and has the Scope read the finished trace', async () => {
    const { site, store, session, scope } = await start()
    await store.loadQuota()
    expect(session.verified).toBe(false)

    await store.ask({ question: QUESTION, source: 'sample', sampleId: LB05_SAMPLES[0].id })

    expect(session.verified).toBe(true)
    expect(site.callsTo('/api/lb05/ask', 'POST')).toHaveLength(1)
    expect(site.callsTo('/api/lb05/ask', 'POST')[0]?.body).toEqual({ question: QUESTION })
    expect(store.runMode).toBe('live')
    expect(store.phase).toBe('done')
    expect(store.answer?.outcome).toBe('answered')
    expect(store.answer?.result?.rows).toEqual([[8_452_300]])
    expect(store.quota).toMatchObject({ used: 1, remaining: 24 })
    expect(scope.runId).toBe(store.answer?.run_id)

    await seconds(1)
    expect(scope.phase).toBe('finished')
    expect(scope.timeline.rows.at(0)?.span.name).toBe('data question')
  })

  it('says it is waiting for the trace while the one request is out, because the analyst names its run only in the answer', async () => {
    const { site, store, scope } = await start({ verified: true })
    site.delayNext('POST /api/lb05/ask', 20_000)
    const asking = store.ask({ question: QUESTION, source: 'sample' })
    await seconds(5)

    expect(store.phase).toBe('asking')
    expect(store.askedAt).toBeTypeOf('number')
    expect(scope.phase).toBe('waiting')
    expect(site.callsTo('/api/runs/')).toHaveLength(0)

    await seconds(15)
    await asking
    expect(store.phase).toBe('done')
    expect(scope.phase).toBe('following')
  })

  it('works out the allowance from the answer when the count was not read', async () => {
    const { store } = await start({ verified: true })
    await store.ask({ question: QUESTION, source: 'own' })

    expect(store.quota).toMatchObject({ limit: 25, used: 1, remaining: 24, resetsAt: '2026-10-03T00:00:00.000Z' })
  })

  it('does nothing about a second question while the first is out', async () => {
    const { site, store } = await start({ verified: true })
    site.delayNext('POST /api/lb05/ask', 5_000)
    const first = store.ask({ question: QUESTION, source: 'sample' })
    await store.ask({ question: LB05_SAMPLES[1].question, source: 'sample' })
    await seconds(6)
    await first

    expect(site.callsTo('/api/lb05/ask', 'POST')).toHaveLength(1)
    expect(store.asked?.question).toBe(QUESTION)
  })

  it('clears the last answer when the next question starts', async () => {
    const { store } = await start({ verified: true })
    await store.ask({ question: QUESTION, source: 'sample' })
    expect(store.answer).toBeDefined()

    const next = store.ask({ question: LB05_ATTACKS[0].question, source: 'attack', sampleId: LB05_ATTACKS[0].id })
    expect(store.answer).toBeUndefined()
    await next
    expect(store.answer?.outcome).toBe('refused')
    expect(store.asked?.source).toBe('attack')
  })

  it('shows an attack stopped by a layer, with the layer and the rule the back end names', async () => {
    const { store } = await start({ verified: true })
    await store.ask({ question: LB05_ATTACKS[0].question, source: 'attack', sampleId: LB05_ATTACKS[0].id })

    expect(store.answer?.attempts.at(-1)).toMatchObject({ stopped_by: 'parse', rule: 'not_select' })
    expect(store.answer?.result).toBeNull()
  })

  it('refuses a question the back end would refuse without sending it', async () => {
    const { site, store } = await start({ verified: true })
    await store.ask({ question: 'Hi', source: 'own' })

    expect(site.callsTo('/api/lb05/ask', 'POST')).toHaveLength(0)
    expect(store.problem?.kind).toBe('rejected')
    expect(store.phase).toBe('idle')
  })
})

describe('LB-05\'s store: when a question does not work', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('runs the check again and asks once more when the server says a new day began', async () => {
    const { site, store, session } = await start({ verified: true })
    site.failNext('POST /api/lb05/ask', { status: 403, body: { error: { code: 'verification_required', message: 'Run the check.' } } })
    await store.ask({ question: QUESTION, source: 'sample' })

    expect(site.callsTo('/api/session/verify', 'POST')).toHaveLength(1)
    expect(site.callsTo('/api/lb05/ask', 'POST')).toHaveLength(2)
    expect(session.verified).toBe(true)
    expect(store.answer?.outcome).toBe('answered')
  })

  it('tells a visitor whose browser does not keep the session cookie, when the check passed and the server still asks for it', async () => {
    const { site, store } = await start({ verified: true })
    const again = { status: 403, body: { error: { code: 'verification_required', message: 'Run the check.' } } }
    site.failNext('POST /api/lb05/ask', again)
    site.failNext('POST /api/lb05/ask', again)
    await store.ask({ question: QUESTION, source: 'sample' })

    expect(store.problem?.kind).toBe('cookie')
    expect(site.callsTo('/api/lb05/ask', 'POST')).toHaveLength(2)
  })

  it('says the day\'s allowance is used up, with when it starts again, and sets the count to nothing left', async () => {
    const { site, store } = await start({ verified: true })
    await store.loadQuota()
    site.failNext('POST /api/lb05/ask', { status: 429, body: { error: { code: 'daily_limit', message: 'x', resets_at: '2026-10-03T00:00:00+00:00' } } })
    await store.ask({ question: QUESTION, source: 'sample' })

    expect(store.problem).toMatchObject({ kind: 'quota', code: 'daily_limit', resetsAt: '2026-10-03T00:00:00+00:00' })
    expect(store.quota).toMatchObject({ remaining: 0 })
    expect(store.answer).toBeUndefined()
  })

  it('sets the count to nothing left even when it was never read', async () => {
    const { site, store } = await start({ verified: true })
    site.failNext('POST /api/lb05/ask', { status: 429, body: { error: { code: 'daily_limit', message: 'x', resets_at: '2026-10-03T00:00:00+00:00' } } })
    await store.ask({ question: QUESTION, source: 'sample' })

    expect(store.quota).toMatchObject({ limit: 25, remaining: 0, resetsAt: '2026-10-03T00:00:00+00:00' })
  })

  it('keeps a refusal because the last question is still running apart from the day\'s limit, by its code', async () => {
    const { site, store } = await start({ verified: true })
    await store.loadQuota()
    site.failNext('POST /api/lb05/ask', { status: 429, body: { error: { code: 'question_running', message: 'Your last question is still being answered.' } } })
    await store.ask({ question: QUESTION, source: 'sample' })

    expect(store.problem?.code).toBe('question_running')
    expect(store.quota?.remaining).toBe(25)
  })

  it.each([
    [422, 'invalid_request', 'rejected'],
    [502, 'upstream_failed', 'upstream'],
    [503, 'unavailable', 'unavailable'],
    [504, 'upstream_timeout', 'timeout'],
  ] as const)('names a %s from the site by what it means to a visitor', async (status, code, kind) => {
    const { site, store } = await start({ verified: true })
    site.failNext('POST /api/lb05/ask', { status, body: { error: { code, message: 'x' } } })
    await store.ask({ question: QUESTION, source: 'sample' })

    expect(store.problem?.kind).toBe(kind)
    expect(store.phase).toBe('idle')
    expect(store.runMode).toBe('idle')
  })

  it('says the site could not be reached when the network drops', async () => {
    const { store } = await start({ verified: true })
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('network down')))
    await store.ask({ question: QUESTION, source: 'sample' })

    expect(store.problem?.kind).toBe('network')
  })

  it('does not show an answer that contradicts itself', async () => {
    const { site, store } = await start({ verified: true })
    const answer = site.lb05.ask('someone', QUESTION).body as Record<string, unknown>
    site.failNext('POST /api/lb05/ask', { status: 200, body: { ...answer, result: null } })
    await store.ask({ question: QUESTION, source: 'sample' })

    expect(store.answer).toBeUndefined()
    expect(store.problem?.code).toBe('bad_answer')
  })

  it('says the demo is not connected on a deployment with no back end', async () => {
    const { store } = await start({ available: false })
    await store.ask({ question: QUESTION, source: 'sample' })

    expect(store.problem?.kind).toBe('unavailable')
  })

  it('says the check failed when it did', async () => {
    const { store } = await start({ testMode: false })
    const asking = store.ask({ question: QUESTION, source: 'sample' })
    useSessionStore().provideToken(undefined)
    await asking

    expect(store.problem?.kind).toBe('verification')
    expect(store.phase).toBe('idle')
  })
})

describe('LB-05\'s store: a question that takes long', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('waits as long as the site\'s server does and a little more, then says the system took too long', async () => {
    const { site, store } = await start({ verified: true })
    site.delayNext('POST /api/lb05/ask', ASK_PATIENCE_MS * 2)
    const asking = store.ask({ question: QUESTION, source: 'sample' })
    await vi.advanceTimersByTimeAsync(ASK_PATIENCE_MS - 1_000)
    expect(store.phase).toBe('asking')
    expect(store.problem).toBeUndefined()

    await vi.advanceTimersByTimeAsync(2_000)
    await asking
    expect(store.problem).toMatchObject({ kind: 'timeout', status: 504 })
    expect(store.phase).toBe('idle')
  })

  it('lets the visitor stop waiting, and says the analyst keeps working on the question', async () => {
    const { site, store, scope } = await start({ verified: true })
    site.delayNext('POST /api/lb05/ask', 60_000)
    const asking = store.ask({ question: QUESTION, source: 'sample' })
    await seconds(10)
    store.stopWaiting()
    await asking

    expect(store.stoppedWaiting).toBe(true)
    expect(store.phase).toBe('idle')
    expect(store.runMode).toBe('idle')
    expect(store.problem).toBeUndefined()
    expect(store.answer).toBeUndefined()
    expect(scope.phase).toBe('idle')
  })

  it('forgets a stopped wait when the next question starts', async () => {
    const { site, store } = await start({ verified: true })
    site.delayNext('POST /api/lb05/ask', 60_000)
    const asking = store.ask({ question: QUESTION, source: 'sample' })
    await seconds(1)
    store.stopWaiting()
    await asking
    await store.ask({ question: QUESTION, source: 'sample' })

    expect(store.stoppedWaiting).toBe(false)
    expect(store.answer?.outcome).toBe('answered')
  })
})

describe('LB-05\'s store: a replay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shows its work first and the recorded answer at the end, without a request to the back end', async () => {
    const { site, store, scope } = await start()
    const recording = recordLb05Sample({ sample: 'monthly-revenue-last-year' })
    store.replayRecording(recording, 'sample')

    expect(store.runMode).toBe('replay')
    expect(store.phase).toBe('asking')
    expect(store.answer).toBeUndefined()
    await seconds(1)
    expect(scope.replayed).toBe(true)
    expect(store.answer).toBeUndefined()

    await seconds(10)
    expect(store.phase).toBe('done')
    expect(store.answer?.outcome).toBe('answered')
    expect(store.answer?.chart?.kind).toBe('line')
    expect(store.asked?.question).toBe('Show revenue by month for last year.')
    expect(scope.phase).toBe('finished')
    expect(site.calls.filter(call => call.method !== 'GET')).toEqual([])
    expect(site.callsTo('/api/lb05/')).toEqual([])
  })

  it('shows everything at once for a visitor who prefers reduced motion', async () => {
    const { store } = await start()
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
    store.replayRecording(recordLb05Sample(), 'sample')

    expect(store.phase).toBe('done')
    expect(store.answer?.outcome).toBe('answered')
  })

  it('replays an attack that a layer stopped', async () => {
    const { store } = await start()
    store.replayRecording(recordLb05Sample({ sample: 'drop-orders-table' }), 'attack')
    await seconds(10)

    expect(store.answer?.outcome).toBe('refused')
    expect(store.answer?.attempts.at(-1)).toMatchObject({ stopped_by: 'parse', rule: 'not_select' })
    expect(store.asked?.source).toBe('attack')
  })

  it('says so when a recording holds no answer the board can read', async () => {
    const { store } = await start()
    const recording = recordLb05Sample()
    const broken = { ...recording, exchanges: [{ ...recording.exchanges[0]!, response: { status: 200, body: { nonsense: true } } }] }
    store.replayRecording(broken, 'sample')
    await seconds(10)

    expect(store.answer).toBeUndefined()
    expect(store.problem?.code).toBe('bad_answer')
    expect(store.phase).toBe('done')
  })

  it('is stopped by the next question, which a live ask starts clean', async () => {
    const { store } = await start({ verified: true })
    store.replayRecording(recordLb05Sample(), 'sample')
    await seconds(1)
    await store.ask({ question: QUESTION, source: 'sample' })
    await seconds(10)

    expect(store.runMode).toBe('live')
    expect(store.answer?.run_id).not.toBe(recordLb05Sample().trace.runId)
  })

  it('stops everything the board is doing when the visitor leaves', async () => {
    const { store } = await start()
    store.replayRecording(recordLb05Sample(), 'sample')
    store.dispose()
    await seconds(10)

    expect(store.answer).toBeUndefined()
  })
})
