// LB-09's board state: the meeting on the board (a curated sample run live, the visitor's own
// recording, one of the visitor's meetings opened again, or a replay from a recording), its progress
// stage by stage, the transcript and the items once it is done, the visitor's meetings of the last
// 24 hours, the recordings left today, and the limits the back end enforces. A live meeting is
// started with one request, followed over the API's WebSocket while the worker goes through it (the
// socket only listens: when it drops, the board reads the meeting every second or two instead, and
// says which of the two it is doing), and read in full when it is over: the meeting, then its
// transcript and its items. A reload loses nothing: the meeting stays in the visitor's list, from
// which it opens again where it stands. The Scope follows the run as soon as a state names it, and a
// Scope that stopped looking (a meeting longer than its patience) looks again when the meeting ends.
// Every answer and every socket event is checked with its schema before the board uses it.
import type { Exchange, Recording as ReplayRecording } from '@lb/contracts'
import { defineStore } from 'pinia'
import { ref, shallowRef, watch } from 'vue'

import { LB09_SAMPLES } from '#shared/data/samples/lb09'
import { socketGrantSchema } from '#shared/schema/session'

import { apiClients, callApi, postJson } from '~/board-kit/api'
import { ApiProblem, badAnswerProblem, cookieProblem, isApiProblem, unavailableProblem, verificationProblem } from '~/board-kit/problem'
import { exhausted } from '~/board-kit/quota'
import type { Quota } from '~/board-kit/quota'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import { toBase64 } from './audio'
import type { Recording } from './audio'
import { isOver, itemsSchema, limitsSchema, MAX_UPLOAD_BYTES, meetingListSchema, meetingSchema, RECORDINGS_PER_DAY, transcriptSchema } from './schemas'
import type { Items, Limits, Meeting, MeetingRequest, Mode, Stage, Transcript } from './schemas'
import { ProgressSocket } from './socket'
import type { EndReason, Grant } from './socket'
import type { StateEvent } from './wire'

/** The path meetings are started and listed at. */
const MEETINGS_PATH = '/api/lb09/meetings'

// A run's first span appears a moment after the worker takes the meeting, so "no trace yet" is not an error for this long.
const SCOPE_GRACE_MS = 8_000
// How long a Scope that had stopped looking for the trace looks again after the meeting ends: the root span is written as it ends.
const SCOPE_END_GRACE_MS = 6_000
// How often the meeting is read when the socket is not there to say.
const POLL_EVERY_MS = 1_500
// How long the board waits for a meeting to end before it gives up on it. The worker gives up at three minutes.
const MEETING_PATIENCE_MS = 240_000
// The stages after the transcription, when the meeting's row knows the transcriber, the language and the length.
const HEARD_STAGES: ReadonlySet<string> = new Set(['labelling', 'extracting', 'aligning'])

/** What the board holds without a count from the back end: the datasheet's limits. */
export const DEFAULT_LIMITS: Limits = {
  recordings_per_day: RECORDINGS_PER_DAY,
  used_today: 0,
  left_today: RECORDINGS_PER_DAY,
  resets_at: '1970-01-01T00:00:00Z',
  max_recording_seconds: 60,
  max_upload_bytes: MAX_UPLOAD_BYTES,
}

/** Where the meeting on the board came from. */
export interface MeetingSource {
  kind: 'sample' | 'upload'
  // The sample's ID, for a curated meeting.
  sampleId?: string
}

/** What is on the board: nothing, a live meeting, or a replay. */
export type RunMode = 'idle' | 'live' | 'replay'

/** Where the meeting stands: nothing yet, being started, being worked through, done, or failed. */
export type RunPhase = 'idle' | 'starting' | 'working' | 'done' | 'failed'

/** How the board hears about progress: over the socket, by reading the meeting, or not at all (a replay). */
export type ProgressFeed = 'none' | 'socket' | 'polling'

/** Where the list of the visitor's meetings stands. */
export type MineStatus = 'idle' | 'loading' | 'ready' | 'failed'

/** The audio the player plays: a curated sample's file on the site, or the visitor's own recording held in the browser. */
export interface Playback {
  url: string
  // Whether the URL was made in the browser for a recording, and so must be let go of when the board is done with it.
  own: boolean
}

