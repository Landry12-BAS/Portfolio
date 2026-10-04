// Unit tests for LB-03's board store, against the fake site: uploading a document live (the check, the
// polling through the stages, the Scope that waits for the run to be named, the day's allowance), the
// refusals of an upload and what each leaves on the board, correcting a field and the checks that run again,
// opening and deleting a document, giving up on a reading, and replaying a recording without a single
// request to the back end.
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LB03_SAMPLES } from '#shared/data/samples/lb03'

import { ApiProblem } from '~/board-kit/problem'
import { correctionRefusal } from '~/boards/lb-03/refusals'
import { DOCUMENT_GIVE_UP_MS, DOCUMENT_POLL_MS, useLb03Store } from '~/boards/lb-03/store'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import { FakeSite } from '../support/fake-site'
import { recordLb03Sample } from '../support/lb03'
import { seedUpload } from '../support/lb03-files'

/** Makes the browser's `File` of a seed document, as the file input hands it to the board. */
function fileOf(name: string): File {
  const upload = seedUpload(name)
  return new File([new Uint8Array(upload.bytes)], upload.filename, { type: upload.type })
}

/** Starts a fake site and fresh stores; the session is read, as the board does when it opens. */
async function start(options: ConstructorParameters<typeof FakeSite>[0] = {}) {
  const site = new FakeSite(options)
  vi.stubGlobal('fetch', site.fetch)
  vi.stubGlobal('location', new URL('http://site.test/'))
  setActivePinia(createPinia())
  const store = useLb03Store()
  const session = useSessionStore()
  await session.load()
  return { site, store, session, scope: useScopeStore(), replay: useReplayStore() }
}

/** Lets the board's polling run for a number of its intervals. */
async function poll(times: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(times * DOCUMENT_POLL_MS)
}

describe('LB-03\'s store: a live document', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('uploads a file after the check, follows it through its stages to the end, and follows its trace', async () => {
    const { site, store, session, scope } = await start()
    await store.loadQuota()
    expect(store.allowance?.remaining).toBe(10)
    expect(session.verified).toBe(false)

    await store.upload(fileOf('clean-pdf'))
    expect(session.verified).toBe(true)
    expect(store.runMode).toBe('live')
    expect(store.phase).toBe('reading')
    expect(store.onBoard?.state).toBe('uploaded')
    expect(store.allowance?.remaining).toBe(9)
    const posts = site.callsTo('/api/lb03/documents', 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.body).toEqual({ upload: { filename: 'bohemia-packaging-2026-0412.pdf', bytes: 5_109 } })

    const states: string[] = []
    for (let reads = 0; reads < 4; reads += 1) {
      await poll(1)
      states.push(store.onBoard?.state ?? '')
    }
    expect(states).toEqual(['ocr', 'extract', 'validate', 'ready'])
    expect(store.phase).toBe('done')
    expect(store.finished).toBe(true)
    expect(store.ready).toBe(true)
    expect(store.selectedPath).toBe('total')
    expect(store.selectedField?.box?.page).toBe(1)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(scope.phase).toBe('finished')
    expect(scope.timeline.rows[0]?.span.name).toBe('invoice reading')
  })

  it('says the Scope is waiting while the service has not named the run, and reads none of its trace until it has', async () => {
    const { site, store, scope } = await start({ verified: true })
    await store.upload(fileOf('clean-pdf'))
    expect(store.onBoard?.run_id).toBeNull()
    expect(scope.phase).toBe('waiting')
    await poll(2)
    expect(store.onBoard?.state).toBe('extract')
    expect(scope.phase).toBe('waiting')
    expect(site.callsTo('/api/runs/')).toHaveLength(0)
    await poll(2)
    expect(store.onBoard?.run_id).not.toBeNull()
    expect(scope.runId).toBe(store.onBoard?.run_id)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(site.callsTo('/api/runs/').length).toBeGreaterThan(0)
  })

  it('shows how many documents are ahead while the document waits for a reader', async () => {
    const { store } = await start({ verified: true, lb03: { holdPolls: 3, queuedAhead: 2 } })
    await store.upload(fileOf('clean-pdf'))
    await poll(2)
    expect(store.onBoard?.state).toBe('uploaded')
    expect(store.onBoard?.queued_ahead).toBe(2)
    await poll(6)
    expect(store.onBoard?.state).toBe('ready')
    expect(store.onBoard?.queued_ahead).toBeNull()
  })

  it('ends a document the injection check stopped as failed, with the reason and no fields', async () => {
    const { store } = await start({ verified: true })
    await store.upload(fileOf('prompt-injection'))
    await poll(4)
    expect(store.phase).toBe('done')
    expect(store.onBoard?.state).toBe('failed')
    expect(store.onBoard?.failure?.code).toBe('injection_suspected')
    expect(store.onBoard?.fields).toBeNull()
    expect(store.ready).toBe(false)
    expect(store.selectedPath).toBeUndefined()
  })

  it('runs a curated sample live by sending its file from the site\'s own static files', async () => {
    const { site, store } = await start({ verified: true })
    const sample = LB03_SAMPLES.find(candidate => candidate.id === 'planted-total')
    await store.uploadSample(sample ?? LB03_SAMPLES[0])
    expect(site.callsTo('/lb03/samples/planted-total-hanse-2026-4700.pdf', 'GET')).toHaveLength(1)
    expect(site.callsTo('/api/lb03/documents', 'POST')[0]?.body).toEqual({ upload: { filename: 'planted-total-hanse-2026-4700.pdf', bytes: sample?.bytes } })
    await poll(5)
    expect(store.onBoard?.state).toBe('ready')
    expect(store.onBoard?.can_export).toBe(false)
    expect(store.selectedPath).toBe('total')
  })

  it('takes one upload at a time', async () => {
    const { site, store } = await start({ verified: true })
    site.delayNext('POST /api/lb03/documents', 500)
    const first = store.upload(fileOf('clean-pdf'))
    await store.upload(fileOf('euro-vat'))
    await vi.advanceTimersByTimeAsync(600)
    await first
    expect(site.callsTo('/api/lb03/documents', 'POST')).toHaveLength(1)
  })

  it('looks at a field and goes to its page, and keeps the page between the first and the last', async () => {
    const { store } = await start({ verified: true })
    await store.upload(fileOf('clean-pdf'))
    await poll(4)
    store.select('vendor')
    expect(store.selectedPath).toBe('vendor')
    expect(store.page).toBe(1)
    store.showPage(9)
    expect(store.page).toBe(1)
    store.select(undefined)
    expect(store.selectedField).toBeUndefined()
  })
})

