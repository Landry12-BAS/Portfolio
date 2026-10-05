// Tests of LB-09's board store against the fake site: a curated meeting run live and followed over
// the WebSocket to its transcript and items, the fallback to reading the meeting when the socket
// cannot be opened, the Scope following the run, the day's recordings counted and used up, a meeting
// the worker fails, a recording too big to send, and a replay from a recording that makes no request
// and shows the result only when it has played out.
import { recordingSchema } from '@lb/contracts'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLb09Store } from '~/boards/lb-09/store'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import { recordLb09Sample } from '../support/lb09-recording'
import { FakeLb09Site, NOW, SESSION } from '../support/lb09-site'
import type { FakeLb09Options } from '../support/lb09-site'

/** Sets the fake site up as the browser's, with the stores fresh and the session read. */
async function openSite(options: FakeLb09Options = {}) {
  const site = new FakeLb09Site({ verified: true, ...options })
  vi.stubGlobal('fetch', site.fetch)
  vi.stubGlobal('WebSocket', site.socketClass())
  vi.stubGlobal('location', new URL('http://site.test/'))
  setActivePinia(createPinia())
  const session = useSessionStore()
  await session.load()
  const store = useLb09Store()
  await store.loadLimits()
  return { site, store, session }
}

/** Lets time pass with the timers and the promises running. */
async function pass(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a curated meeting run live', () => {
  it('is taken, followed over the socket through every stage, and read in full when done', async () => {
    const { site, store } = await openSite()
    expect(store.quota?.remaining).toBe(5)
    await store.startSample('monday-roasting-plan', 'monday-roasting-plan.mp3', 'en')
    expect(store.runMode).toBe('live')
    expect(store.phase).toBe('working')
    expect(store.feed).toBe('socket')
    expect(store.playback).toEqual({ url: '/lb09/monday-roasting-plan.mp3', own: false })
    expect(store.quota?.remaining).toBe(4)
    expect(site.callsTo('/api/lb09/meetings', 'POST')).toHaveLength(1)
    expect(site.callsTo('/api/lb09/meetings', 'POST')[0]?.body).toEqual({ source: 'sample', sample: 'monday-roasting-plan', mode: 'fast', language: 'en' })
    await pass(10)
    expect(site.socket.sent).toHaveLength(1)
    expect(JSON.parse(site.socket.sent[0] ?? '{}')).toMatchObject({ type: 'hello', meeting: store.meeting?.id })
    await pass(8 * 700 + 300)
    expect(store.phase).toBe('done')
    expect(store.stages).toEqual(['received', 'decoding', 'transcribing', 'labelling', 'extracting', 'aligning', 'done'])
    expect(store.transcript?.segments.length).toBeGreaterThan(0)
    expect(store.items?.items).toHaveLength(5)
    expect(store.meeting?.transcriber).toBe('lb-stt')
    // The meeting was read twice, not polled: once when the transcription was over, for the facts the socket's states
    // leave out (the transcriber, the language, the length), and once at the end. The socket carried the progress.
    expect(site.callsTo(`/api/lb09/meetings/${store.meeting?.id}`, 'GET').filter(call => !call.path.includes('/transcript') && !call.path.includes('/items'))).toHaveLength(2)
    expect(store.mine[0]).toMatchObject({ id: store.meeting?.id, status: 'done' })
    const scope = useScopeStore()
    expect(scope.runId).toBe(store.meeting?.run_id)
    expect(scope.spans.length).toBeGreaterThan(0)
  })

  it('knows the transcriber, the language and the length as soon as the transcription is over, and keeps the list in step', async () => {
    const { store } = await openSite()
    await store.startSample('monday-roasting-plan', 'monday-roasting-plan.mp3', 'en')
    await pass(3 * 700 + 300)
    expect(store.meeting?.stage).toBe('labelling')
    expect(store.meeting?.transcriber).toBe('lb-stt')
    expect(store.meeting?.heard_language).toBe('en')
    expect(store.meeting?.duration_seconds).toBeGreaterThan(40)
    expect(store.mine[0]).toMatchObject({ id: store.meeting?.id, status: 'processing', stage: 'labelling' })
  })

  it('reads the meeting every second or two when the socket cannot be opened, and says so', async () => {
    const { site, store } = await openSite()
    site.refuseConnections = true
    await store.startSample('weekend-staffing', 'weekend-staffing.mp3', 'en')
    await pass(50)
    expect(store.feed).toBe('polling')
    await pass(8 * 700 + 2_000)
    expect(store.phase).toBe('done')
    expect(site.callsTo(`/api/lb09/meetings/${store.meeting?.id}`, 'GET').length).toBeGreaterThan(2)
    expect(store.items?.items).toHaveLength(1)
  })

  it('falls back to reading when the grant for the socket is refused', async () => {
    const { site, store } = await openSite()
    site.refuseGrants = true
    await store.startSample('weekend-staffing', 'weekend-staffing.mp3', 'en')
    await pass(50)
    expect(store.feed).toBe('polling')
    expect(site.sockets).toHaveLength(0)
  })

  it('shows the worker\'s failure and its reason', async () => {
    const { site, store } = await openSite()
    site.lb09.failNext('no_speech')
    await store.startSample('weekend-staffing', 'weekend-staffing.mp3', 'en')
    await pass(8 * 700 + 300)
    expect(store.phase).toBe('failed')
    expect(store.meeting?.status).toBe('failed')
    expect(store.meeting?.failure).toBe('no_speech')
    expect(store.transcript).toBeUndefined()
    expect(store.problem).toBeUndefined()
  })

  it('says the day\'s recordings are used up, and spends nothing', async () => {
    const { site, store } = await openSite()
    for (let count = 0; count < 5; count += 1) site.lb09.start(SESSION, { source: 'sample', sample: 'weekend-staffing', mode: 'fast', language: 'en' })
    await store.loadLimits()
    expect(store.quota?.remaining).toBe(0)
    await store.startSample('weekend-staffing', 'weekend-staffing.mp3', 'en')
    expect(store.phase).toBe('failed')
    expect(store.problem?.code).toBe('daily_limit')
    expect(site.sockets).toHaveLength(0)
  })

  it('refuses to send a recording bigger than the service takes, without a request', async () => {
    const { site, store } = await openSite()
    const bytes = new Uint8Array(3 * 1024 * 1024 + 1)
    bytes.set([0x1A, 0x45, 0xDF, 0xA3])
    await store.startUpload({ bytes, container: 'webm', mimeType: 'audio/webm' }, 'blob:site.test/one')
    expect(store.problem?.code).toBe('audio_too_big')
    expect(site.callsTo('/api/lb09/meetings', 'POST')).toHaveLength(0)
  })

  it('sends the visitor\'s recording as base64 with no language, so the transcriber hears which, and plays it from the browser', async () => {
    const { site, store } = await openSite()
    const bytes = new Uint8Array(4_000)
    bytes.set([0x1A, 0x45, 0xDF, 0xA3])
    await store.startUpload({ bytes, container: 'webm', mimeType: 'audio/webm' }, 'blob:site.test/one')
    const sent = site.callsTo('/api/lb09/meetings', 'POST')[0]?.body as { source: string, audio: string, language?: string }
    expect(sent.source).toBe('upload')
    expect(sent.language).toBeUndefined()
    expect(sent.audio.length).toBeGreaterThan(5_000)
    expect(store.playback).toEqual({ url: 'blob:site.test/one', own: true })
    expect(store.source).toEqual({ kind: 'upload' })
  })

  it('counts the day again when a meeting ends, so one the service could not finish is given back', async () => {
    const { site, store } = await openSite()
    site.lb09.failNext('transcriber')
    await store.startSample('weekend-staffing', 'weekend-staffing.mp3', 'en')
    expect(store.quota?.remaining).toBe(4)
    await pass(8 * 700 + 300)
    expect(store.meeting?.failure).toBe('transcriber')
    expect(store.quota?.remaining).toBe(5)
  })

  it('has a Scope that gave up on a long meeting look again when the meeting ends, and read the trace to its end', async () => {
    // Six stages of 25 seconds: the meeting ends at 150 seconds, the worker's own limit, past the Scope's patience.
    const { store } = await openSite({ lb09: { stageMs: 25_000 } })
    await store.startSample('weekend-staffing', 'weekend-staffing.mp3', 'en')
    const scope = useScopeStore()
    await pass(125_000)
    expect(store.phase).toBe('working')
    expect(scope.phase).toBe('stalled')
    await pass(30_000)
    expect(store.phase).toBe('done')
    await pass(3_000)
    expect(scope.phase).toBe('finished')
    expect(scope.spans.some(span => span.kind === 'system.run')).toBe(true)
  })
})