/** Reads a meeting's ID out of one of its paths, or undefined when the path is another route. */
function meetingPathParts(path: string): { id: string, rest: string } | undefined {
  const match = /^\/api\/lb09\/meetings\/([\w-]{16,24})(\/transcript|\/items)?$/.exec(path)
  return match ? { id: match[1] ?? '', rest: match[2] ?? '' } : undefined
}

/** Opens a WebSocket the way the browser does. It is looked up when it is used, so a test can replace it. */
function browserSocket(url: string) {
  return new globalThis.WebSocket(url)
}

/** Reads the address of the socket the site's server named, and refuses anything that is not a WebSocket address without credentials. */
function socketAddress(text: string): string {
  let url: URL
  try {
    url = new URL(text)
  }
  catch {
    throw badAnswerProblem()
  }
  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.username !== '' || url.password !== '') throw badAnswerProblem()
  return url.toString()
}

/** Asks the site for a pass for the socket: five minutes, for LB-09 only, and where to open it. */
async function fetchGrant(): Promise<Grant> {
  const grant = await postJson('/api/tokens/lb-09', undefined, socketGrantSchema)
  return { url: socketAddress(grant.socketUrl), token: grant.token }
}

/** Lets go of a URL the browser made for a recording, where the browser can. */
function revoke(playback: Playback | undefined): void {
  if (playback?.own && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(playback.url)
}

/** The audio of a curated sample, as the site serves it. */
function samplePlayback(file: string): Playback {
  return { url: `/lb09/${file}`, own: false }
}

/** Where a meeting came from and what can play it, for a meeting opened from the visitor's list: a sample's file, or nothing for their own recording, which only the page that sent it held. */
function sourceOf(meeting: Meeting): { source: MeetingSource, playback: Playback | undefined } {
  const sample = LB09_SAMPLES.find(candidate => candidate.id === meeting.sample)
  if (sample) return { source: { kind: 'sample', sampleId: sample.id }, playback: samplePlayback(sample.file) }
  return { source: { kind: 'upload' }, playback: undefined }
}

/** LB-09's board. */
export const useLb09Store = defineStore('lb09', () => {
  const session = useSessionStore()
  const scope = useScopeStore()
  const replay = useReplayStore()

  const quota = shallowRef<Quota>()
  const limits = shallowRef<Limits>(DEFAULT_LIMITS)
  const source = shallowRef<MeetingSource>()
  const mode = ref<Mode>('fast')
  const runMode = ref<RunMode>('idle')
  const phase = ref<RunPhase>('idle')
  const feed = ref<ProgressFeed>('none')
  const meeting = shallowRef<Meeting>()
  // The stages the board has seen the meeting reach, in order, so the steps can be drawn.
  const stages = shallowRef<readonly Stage[]>([])
  const transcript = shallowRef<Transcript>()
  const items = shallowRef<Items>()
  const playback = shallowRef<Playback>()
  const problem = shallowRef<ApiProblem>()
  // When the live meeting was started, in Unix milliseconds, for the time the board counts while it waits.
  const startedAt = ref<number>()
  // The visitor's meetings of the last 24 hours, newest first, so a reload or another tab finds them again.
  const mine = shallowRef<readonly Meeting[]>([])
  const mineStatus = ref<MineStatus>('idle')
  // The board stopped waiting for a meeting that had not ended: the service may still finish it, and it stays in the list.
  const gaveUp = ref(false)

  // The recorded transcript and items, held back until the replayed trace has played out.
  let recordedTranscript: Transcript | undefined
  let recordedItems: Items | undefined
  // Which run is current: starting another makes every callback of an older one stop touching the board.
  let generation = 0
  let socket: ProgressSocket | undefined
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let patience: ReturnType<typeof setTimeout> | undefined
  // Whether the end of the meeting is being read, so a socket event and a poll do not both read it.
  let finishing = false
  // Whether the facts the socket leaves out have been read for the meeting on the board.
  let factsRead = false

  /** Reads the visitor's recordings left today and the limits the back end enforces. */
  async function loadLimits(): Promise<void> {
    try {
      const today = await callApi(apiClients().django.GET('/api/lb09/limits'), limitsSchema)
      limits.value = today
      quota.value = { limit: today.recordings_per_day, used: today.used_today, remaining: today.left_today, resetsAt: today.resets_at }
    }
    catch {
      // Without a count the panel says it is counting, and a refusal from the back end still stops a recording.
    }
  }

  /** Reads the visitor's meetings of the last 24 hours, newest first. */
  async function loadMine(): Promise<void> {
    mineStatus.value = 'loading'
    try {
      mine.value = await callApi(apiClients().django.GET('/api/lb09/meetings'), meetingListSchema)
      mineStatus.value = 'ready'
    }
    catch {
      mineStatus.value = 'failed'
    }
  }

  /** Keeps the visitor's list in step with the meeting on the board, so a new or finished meeting shows at once. */
  function noteMine(seen: Meeting): void {
    mine.value = [seen, ...mine.value.filter(item => item.id !== seen.id)].slice(0, 20)
  }

  /** Stops the socket, the polling and the patience of the meeting in progress, its replay and its trace reading. */
  function stopRun(): void {
    generation += 1
    socket?.close()
    socket = undefined
    if (pollTimer !== undefined) clearTimeout(pollTimer)
    pollTimer = undefined
    if (patience !== undefined) clearTimeout(patience)
    patience = undefined
    finishing = false
    factsRead = false
    replay.stop()
    scope.stop()
  }

  /** Empties the board for the next meeting. The mode the visitor chose stays. */
  function reset(): void {
    stopRun()
    scope.clear()
    replay.clear()
    revoke(playback.value)
    playback.value = undefined
    source.value = undefined
    runMode.value = 'idle'
    phase.value = 'idle'
    feed.value = 'none'
    meeting.value = undefined
    stages.value = []
    transcript.value = undefined
    items.value = undefined
    problem.value = undefined
    startedAt.value = undefined
    gaveUp.value = false
    recordedTranscript = undefined
    recordedItems = undefined
  }

  /** Counts one recording against the day, from the moment the back end took it. */
  function spendOne(): void {
    const known = quota.value
    if (known) quota.value = { ...known, used: Math.min(known.used + 1, known.limit), remaining: Math.max(known.remaining - 1, 0) }
  }

  /** Sets the allowance to nothing left, when the back end says the day's recordings are used. */
  function useUp(resetsAt: string | undefined): void {
    const known = quota.value
    if (known) {
      quota.value = exhausted(known)
      return
    }
    const when = resetsAt ?? session.state?.resetsAt
    if (when !== undefined) quota.value = exhausted({ limit: limits.value.recordings_per_day, used: 0, remaining: limits.value.recordings_per_day, resetsAt: when })
  }

  /** Notes a stage the meeting reached, once. */
  function reach(stage: Stage): void {
    if (!stages.value.includes(stage)) stages.value = [...stages.value, stage]
  }

  /** Takes a state of the meeting, from the socket or a read: the fields that change while the worker works, and the Scope's run. */
  function apply(state: Pick<Meeting, 'status' | 'stage' | 'failure' | 'run_id' | 'model_calls' | 'dropped_items' | 'updated_at'>): void {
    const current = meeting.value
    if (!current) return
    const hadRun = current.run_id !== ''
    const merged = { ...current, ...state }
    meeting.value = merged
    noteMine(merged)
    reach(state.stage)
    if (!hadRun && state.run_id !== '' && runMode.value === 'live') scope.follow(state.run_id, { notFoundGraceMs: SCOPE_GRACE_MS })
    if (HEARD_STAGES.has(state.stage) && merged.transcriber === '' && !factsRead) void readFacts()
  }

  /**
   * Reads the meeting once its transcription is over, for what the socket's states leave out: the transcriber that ran,
   * the language it heard and the length it measured, which the facts show while the rest of the work goes on.
   */
  async function readFacts(): Promise<void> {
    factsRead = true
    const reading = generation
    const id = meeting.value?.id
    if (id === undefined) return
    try {
      const fresh = await callApi(apiClients().django.GET('/api/lb09/meetings/{meeting_id}', { params: { path: { meeting_id: id } } }), meetingSchema)
      const current = meeting.value
      if (reading !== generation || !current || isOver(current)) return
      meeting.value = { ...current, transcriber: fresh.transcriber, heard_language: fresh.heard_language, duration_seconds: fresh.duration_seconds }
    }
    catch {
      // The facts wait for the end of the meeting, which reads it whole.
    }
  }

  /** Shows why a live meeting has no result: a problem of the site's, not of the meeting's. */
  function fail(reason: unknown): void {
    scope.clear()
    phase.value = 'failed'
    feed.value = 'none'
    problem.value = isApiProblem(reason) ? reason : unavailableProblem()
    if (problem.value.code === 'daily_limit') useUp(problem.value.resetsAt)
  }

  /**
   * Has the Scope read the trace to its end. The root span is written as the meeting ends, and a meeting longer than the
   * Scope's patience (a slow transcription, slow providers, the worker's time limit) outlasts it: a Scope that had stopped
   * looking (nothing found, stalled, failed) looks again for a few seconds, keeping what it has.
   */
  function lookAgainAtTheEnd(runId: string): void {
    if (runMode.value !== 'live') return
    if (runId !== '' && (scope.phase === 'missing' || scope.phase === 'stalled' || scope.phase === 'failed' || scope.phase === 'idle')) {
      scope.follow(runId, { keepSpans: scope.runId === runId, notFoundGraceMs: SCOPE_END_GRACE_MS })
    }
    scope.settle()
  }

  /** Reads the meeting in full once it is over, and its transcript and items when it ended well. */
  async function finish(): Promise<void> {
    if (finishing) return
    finishing = true
    const reading = generation
    const id = meeting.value?.id
    if (id === undefined) return
    socket?.close()
    socket = undefined
    if (pollTimer !== undefined) clearTimeout(pollTimer)
    pollTimer = undefined
    if (patience !== undefined) clearTimeout(patience)
    patience = undefined
    try {
      const whole = await callApi(apiClients().django.GET('/api/lb09/meetings/{meeting_id}', { params: { path: { meeting_id: id } } }), meetingSchema)
      if (reading !== generation) return
      meeting.value = whole
      noteMine(whole)
      reach(whole.stage)
      if (whole.status === 'done') {
        const [words, found] = await Promise.all([
          callApi(apiClients().django.GET('/api/lb09/meetings/{meeting_id}/transcript', { params: { path: { meeting_id: id } } }), transcriptSchema),
          callApi(apiClients().django.GET('/api/lb09/meetings/{meeting_id}/items', { params: { path: { meeting_id: id } } }), itemsSchema),
        ])
        if (reading !== generation) return
        transcript.value = words
        items.value = found
        phase.value = 'done'
      }
      else {
        phase.value = 'failed'
      }
      feed.value = 'none'
      lookAgainAtTheEnd(whole.run_id)
      // A meeting the service could not finish gives its place back, so the day is read again rather than guessed.
      void loadLimits()
    }
    catch (error) {
      if (reading !== generation) return
      fail(error)
    }
  }

  /** Reads the meeting once, as the fallback does while the socket is not there. */
  async function poll(): Promise<void> {
    const reading = generation
    const id = meeting.value?.id
    if (id === undefined) return
    try {
      const state = await callApi(apiClients().django.GET('/api/lb09/meetings/{meeting_id}', { params: { path: { meeting_id: id } } }), meetingSchema)
      if (reading !== generation) return
      apply(state)
      if (isOver(state)) {
        void finish()
        return
      }
    }
    catch (error) {
      if (reading !== generation) return
      // A meeting that is gone will not come back; anything else is tried again.
      if (isApiProblem(error) && error.status === 404) {
        fail(error)
        return
      }
    }
    pollTimer = setTimeout(() => void poll(), POLL_EVERY_MS)
  }

  /** Falls back to reading the meeting, when the socket could not be opened or dropped before the end. */
  function startPolling(): void {
    if (phase.value !== 'working' || pollTimer !== undefined) return
    feed.value = 'polling'
    pollTimer = setTimeout(() => void poll(), POLL_EVERY_MS)
  }

  /** Hears a state from the socket. */
  function onState(event: StateEvent): void {
    apply({ status: event.status, stage: event.stage, failure: event.failure, run_id: event.run_id, model_calls: event.model_calls, dropped_items: event.dropped_items, updated_at: event.updated_at })
    if (isOver(event)) void finish()
  }

  /** The socket stopped: after the end that is expected; before it, the board reads the meeting instead. */
  function onSocketEnded(reason: EndReason): void {
    socket = undefined
    if (reason === 'over' || reason === 'visitor') return
    if (meeting.value && isOver(meeting.value)) return
    if (reason === 'gone') {
      fail(new ApiProblem(404, 'not_found', 'This meeting is gone: it expired or was never started.'))
      return
    }
    startPolling()
  }

  /**
   * Stops waiting for a meeting that has not ended in the board's patience. The service may still finish it (a worker that
   * was down takes it when it is back, or gives up on it and gives its place back), so the board says so and lists it.
   */
  function stopWaiting(): void {
    stopRun()
    scope.clear()
    phase.value = 'failed'
    feed.value = 'none'
    gaveUp.value = true
    void loadMine()
    void loadLimits()
  }

  /** Follows a meeting the back end took, or one of the visitor's opened again: over the socket first, and with patience for the whole run. */
  function follow(taken: Meeting): void {
    const reading = generation
    meeting.value = taken
    noteMine(taken)
    stages.value = []
    reach(taken.stage)
    phase.value = 'working'
    feed.value = 'socket'
    scope.wait()
    if (taken.run_id !== '') scope.follow(taken.run_id, { notFoundGraceMs: SCOPE_GRACE_MS })
    patience = setTimeout(() => {
      if (reading !== generation || phase.value !== 'working') return
      stopWaiting()
    }, MEETING_PATIENCE_MS)
    if (isOver(taken)) {
      void finish()
      return
    }
    socket = new ProgressSocket({ grant: fetchGrant, connect: browserSocket }, {
      state: (event) => {
        if (reading === generation) onState(event)
      },
      ended: (reason) => {
        if (reading === generation) onSocketEnded(reason)
      },
    })
    socket.open(taken.id)
  }

  /** Makes the request that starts a meeting. */
  function post(request: MeetingRequest): Promise<Meeting> {
    return callApi(apiClients().django.POST(MEETINGS_PATH, { body: request }), meetingSchema)
  }

  /**
   * Sends a meeting to the back end. If the server says the check is needed again (a new day began), runs
   * it and tries once more. If it still says so right after the check passed, the browser is not keeping
   * the session cookie that holds the result, which the visitor can fix, so that is said and not retried.
   */
  async function send(request: MeetingRequest): Promise<Meeting> {
    try {
      return await post(request)
    }
    catch (error) {
      if (!isApiProblem(error) || error.kind !== 'verification') throw error
      session.forgetVerification()
      if (!(await session.ensureVerified())) throw verificationProblem()
      try {
        return await post(request)
      }
      catch (again) {
        throw isApiProblem(again) && again.kind === 'verification' ? cookieProblem() : again
      }
    }
  }

  /** Starts a meeting live: after the check that the visitor is a person, which runs only now, and spending one of the day's recordings. */
  async function start(request: MeetingRequest, from: MeetingSource, audio: Playback | undefined): Promise<void> {
    if (runMode.value === 'live' && (phase.value === 'starting' || phase.value === 'working')) {
      revoke(audio)
      return
    }
    reset()
    runMode.value = 'live'
    phase.value = 'starting'
    source.value = from
    playback.value = audio
    const reading = generation
    scope.wait()
    if (!(await session.ensureVerified())) {
      if (reading !== generation) return
      fail(session.available ? (session.problem ?? verificationProblem()) : unavailableProblem())
      return
    }
    if (reading !== generation) return
    startedAt.value = Date.now()
    try {
      const taken = await send(request)
      if (reading !== generation) return
      spendOne()
      follow(taken)
    }
    catch (error) {
      if (reading !== generation) return
      fail(error)
    }
  }

  /**
   * Opens one of the visitor's own meetings again, as it stands: a finished one is read whole, one still going is
   * followed. A sample's audio plays from the site; the visitor's own recording was held only by the page that sent it,
   * and the service deleted it once transcribed, so there is nothing to play.
   */
  async function openMeeting(id: string): Promise<void> {
    if (runMode.value === 'live' && (phase.value === 'starting' || phase.value === 'working')) return
    reset()
    runMode.value = 'live'
    phase.value = 'starting'
    const reading = generation
    scope.wait()
    try {
      const found = await callApi(apiClients().django.GET('/api/lb09/meetings/{meeting_id}', { params: { path: { meeting_id: id } } }), meetingSchema)
      if (reading !== generation) return
      const { source: from, playback: audio } = sourceOf(found)
      source.value = from
      playback.value = audio
      follow(found)
    }
    catch (error) {
      if (reading !== generation) return
      fail(error)
      if (isApiProblem(error) && error.status === 404) void loadMine()
    }
  }

  /** Runs a curated sample live, in the mode the visitor chose. */
  function startSample(sampleId: string, file: string, language: 'en' | 'cs'): Promise<void> {
    return start({ source: 'sample', sample: sampleId, mode: mode.value, language }, { kind: 'sample', sampleId }, samplePlayback(file))
  }

  /**
   * Sends the visitor's own recording, held in the browser until now, in the mode the visitor chose. No language is
   * asked for: the transcriber works out the one the visitor speaks, where the page's language would be a guess, and a
   * wrong one makes Whisper write nonsense in it (an English meeting asked for in Czech came back as Czech words that
   * were never said, and took twelve times as long).
   */
  function startUpload(recording: Recording, url: string): Promise<void> {
    if (recording.bytes.length > limits.value.max_upload_bytes) {
      reset()
      fail(new ApiProblem(413, 'audio_too_big', 'The recording is bigger than the service takes.'))
      return Promise.resolve()
    }
    return start({ source: 'upload', audio: toBase64(recording.bytes), mode: mode.value }, { kind: 'upload' }, { url, own: true })
  }

  /** Applies a recorded answer as the API's own: the meeting as it was started and as it moved, and the transcript and items held back for the end. */
  function applyExchange(exchange: Exchange): void {
    const { path, method } = exchange.request
    if (exchange.response.status < 200 || exchange.response.status >= 300) return
    if (method === 'POST' && path === MEETINGS_PATH) {
      const started = meetingSchema.safeParse(exchange.response.body)
      if (!started.success) return
      meeting.value = started.data
      stages.value = []
      reach(started.data.stage)
      return
    }
    const parts = meetingPathParts(path)
    if (!parts || method !== 'GET') return
    if (parts.rest === '') {
      const state = meetingSchema.safeParse(exchange.response.body)
      if (state.success) {
        meeting.value = state.data
        reach(state.data.stage)
      }
      return
    }
    if (parts.rest === '/transcript') {
      const words = transcriptSchema.safeParse(exchange.response.body)
      if (words.success) recordedTranscript = words.data
      return
    }
    const found = itemsSchema.safeParse(exchange.response.body)
    if (found.success) recordedItems = found.data
  }

  /** Shows the recorded result when the replay has played out (a replay that was stopped has not), or says it had none. */
  function finishReplay(): void {
    if (runMode.value !== 'replay' || phase.value !== 'working') return
    if (!scope.replayed || scope.phase !== 'finished') return
    const ended = meeting.value
    if (!ended || !isOver(ended)) {
      problem.value = badAnswerProblem()
      phase.value = 'failed'
      return
    }
    if (ended.status === 'failed') {
      phase.value = 'failed'
      return
    }
    if (recordedTranscript && recordedItems) {
      transcript.value = recordedTranscript
      items.value = recordedItems
      phase.value = 'done'
    }
    else {
      problem.value = badAnswerProblem()
      phase.value = 'failed'
    }
  }

  // A replay ends when the player says it is no longer playing.
  watch(() => replay.playing, (playing) => {
    if (!playing) finishReplay()
  }, { flush: 'sync' })

  /** Replays a recording of a curated sample: no request is made and nothing is spent. */
  function replayRecording(recording: ReplayRecording, sampleId: string, file: string): void {
    reset()
    runMode.value = 'replay'
    phase.value = 'working'
    feed.value = 'none'
    source.value = { kind: 'sample', sampleId }
    playback.value = samplePlayback(file)
    replay.start(recording, (_, exchange) => applyExchange(exchange))
  }

  /** Shows a problem the board met outside a meeting, such as a recording that could not be read. */
  function report(reason: ApiProblem): void {
    problem.value = reason
  }

  /** Stops everything the board is doing, for when the visitor leaves it. */
  function dispose(): void {
    stopRun()
  }

  return {
    quota,
    limits,
    source,
    mode,
    runMode,
    phase,
    feed,
    meeting,
    stages,
    transcript,
    items,
    playback,
    problem,
    startedAt,
    mine,
    mineStatus,
    gaveUp,
    loadLimits,
    loadMine,
    openMeeting,
    startSample,
    startUpload,
    replayRecording,
    report,
    reset,
    dispose,
  }
})