describe('LB-03\'s store: the day\'s check and what an upload can be refused for', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('runs the check again and tries once more when the server says a new day began', async () => {
    const { site, store, session } = await start({ verified: true })
    site.failNext('POST /api/lb03/documents', { status: 403, body: { error: { code: 'verification_required', message: 'x' } } })
    await store.upload(fileOf('clean-pdf'))
    expect(site.callsTo('/api/session/verify', 'POST')).toHaveLength(1)
    expect(site.callsTo('/api/lb03/documents', 'POST')).toHaveLength(2)
    expect(session.verified).toBe(true)
    expect(store.phase).toBe('reading')
    expect(store.problem).toBeUndefined()
  })

  it('says the browser is not keeping the session cookie when the check passes and the server still asks for it', async () => {
    const { site, store } = await start({ verified: true })
    site.failNext('POST /api/lb03/documents', { status: 403, body: { error: { code: 'verification_required', message: 'x' } } })
    site.failNext('POST /api/lb03/documents', { status: 403, body: { error: { code: 'verification_required', message: 'x' } } })
    await store.upload(fileOf('clean-pdf'))
    expect(store.problem?.kind).toBe('cookie')
    expect(store.phase).toBe('idle')
    expect(store.runMode).toBe('idle')
  })

  it('puts nothing on the board and makes no upload when the check cannot be passed', async () => {
    const { site, store } = await start({ available: false })
    await store.upload(fileOf('clean-pdf'))
    expect(site.callsTo('/api/lb03/documents', 'POST')).toHaveLength(0)
    expect(store.problem?.kind).toBe('unavailable')
    expect(store.runMode).toBe('idle')
  })

  it('keeps the refusals of a file as problems the board has words for', async () => {
    const { site, store } = await start({ verified: true })
    const refusals: [number, string, string][] = [[413, 'too_large', 'rejected'], [415, 'unsupported_file', 'rejected'], [429, 'document_running', 'quota'], [503, 'readers_busy', 'unavailable']]
    for (const [status, code, kind] of refusals) {
      site.failNext('POST /api/lb03/documents', { status, body: { error: { code, message: 'x' } } })
      await store.upload(fileOf('clean-pdf'))
      expect(store.problem?.code, code).toBe(code)
      expect(store.problem?.kind, code).toBe(kind)
      expect(store.phase).toBe('idle')
    }
  })

  it('spends the rest of the day\'s allowance when the service says it is used up', async () => {
    const { site, store } = await start({ verified: true })
    await store.loadQuota()
    site.failNext('POST /api/lb03/documents', { status: 429, body: { error: { code: 'daily_limit', message: 'x', resets_at: '2026-10-03T00:00:00+00:00' } } })
    await store.upload(fileOf('clean-pdf'))
    expect(store.problem?.kind).toBe('quota')
    expect(store.problem?.resetsAt).toBe('2026-10-03T00:00:00+00:00')
    expect(store.allowance?.remaining).toBe(0)
  })

  it('counts the ten documents of a day, and the eleventh is refused by the service', async () => {
    const { store } = await start({ verified: true })
    for (let count = 0; count < 10; count += 1) {
      await store.upload(fileOf('clean-pdf'))
      await poll(4)
      expect(store.phase).toBe('done')
    }
    await store.loadQuota()
    expect(store.allowance?.remaining).toBe(0)
    await store.upload(fileOf('clean-pdf'))
    expect(store.problem?.code).toBe('daily_limit')
  })

  it('names a sample file the site cannot read as a problem and sends nothing', async () => {
    const { site, store } = await start({ verified: true })
    await store.uploadSample({ file: 'missing.pdf', mime: 'application/pdf', bytes: 10 })
    expect(site.callsTo('/api/lb03/documents', 'POST')).toHaveLength(0)
    expect(store.problem?.kind).toBe('notFound')
    expect(store.phase).toBe('idle')
  })
})

