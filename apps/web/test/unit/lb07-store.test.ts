// Tests of LB-07's board state against the fake site: a curated run started live and followed to its
// report, test and evidence; the queue, where the Scope waits; a run of the visitor's own; every failure
// with the run given back when the service gives it back; the day's two runs; the busy browser; the check a
// new day asks for again; a run opened again after a reload; a run deleted; a run that is gone while it is
// followed; an answer that arrives after the board has moved on; a replay of a recording, which never
// touches the back end; and polling that stops when the run ends or the visitor leaves. The back end is the
// mock's LB-07; the clock is the test's.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordingSchema } from '@lb/contracts'
import type { Recording } from '@lb/contracts'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLb07Store } from '~/boards/lb-07/store'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'
import type { FakeLb07Options } from '../support/lb07-site'
import { FakeLb07Site, SESSION } from '../support/lb07-site'

const TODAY = new Date('2026-10-05T09:30:00.000Z')
const FIXTURES = join(import.meta.dirname, '../../e2e/fixtures/recordings/lb-07')

/** One of the committed recordings, made to look like a real one (the site shows only those). */
function liveRecording(sample: string): Recording {
  return recordingSchema.parse({ ...JSON.parse(readFileSync(join(FIXTURES, `${sample}.json`), 'utf8')) as object, origin: 'live' })
}

/** Starts a fake site and a fresh store reading through it, with the session loaded. */
async function begin(options: FakeLb07Options = {}) {
  const site = new FakeLb07Site({ verified: true, ...options })
  vi.stubGlobal('fetch', site.fetch)
  vi.stubGlobal('location', new URL('http://site.test/'))
  setActivePinia(createPinia())
  const session = useSessionStore()
  await session.load()
  const store = useLb07Store()
  await store.loadLimits()
  return { site, store, session, scope: useScopeStore() }
}

/** Moves the clock on and lets what is waiting settle. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** Moves the clock on in small steps until something is true, and fails if it never is. */
async function until(done: () => boolean, what: string, limitMs = 60_000): Promise<void> {
  for (let waited = 0; waited < limitMs; waited += 50) {
    if (done()) return
    await advance(50)
  }
  throw new Error(`Gave up waiting for ${what}.`)
}

