// Tests of LB-10's board state against the fake site: an edit run live and followed to its report, its trace followed
// as soon as the run is named; the service's refusal of a prompt kept beside it until the prompt changes; a refusal of
// the day's run that sets the count to nothing left; a failed run given back or not, read from the day's count; a run
// opened again after a reload; a read that answers after a newer one, which never moves the board backwards, and an
// answer for a run the board has left; a run that never ends, which the board stops following; stopping waiting; a
// replay, which never touches the back end; and the visitor's prompt kept out of the browser's storage. The back end is
// the mock's LB-10; the clock is the test's.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordingSchema } from '@lb/contracts'
import type { Recording } from '@lb/contracts'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RUN_PATIENCE_MS } from '~/boards/lb-10/pace'
import { useLb10Store } from '~/boards/lb-10/store'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'
import type { FakeLb10Options } from '../support/lb10-site'
import { FakeLb10Site } from '../support/lb10-site'

const TODAY = new Date('2026-10-05T09:30:00.000Z')
const FIXTURES = join(import.meta.dirname, '../../e2e/fixtures/recordings/lb-10')

/** One of the committed recordings, made to look like a real one (the site shows only those). */
function liveRecording(sample: string): Recording {
  return recordingSchema.parse({ ...JSON.parse(readFileSync(join(FIXTURES, `${sample}.json`), 'utf8')) as object, origin: 'live' })
}