describe('LB-03\'s store: a document\'s fields, its shelf and its end', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Uploads the clean PDF and reads it to its end. */
  async function readClean() {
    const started = await start({ verified: true })
    await started.store.upload(fileOf('clean-pdf'))
    await poll(4)
    return started
  }

  it('corrects a field, takes the whole document the service answers with, and runs every check again', async () => {
    const { site, store } = await readClean()
    expect(store.onBoard?.checks?.every(check => check.status !== 'failed')).toBe(true)
    const done = await store.correct('line_items.0.total', '7500.00')
    expect(done).toBe(true)
    expect(site.callsTo(`/api/lb03/documents/${store.onBoard?.id}/corrections`, 'POST')[0]?.body).toEqual({ path: 'line_items.0.total', value: '7500.00' })
    expect(store.onBoard?.corrections).toHaveLength(1)
    expect(store.onBoard?.corrections[0]).toMatchObject({ path: 'line_items.0.total', was: '7400.00', now: '7500.00' })
    expect(store.onBoard?.fields?.find(field => field.path === 'line_items.0.total')?.edited).toBe(true)
    expect(store.onBoard?.checks?.filter(check => check.status === 'failed').map(check => check.id)).toEqual(['line_math', 'line_items_sum'])
    expect(store.onBoard?.can_export).toBe(false)
    expect(store.correcting).toBe(false)
  })

  it('keeps the document and says why when the service refuses a value', async () => {
    const { store } = await readClean()
    const before = store.onBoard
    const done = await store.correct('total', 'not a number')
    expect(done).toBe(false)
    expect(store.onBoard).toBe(before)
    expect(store.correctionProblem && correctionRefusal(store.correctionProblem)).toBe('invalid')
  })

  it('says a document that is gone is gone, and a service that is off is not blamed on the value', async () => {
    const { site, store } = await readClean()
    site.failNext('POST /api/lb03/documents/', { status: 404, body: { error: { code: 'not_found', message: 'x' } } })
    expect(await store.correct('total', '1.00')).toBe(false)
    expect(store.correctionProblem && correctionRefusal(store.correctionProblem)).toBe('gone')
    site.failNext('POST /api/lb03/documents/', { status: 503, body: { error: { code: 'unavailable', message: 'x' } } })
    expect(await store.correct('total', '1.00')).toBe(false)
    expect(store.correctionProblem?.kind).toBe('unavailable')
  })

  it('lists the visitor\'s documents, opens one again after the board was emptied, and deletes it when it has ended', async () => {
    const { site, store } = await readClean()
    await store.loadDocuments()
    expect(store.documents).toHaveLength(1)
    const id = store.documents[0]?.id ?? ''
    store.reset()
    expect(store.onBoard).toBeUndefined()

    await store.open(id)
    expect(store.runMode).toBe('live')
    expect(store.onBoard?.id).toBe(id)
    expect(store.phase).toBe('done')
    expect(store.selectedPath).toBe('total')

    await store.remove(id)
    await vi.advanceTimersByTimeAsync(0)
    expect(site.callsTo(`/api/lb03/documents/${id}`, 'DELETE')).toHaveLength(1)
    expect(store.onBoard).toBeUndefined()
    expect(store.documents).toHaveLength(0)
  })

  it('does not delete a document that is still being read, and says so', async () => {
    const { store } = await start({ verified: true })
    await store.upload(fileOf('clean-pdf'))
    const id = store.onBoard?.id ?? ''
    await store.remove(id)
    expect(store.problem?.code).toBe('still_reading')
    expect(store.onBoard?.id).toBe(id)
  })

  it('says a document is not there when it has expired or never was', async () => {
    const { store } = await start({ verified: true })
    await store.open('no-such-document-id')
    expect(store.problem?.kind).toBe('notFound')
    expect(store.runMode).toBe('idle')
  })
})