describe('LB-07\'s store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(TODAY)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('runs a curated sample live and follows it to its report, its test and its evidence', async () => {
    const { site, store, scope } = await begin()
    await store.runSample('coupon-double-discount')
    expect(store.runMode).toBe('live')
    expect(store.phase).toBe('following')
    expect(store.quota?.remaining).toBe(1)
    expect(site.callsTo('/api/lb07/runs', 'POST')[0]?.body).toEqual({ from: 'sample', sampleId: 'coupon-double-discount' })
    const states = new Set<string>()
    await until(() => {
      if (store.run) states.add(store.run.state)
      return store.phase === 'over' && store.evidenceStatus === 'ready' && store.testStatus === 'ready'
    }, 'the run to end and its report to be read')

    expect([...states]).toEqual(expect.arrayContaining(['planning', 'running', 'cross_checking', 'done']))
    expect(store.report?.verification.verdict).toBe('kept')
    expect(store.test?.source).toContain('test(')
    expect(store.evidence.map(item => [item.id, item.kind])).toEqual([['e1', 'screenshot'], ['e2', 'screenshot'], ['e3', 'snapshot']])
    expect(store.evidence[0]).toMatchObject({ stepIndex: 8, path: '/cart', src: `/api/lb07/runs/${store.run?.id}/evidence/e1/image` })
    expect(store.evidence[2]?.text).toContain('heading "Your cart"')
    // The screenshots the findings name are shown from the image route and never read as JSON; the closing two are.
    expect(site.callsTo(`/api/lb07/runs/${store.run?.id}/evidence/`).map(call => call.path.split('/').at(-1))).toEqual(['e2', 'e3'])
    expect(store.mine.map(run => run.id)).toEqual([store.run?.id])
    await until(() => scope.phase === 'finished', 'the trace to be complete')
    expect(scope.runId).toBe(store.run?.runId)
  })

  it('stops asking once the run has ended, and when the visitor leaves', async () => {
    const { site, store } = await begin()
    await store.runSample('hostile-goal')
    await until(() => store.phase === 'over', 'the run to end')
    const reads = site.callsTo(`/api/lb07/runs/${store.run?.id}`, 'GET').length
    await advance(20_000)
    expect(site.callsTo(`/api/lb07/runs/${store.run?.id}`, 'GET').length).toBe(reads)

    await store.runSample('clean-shop')
    const id = store.run?.id ?? ''
    await advance(2_000)
    store.dispose()
    const before = site.callsTo(`/api/lb07/runs/${id}`, 'GET').length
    await advance(20_000)
    expect(site.callsTo(`/api/lb07/runs/${id}`, 'GET').length).toBe(before)
  })

  it('waits in the queue with its place, asks slowly there, and lets the Scope wait until the run starts', async () => {
    const { site, store, scope } = await begin()
    site.lb07.occupy(2, 10_000)
    await store.runSample('cart-count')
    expect(store.run).toMatchObject({ state: 'queued', queuePosition: 2 })
    expect(scope.phase).toBe('waiting')
    await advance(11_000)
    expect(store.run?.queuePosition).toBe(1)
    // Eleven seconds in the queue cost five reads, not the dozen the pace of a moving run would.
    expect(site.callsTo(`/api/lb07/runs/${store.run?.id}`, 'GET').length).toBeLessThanOrEqual(5)
    expect(scope.phase).toBe('waiting')
    await until(() => store.run?.state !== 'queued', 'the run to start', 30_000)
    expect(scope.phase).toBe('following')
    await until(() => store.phase === 'over', 'the run to end')
    expect(store.run?.state).toBe('done')
  })

  it('runs the visitor\'s own goal with the bugs they chose, trimmed as the service takes it', async () => {
    const { site, store } = await begin()
    await store.runCustom('  Buy two bags of Brazil Cerrado and check the total.  ', ['cart-off-by-one'])
    expect(site.callsTo('/api/lb07/runs', 'POST')[0]?.body).toEqual({ from: 'custom', goal: 'Buy two bags of Brazil Cerrado and check the total.', bugs: ['cart-off-by-one'] })
    expect(store.asked).toEqual({ kind: 'custom' })
    await until(() => store.phase === 'over' && store.reportStatus === 'ready', 'the run to end')
    expect(store.report?.findings.some(finding => finding.kind === 'expectation_failed')).toBe(true)
  })

  for (const [code, givenBack] of [['planning_unavailable', true], ['plan_invalid', true], ['runner_unavailable', true], ['internal', true], ['plan_refused', false], ['run_timeout', false], ['goal_refused', false]] as const) {
    it(`ends a run that failed with ${code}, reads no report, and ${givenBack ? 'counts the run given back' : 'keeps the run counted'}`, async () => {
      const { site, store } = await begin()
      site.lb07.failNext(code)
      await store.runCustom('Open the shop front and check it loads.', [])
      await until(() => store.phase === 'over', 'the run to end')
      expect(store.run?.state).toBe('failed')
      expect(store.run?.failure?.code).toBe(code)
      await advance(500)
      expect(store.quota?.remaining).toBe(givenBack ? 2 : 1)
      expect(store.report).toBeUndefined()
      expect(site.callsTo(`/api/lb07/runs/${store.run?.id}/report`)).toEqual([])
    })
  }

  it('says the day\'s two runs are used when the service refuses a third, and counts nothing left', async () => {
    const { store } = await begin()
    await store.runSample('hostile-goal')
    await until(() => store.phase === 'over', 'the first run to end')
    await store.runSample('clean-shop')
    await until(() => store.phase === 'over', 'the second run to end')
    await store.runSample('partner-link')
    expect(store.problem?.kind).toBe('quota')
    expect(store.problem?.code).toBe('daily_limit')
    expect(store.problem?.resetsAt).toBe('2026-10-06T00:00:00.000Z')
    expect(store.quota?.remaining).toBe(0)
    expect(store.runMode).toBe('idle')
    expect(store.run).toBeUndefined()
  })

  it('says the browser is busy when the queue is full, and takes nothing from the day', async () => {
    const { site, store } = await begin()
    site.lb07.occupy(4, 60_000)
    await store.runSample('cart-count')
    expect(store.problem?.code).toBe('busy')
    expect(store.runMode).toBe('idle')
    await advance(500)
    expect(store.quota?.remaining).toBe(2)
  })

  it('runs the check again when a new day asks for it, and starts the run then', async () => {
    const { site, store } = await begin()
    site.failNext('POST /api/lb07/runs', { status: 403, body: { error: { code: 'verification_required', message: 'x' } } })
    await store.runSample('cart-count')
    expect(site.callsTo('/api/session/verify', 'POST')).toHaveLength(1)
    expect(site.callsTo('/api/lb07/runs', 'POST')).toHaveLength(2)
    expect(store.run?.sampleId).toBe('cart-count')
  })

  it('opens a run of the hour again after a reload: a finished one whole, a running one followed', async () => {
    const { site, store } = await begin()
    await store.runSample('cart-count')
    await until(() => store.phase === 'over' && store.evidenceStatus === 'ready', 'the run to end')
    const finished = store.run?.id ?? ''
    await store.runSample('pictures-have-alt-text')
    const going = store.run?.id ?? ''

    setActivePinia(createPinia())
    await useSessionStore().load()
    const fresh = useLb07Store()
    await fresh.loadMine()
    expect(fresh.mine.map(run => run.id)).toEqual([going, finished])
    await fresh.openRun(finished)
    expect(fresh.asked).toEqual({ kind: 'sample', sampleId: 'cart-count' })
    await until(() => fresh.evidenceStatus === 'ready', 'the finished run to be read')
    expect(fresh.run?.replans).toBe(1)
    expect(fresh.report?.verification.verdict).toBe('kept')
    await fresh.openRun(going)
    expect(fresh.phase).toBe('following')
    await until(() => fresh.phase === 'over', 'the running run to end')
    expect(site.callsTo('/api/lb07/runs', 'POST')).toHaveLength(2)
  })

  it('deletes the run on the board on request, and lists it no more', async () => {
    const { site, store } = await begin()
    await store.runSample('hostile-goal')
    await until(() => store.phase === 'over', 'the run to end')
    const id = store.run?.id ?? ''
    await store.deleteRun()
    expect(site.callsTo(`/api/lb07/runs/${id}`, 'DELETE')).toHaveLength(1)
    expect(store.run).toBeUndefined()
    await advance(100)
    expect(store.mine).toEqual([])
    expect(store.quota?.remaining).toBe(1)
  })

  it('says a run is gone when it disappears while it is followed', async () => {
    const { site, store } = await begin()
    await store.runSample('everything-on')
    await advance(1_500)
    site.lb07.remove(SESSION, store.run?.id ?? '')
    await until(() => store.phase === 'over', 'the board to stop following')
    expect(store.problem?.code).toBe('run_not_found')
  })

  it('stops waiting on request: the run goes on in the service and is listed, and a late answer touches nothing', async () => {
    const { site, store } = await begin()
    await store.runSample('everything-on')
    const id = store.run?.id ?? ''
    site.delayNext(`GET /api/lb07/runs/${id}`, 3_000)
    await advance(600)
    store.stopWaiting()
    expect(store.stoppedWaiting).toBe(true)
    expect(store.run).toBeUndefined()
    await advance(5_000)
    expect(store.run).toBeUndefined()
    expect(store.mine.map(run => run.id)).toEqual([id])
  })

  it('replays a recording without a single call to the back end, to the report, the test and the evidence', async () => {
    const { site, store, scope } = await begin()
    const before = site.callsTo('/api/lb07/').length
    store.replayRecording(liveRecording('cart-count'), { kind: 'sample', sampleId: 'cart-count' })
    expect(store.runMode).toBe('replay')
    await until(() => store.phase === 'over', 'the replay to end')
    expect(site.callsTo('/api/lb07/').length).toBe(before)
    expect(store.run?.state).toBe('done')
    expect(store.run?.steps.some(step => step.plan === 1)).toBe(true)
    expect(store.report?.verification.verdict).toBe('kept')
    expect(store.test?.filename).toMatch(/\.spec\.ts$/)
    expect(store.evidence.filter(item => item.kind === 'screenshot').every(item => item.src?.startsWith('data:image/png;base64,iVBORw0KGgo'))).toBe(true)
    expect(scope.replayed).toBe(true)
  })

  it('never turns an ended run back into a running one, whatever order the answers come in', async () => {
    const { store } = await begin()
    const recording = liveRecording('partner-link')
    const views = recording.exchanges.filter(exchange => exchange.request.method === 'GET' && /\/runs\/[\w-]+$/.test(exchange.request.path))
    const done = views.at(-1)!
    const running = views.find(exchange => (exchange.response.body as { state: string }).state === 'running')!
    store.replayRecording({ ...recording, exchanges: [recording.exchanges[0]!, done, running] }, { kind: 'sample', sampleId: 'partner-link' })
    await until(() => store.phase === 'over', 'the replay to end')
    expect(store.run?.state).toBe('done')
  })
})