/** Starts a fake site and a fresh store reading through it, with the session and the board's first reads done. */
async function begin(options: FakeLb10Options = {}) {
  const site = new FakeLb10Site({ verified: true, ...options })
  vi.stubGlobal('fetch', site.fetch)
  vi.stubGlobal('location', new URL('http://site.test/'))
  setActivePinia(createPinia())
  const session = useSessionStore()
  await session.load()
  const store = useLb10Store()
  store.clearAll()
  await store.load()
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

/** Tells whether the run on the board has ended. */
function over(store: ReturnType<typeof useLb10Store>): boolean {
  return store.phase === 'over' && store.refund !== 'checking'
}

describe('LB-10\'s store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(TODAY)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens on the drafter with its production prompt, Groq and an untouched day', async () => {
    const { store } = await begin()
    expect(store.pack).toBe('lb01-drafter')
    expect(store.draft).toBe(store.target?.system_prompt)
    expect(store.unchanged).toBe(true)
    expect(store.providers).toEqual(['groq'])
    expect(store.quota).toMatchObject({ limit: 1, used: 0, remaining: 1 })
    expect(store.ready).toBe(true)
  })

  it('runs an edit live, follows it and its trace from the moment it is named, and ends with its report', async () => {
    const { site, store, scope } = await begin()
    store.setDraft(`${store.draft}\nKeep it short.`)
    expect(store.unchanged).toBe(false)
    const started = store.runLive()
    expect(store.phase).toBe('starting')
    expect(scope.phase).toBe('waiting')
    await started
    expect(store.phase).toBe('following')
    expect(store.quota?.remaining).toBe(0)
    expect(scope.runId).toBe(store.run?.run_id)
    await until(() => over(store), 'the run to end')
    expect(store.run?.state).toBe('done')
    expect(store.run?.report?.comparisons[0]?.verdict).toBe('no_detectable_difference')
    expect(store.mine.map(run => run.run_id)).toEqual([store.run?.run_id])
    // One read at a time, and none once the run has ended.
    const reads = site.callsTo(`/api/lb10/runs/${store.run?.run_id}`).length
    await advance(10_000)
    expect(site.callsTo(`/api/lb10/runs/${store.run?.run_id}`)).toHaveLength(reads)
  })

  it('keeps the service\'s refusal of a prompt beside it, counts nothing, and forgets it once the prompt changes', async () => {
    const { site, store } = await begin()
    store.setDraft(`${store.draft}\nMore.`)
    const sent = store.draft
    site.failNext('POST /api/lb10/runs', { status: 422, body: { error: { code: 'invalid_prompt', message: 'The prompt is empty.' }, problems: [{ code: 'empty', message: 'The prompt is empty.' }, { code: 'too_long', message: 'The prompt is 9,000 characters.' }] } })
    await store.runLive()
    expect(store.refused).toEqual({ prompt: sent, problems: [{ code: 'empty', message: 'The prompt is empty.' }, { code: 'too_long', message: 'The prompt is 9,000 characters.' }] })
    expect(store.problem).toBeUndefined()
    expect(store.runMode).toBe('idle')
    expect(store.quota?.remaining).toBe(1)
    store.setDraft(sent)
    expect(store.refused).toBeDefined()
    store.setDraft(`${sent}!`)
    expect(store.refused).toBeUndefined()
  })

  it('keeps the error\'s sentence when a refusal comes with no list of problems', async () => {
    const { site, store } = await begin()
    store.setDraft(`${store.draft}\nMore.`)
    site.failNext('POST /api/lb10/runs', { status: 422, body: { error: { code: 'invalid_prompt', message: 'The prompt holds control characters.' } } })
    await store.runLive()
    expect(store.refused?.problems).toEqual([{ code: 'other', message: 'The prompt holds control characters.' }])
  })

  it('sets the day\'s count to nothing left when the service says today\'s run is used, with when it starts again', async () => {
    const { site, store } = await begin()
    site.failNext('POST /api/lb10/runs', { status: 429, body: { error: { code: 'daily_limit', message: 'Used.', resets_at: '2026-10-06T00:00:00+00:00' } } })
    await store.runLive()
    expect(store.problem?.code).toBe('daily_limit')
    expect(store.quota).toMatchObject({ remaining: 0, resetsAt: '2026-10-06T00:00:00+00:00' })
    expect(store.runMode).toBe('idle')
  })

  it('reads the day\'s count again after a failed run, and says it was given back, or not once two were', async () => {
    const { site, store } = await begin()
    for (const [code, refund] of [['no_answers', 'given'], ['model_budget', 'given'], ['interrupted', 'not_given']] as const) {
      site.lb10.control('fail', { code })
      store.setDraft(`${store.target?.system_prompt ?? ''}\n${code}`)
      await store.runLive()
      await until(() => over(store), `the ${code} run to end`)
      expect(store.run).toMatchObject({ state: 'failed', failure: code })
      expect(store.refund).toBe(refund)
    }
    expect(store.quota?.remaining).toBe(0)
  })

  it('opens one of today\'s runs again after a reload, and says it was opened again', async () => {
    const { site, store } = await begin()
    store.setDraft(`${store.draft}\nAgain.`)
    await store.runLive()
    await until(() => over(store), 'the run to end')
    const runId = store.run?.run_id ?? ''

    setActivePinia(createPinia())
    await useSessionStore().load()
    const reloaded = useLb10Store()
    reloaded.clearAll()
    await reloaded.load()
    expect(reloaded.mine.map(run => run.run_id)).toEqual([runId])
    await reloaded.openRun(runId)
    expect(reloaded.reopened).toBe(true)
    expect(reloaded.run?.report).not.toBeNull()
    expect(reloaded.phase).toBe('over')
    expect(site.callsTo('/api/lb10/runs', 'POST')).toHaveLength(1)
  })

  it('asks one question at a time: a slow answer is waited for, never overtaken by the next question', async () => {
    const { site, store } = await begin({ lb10: { pollsToFinish: 4 } })
    store.setDraft(`${store.draft}\nSlow.`)
    await store.runLive()
    const runId = store.run?.run_id ?? ''
    site.delayNext(`GET /api/lb10/runs/${runId}`, 5_000)
    await advance(4_000)
    // The held-back read is still out, so no second one was sent behind it.
    expect(site.callsTo(`/api/lb10/runs/${runId}`)).toHaveLength(1)
    await until(() => over(store), 'the run to end')
    expect(store.run?.state).toBe('done')
  })

  it('drops the answer to a read of a run the visitor stopped waiting for', async () => {
    const { site, store } = await begin()
    store.setDraft(`${store.draft}\nFirst.`)
    await store.runLive()
    const first = store.run?.run_id ?? ''
    site.delayNext(`GET /api/lb10/runs/${first}`, 3_000)
    await advance(600)
    store.stopWaiting()
    expect(store.runMode).toBe('idle')
    await advance(3_000)
    expect(store.run).toBeUndefined()
    expect(store.stoppedWaiting).toBe(true)
    expect(store.mine.map(run => run.run_id)).toEqual([first])
  })

  it('stops following a run that has not ended past the moment the service ends any run, and says so', async () => {
    const { site, store } = await begin({ lb10: { pollsToFinish: 100_000 } })
    store.setDraft(`${store.draft}\nForever.`)
    await store.runLive()
    await advance(RUN_PATIENCE_MS + 5_000)
    expect(store.gaveUp).toBe(true)
    expect(store.phase).toBe('over')
    const reads = site.callsTo(`/api/lb10/runs/${store.run?.run_id}`).length
    await advance(30_000)
    expect(site.callsTo(`/api/lb10/runs/${store.run?.run_id}`)).toHaveLength(reads)
  })

  it('replays a recording with its edit in the editor, and sends nothing', async () => {
    const { site, store } = await begin()
    const calls = site.calls.length
    store.replayRecording(liveRecording('classifier-without-json'), 'classifier-without-json')
    expect(store.runMode).toBe('replay')
    expect(store.pack).toBe('lb01-classifier')
    expect(store.providers).toEqual(['groq', 'workers-ai'])
    await until(() => store.phase === 'over', 'the replay to end', 30_000)
    expect(store.run?.report?.comparisons.map(comparison => comparison.verdict)).toEqual(['worse', 'worse'])
    expect(site.calls.slice(calls).filter(call => call.path.startsWith('/api/lb10/'))).toEqual([])
  })

  it('keeps the visitor\'s prompt out of the browser\'s storage', async () => {
    const written: string[] = []
    const storage = { getItem: () => null, setItem: (key: string, value: string) => written.push(`${key}=${value}`), removeItem: () => undefined }
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('sessionStorage', storage)
    const { store } = await begin()
    const secret = 'zebrapotato-quokka'
    store.setDraft(`${store.draft}\n${secret}`)
    await store.runLive()
    await until(() => over(store), 'the run to end')
    expect(store.run?.state).toBe('done')
    expect(written.filter(entry => entry.includes(secret))).toEqual([])
  })
})