describe('the visitor\'s meetings', () => {
  it('lists the meetings, newest first, and opens one again where it stands after a reload', async () => {
    const { site, store } = await openSite()
    const own = new Uint8Array(48_000)
    own.set([0x1A, 0x45, 0xDF, 0xA3])
    site.lb09.start(SESSION, { source: 'upload', audio: Buffer.from(own).toString('base64'), mode: 'private' })
    await pass(1_000)
    site.lb09.start(SESSION, { source: 'sample', sample: 'monday-roasting-plan', mode: 'fast', language: 'en' })
    await store.loadMine()
    await store.loadLimits()
    expect(store.mine.map(meeting => meeting.sample)).toEqual(['monday-roasting-plan', null])
    expect(store.quota?.remaining).toBe(3)
    // The sample, still going: followed again, its audio from the site, and nothing spent.
    await store.openMeeting(store.mine[0]?.id ?? '')
    expect(store.phase).toBe('working')
    expect(store.playback).toEqual({ url: '/lb09/monday-roasting-plan.mp3', own: false })
    expect(store.quota?.remaining).toBe(3)
    await pass(9 * 700)
    expect(store.phase).toBe('done')
    expect(store.items?.items).toHaveLength(5)
    // The visitor's own recording: read whole, with nothing to play.
    await store.openMeeting(store.mine.find(meeting => meeting.sample === null)?.id ?? '')
    await pass(100)
    expect(store.phase).toBe('done')
    expect(store.source).toEqual({ kind: 'upload' })
    expect(store.playback).toBeUndefined()
    expect(site.callsTo('/api/lb09/meetings', 'POST')).toHaveLength(0)
  })

  it('stops waiting after its patience, says so, and keeps the meeting in the list', async () => {
    const { store } = await openSite({ lb09: { stageMs: 60_000 } })
    await store.startSample('weekend-staffing', 'weekend-staffing.mp3', 'en')
    await pass(241_000)
    expect(store.gaveUp).toBe(true)
    expect(store.phase).toBe('failed')
    expect(store.problem).toBeUndefined()
    expect(store.mine.map(meeting => meeting.id)).toContain(store.meeting?.id)
  })
})

describe('a replay', () => {
  it('makes no request, shows the stages as they were recorded, and the result when it has played out', async () => {
    const { site, store } = await openSite()
    const recording = recordingSchema.parse(recordLb09Sample({ sample: 'monday-roasting-plan' }))
    const before = site.calls.length
    store.replayRecording(recording, 'monday-roasting-plan', 'monday-roasting-plan.mp3')
    expect(store.runMode).toBe('replay')
    expect(store.phase).toBe('working')
    expect(store.feed).toBe('none')
    await pass(30_000)
    expect(useReplayStore().playing).toBe(false)
    expect(store.phase).toBe('done')
    expect(store.stages).toContain('transcribing')
    expect(store.items?.items).toHaveLength(5)
    expect(store.transcript?.segments.length).toBeGreaterThan(0)
    expect(site.calls.slice(before).filter(call => call.path.startsWith('/api/lb09/'))).toEqual([])
    expect(store.quota?.remaining).toBe(5)
  })
})