describe('LB-03\'s store: when a reading goes wrong', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('gives up after three reads in a row that fail, and settles the Scope', async () => {
    const { site, store, scope } = await start({ verified: true })
    await store.upload(fileOf('clean-pdf'))
    for (let failures = 0; failures < 3; failures += 1) site.failNext('GET /api/lb03/documents/', { status: 500, body: { error: { code: 'internal_error', message: 'x' } } })
    await poll(4)
    expect(store.phase).toBe('done')
    expect(store.problem).toBeInstanceOf(ApiProblem)
    expect(scope.phase).toBe('missing')
  })

  it('goes on after a read that fails once', async () => {
    const { site, store } = await start({ verified: true })
    await store.upload(fileOf('clean-pdf'))
    site.failNext('GET /api/lb03/documents/', { status: 500, body: { error: { code: 'internal_error', message: 'x' } } })
    await poll(8)
    expect(store.phase).toBe('done')
    expect(store.onBoard?.state).toBe('ready')
    expect(store.problem).toBeUndefined()
  })

  it('stops waiting once the service\'s own limit and a little more has passed', async () => {
    const { store } = await start({ verified: true, lb03: { holdPolls: 100_000 } })
    await store.upload(fileOf('clean-pdf'))
    await vi.advanceTimersByTimeAsync(DOCUMENT_GIVE_UP_MS + 2 * DOCUMENT_POLL_MS)
    expect(store.phase).toBe('done')
    expect(store.problem?.kind).toBe('timeout')
    expect(store.onBoard?.state).toBe('uploaded')
  })

  it('stops following a reading when another run begins, so an old read never touches the board', async () => {
    const { site, store } = await start({ verified: true })
    await store.upload(fileOf('clean-pdf'))
    const first = store.onBoard?.id
    store.reset()
    await poll(5)
    expect(store.onBoard).toBeUndefined()
    expect(site.callsTo(`/api/lb03/documents/${first}`, 'GET')).toHaveLength(0)
  })
})

describe('LB-03\'s store: a replay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('plays a recording without a single request to the back end, and ends on the reading with a field lit', async () => {
    const { site, store, scope } = await start()
    const recording = recordLb03Sample({ sample: 'planted-total' })
    store.replayRecording(recording)
    expect(store.runMode).toBe('replay')
    expect(store.phase).toBe('reading')
    expect(store.replaySample).toBe('planted-total')
    await vi.advanceTimersByTimeAsync(9_000)
    expect(store.phase).toBe('done')
    expect(store.onBoard?.state).toBe('ready')
    expect(store.selectedPath).toBe('total')
    expect(scope.replayed).toBe(true)
    expect(scope.phase).toBe('finished')
    expect(site.calls.filter(call => call.path.startsWith('/api/lb03'))).toEqual([])
  })

  it('does not let a replay be corrected or deleted: nothing of it is at the service', async () => {
    const { site, store } = await start({ verified: true })
    store.replayRecording(recordLb03Sample({ sample: 'clean-pdf' }))
    await vi.advanceTimersByTimeAsync(9_000)
    expect(await store.correct('total', '1.00')).toBe(false)
    expect(site.callsTo('/api/lb03/documents/', 'POST')).toHaveLength(0)
    expect(store.live).toBe(false)
  })

  it('replays a document that failed with no fields and says where it stopped', async () => {
    const { store } = await start()
    store.replayRecording(recordLb03Sample({ sample: 'prompt-injection' }))
    await vi.advanceTimersByTimeAsync(9_000)
    expect(store.onBoard?.state).toBe('failed')
    expect(store.onBoard?.failure?.code).toBe('injection_suspected')
    expect(store.phase).toBe('done')
  })

  it('empties the replay when a live upload begins', async () => {
    const { store, replay } = await start({ verified: true })
    store.replayRecording(recordLb03Sample())
    await vi.advanceTimersByTimeAsync(9_000)
    await store.upload(fileOf('clean-pdf'))
    expect(store.runMode).toBe('live')
    expect(store.replaySample).toBeUndefined()
    expect(replay.recording).toBeUndefined()
  })
})
