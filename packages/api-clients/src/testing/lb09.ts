// LB-09 Meeting Recorder as the mock back end plays it: a visitor starts a meeting from a curated
// sample or from a recording of their own, follows the worker's stages over the WebSocket or by
// reading the meeting, and gets the transcript with its inferred speaker labels, the decisions and
// actions with their evidence and seconds, and the exports. The answers have the shapes
// services/django-systems/openapi.json documents. No model runs: a sample comes out as the golden
// set expects (lb09-seed.ts), and a visitor's own recording comes out as a short fixed meeting. The
// stages move on with the clock, one every `stageMs`, so a page sees them one by one, and a test can
// make the next meeting fail at the stage its reason belongs to.
import { randomBytes } from 'node:crypto'
import { errorAnswer } from './lb01.ts'
import type { Answer } from './lb01.ts'
import type { Lb09SampleSeed, Lb09Seed, SeedItem, SeedSegment } from './lb09-seed.ts'
import { STAGES, meetingSpans, stageIndex } from './lb09-spans.ts'
import type { MeetingTraceFacts, Stage } from './lb09-spans.ts'
import type { MockSpan } from './spans.ts'

/** The datasheet's limits, as the real service enforces them (lb09/limits.py). */
export const RECORDINGS_PER_DAY = 5
export const MAX_RECORDING_SECONDS = 60
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024
/** The longest frame the WebSocket takes, in bytes. */
export const MAX_FRAME_BYTES = 2_048
/** How long a meeting's rows are kept. */
const LIFETIME_MS = 24 * 60 * 60 * 1000
const DAY_MS = 86_400_000
/** The close codes the real service uses (lb09/events.py, CloseCode). */
export const CLOSE = { normal: 1000, unsupported: 1003, tooBig: 1009, unavailable: 1011, tryAgainLater: 1013, badFrame: 4400, unauthorized: 4401, notFound: 4404, timedOut: 4408 } as const

/** Why a meeting can fail, and the stage each reason belongs to. */
const FAILURE_STAGE: Record<string, Stage> = {
  undecodable: 'decoding',
  too_long: 'decoding',
  too_short: 'decoding',
  decode_limit: 'decoding',
  audio_gone: 'decoding',
  no_speech: 'transcribing',
  transcriber: 'transcribing',
  model: 'labelling',
  stale: 'extracting',
  pipeline_error: 'extracting',
}

/** What a test may choose about the mock's LB-09. */
export interface Lb09MockOptions {
  // The clock, in Unix milliseconds. The stages move on with it.
  now: () => number
  // Reads a visitor token and returns the visitor's session, or undefined when it is not good.
  verify: (token: string) => string | undefined
  // How long each stage takes: 700 ms by default, so a sample is done in about four seconds.
  stageMs?: number
  // How long a connection has to say hello (10 s in the real service), and how long it stays open after the end (5 s).
  helloTimeoutMs?: number
  lingerMs?: number
}

/** What a hub needs from the way frames travel. */
export interface Transport {
  send: (text: string) => void
  close: (code: number, reason?: string) => void
}

/** What the mock found in a meeting. */
interface Found {
  segments: SeedSegment[]
  items: SeedItem[]
  dropped: number
}

/** A meeting as the mock keeps it. */
interface MeetingRecord {
  id: string
  session: string
  sampleKey: string
  mode: 'fast' | 'private'
  language: string
  createdAt: number
  runId: string
  sourceBytes: number
  durationSeconds: number
  speakers: number
  failure: string | undefined
  found: Found
}

/** What starting a meeting takes. */
export interface StartMeetingRequest {
  source: 'upload' | 'sample'
  mode: 'fast' | 'private'
  audio?: string | null
  sample?: string | null
  language?: 'en' | 'cs' | null
}

/** The meeting a visitor's own recording comes out as: a few lines by two voices, one decision and one action. */
function uploadFound(seconds: number): Found {
  const lines = [
    { text: 'OK, let\'s go through what is left for the week.', speaker: 0, label: 'Speaker 1' },
    { text: 'I will send the roast schedule to the whole team by Thursday.', speaker: 1, label: 'Speaker 2' },
    { text: 'Good. Then we keep Friday afternoon for the cupping.', speaker: 0, label: 'Speaker 1' },
  ]
  const slice = Math.max(seconds / lines.length, 0.5)
  const segments: SeedSegment[] = lines.map((line, position) => ({
    position,
    start: Math.round((position * slice + 0.3) * 1_000) / 1_000,
    end: Math.round(Math.min((position + 1) * slice, seconds) * 1_000) / 1_000,
    text: line.text,
    speaker: line.speaker,
    label: line.label,
  }))
  const second = segments[1] ?? segments[0]
  const third = segments[2] ?? segments[0]
  if (!second || !third) return { segments, items: [], dropped: 0 }
  return {
    segments,
    items: [
      { position: 0, kind: 'decision', text: 'Keep Friday afternoon for the cupping', owner: null, deadline: null, evidence: third.text, start: third.start, end: third.end, first_segment: third.position, last_segment: third.position },
      { position: 1, kind: 'action', text: 'Send the roast schedule to the whole team', owner: 'Speaker 2', deadline: 'Thursday', evidence: second.text, start: second.start, end: second.end, first_segment: second.position, last_segment: second.position },
    ],
    dropped: 0,
  }
}

/** Reads a base64 recording's bytes, or undefined when it is not base64. */
function decodeBase64(text: string): Buffer | undefined {
  const clean = text.replace(/\s+/g, '')
  if (!/^[A-Z0-9+/]*={0,2}$/i.test(clean) || clean.length % 4 !== 0) return undefined
  return Buffer.from(clean, 'base64')
}

/** Tells a recording's container from its first bytes, as the real service does, or undefined for anything else. */
export function sniffContainer(data: Buffer): 'webm' | 'ogg' | 'mp4' | 'wav' | 'mp3' | undefined {
  if (data.subarray(0, 4).equals(Buffer.from([0x1A, 0x45, 0xDF, 0xA3]))) return 'webm'
  if (data.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg'
  if (data.length >= 12 && data.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4'
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WAVE') return 'wav'
  if (data.subarray(0, 3).toString('latin1') === 'ID3' || (data[0] === 0xFF && [0xFB, 0xFA, 0xF3, 0xF2].includes(data[1] ?? 0))) return 'mp3'
  return undefined
}

/**
 * Guesses how long a recording runs, the way the real decoder measures it from the samples: a 16 kHz mono WAV
 * is its data over 32,000 bytes a second; anything else is taken as compressed speech at about 16 kB a second.
 */
export function guessSeconds(data: Buffer, container: string): number {
  if (container === 'wav' && data.length > 44) return Math.round((data.length - 44) / 32_000 * 1_000) / 1_000
  return Math.round(data.length / 16_000 * 1_000) / 1_000
}

/** Makes a random ID of the real service's shape: 16 URL-safe characters. */
function newId(): string {
  return randomBytes(12).toString('base64url')
}

/** The mock's LB-09: its meetings, its allowances and the connections that follow a meeting. */
export class Lb09Mock {
  readonly #seed: Lb09Seed
  readonly #options: Lb09MockOptions
  readonly #meetings = new Map<string, MeetingRecord>()
  readonly #connections = new Set<Lb09Connection>()
  #pendingFailure: string | undefined

  /** Starts with no meetings. */
  constructor(seed: Lb09Seed, options: Lb09MockOptions) {
    this.#seed = seed
    this.#options = options
  }

  /** The clock the stages move with. */
  now(): number {
    return this.#options.now()
  }

  /** How long each stage takes. */
  get stageMs(): number {
    return this.#options.stageMs ?? 700
  }

  /** How long a connection has to say hello. */
  get helloTimeoutMs(): number {
    return this.#options.helloTimeoutMs ?? 10_000
  }

  /** How long a connection stays open after the meeting is over. */
  get lingerMs(): number {
    return this.#options.lingerMs ?? 5_000
  }

  /** Reads a visitor token. */
  verify(token: string): string | undefined {
    return this.#options.verify(token)
  }

  /** Forgets every meeting, drops every connection, and clears a pending failure. */
  reset(): void {
    for (const connection of [...this.#connections]) connection.drop(1001)
    this.#meetings.clear()
    this.#pendingFailure = undefined
  }

  /** Makes the next meeting fail with a reason, at the stage that reason belongs to. */
  failNext(reason: string): void {
    if (!(reason in FAILURE_STAGE)) throw new Error(`${reason} is not a failure a meeting can have.`)
    this.#pendingFailure = reason
  }

  /** Closes every open connection with a code, as a restart or a dropped network would. */
  dropAll(code = 1006): void {
    for (const connection of [...this.#connections]) connection.drop(code)
  }

  /** How many connections are open. */
  get openConnections(): number {
    return this.#connections.size
  }

  /** The curated samples, with the audio file the page plays for each. */
  samples(): Answer {
    return { status: 200, body: this.#seed.samples.map(sample => ({ key: sample.key, title: sample.title, about: sample.about, file: sample.file, seconds: sample.seconds, speakers: sample.speakers })) }
  }

  /** What is left of the visitor's day. */
  limits(session: string): Answer {
    const used = this.#startedToday(session)
    return {
      status: 200,
      body: { recordings_per_day: RECORDINGS_PER_DAY, used_today: used, left_today: Math.max(RECORDINGS_PER_DAY - used, 0), resets_at: new Date(this.#midnight() + DAY_MS).toISOString(), max_recording_seconds: MAX_RECORDING_SECONDS, max_upload_bytes: MAX_UPLOAD_BYTES },
    }
  }

  /** Starts a meeting from a sample or a recording, as the real API does, with its checks and its daily limit. */
  start(session: string, request: StartMeetingRequest): Answer {
    let sample: Lb09SampleSeed | undefined
    let sourceBytes: number
    let seconds: number
    if (request.source === 'sample') {
      sample = this.#seed.samples.find(candidate => candidate.key === request.sample)
      if (!sample) return errorAnswer(404, 'unknown_sample', 'There is no sample with that key.')
      sourceBytes = Math.round(sample.seconds * 4_000)
      seconds = sample.seconds
    }
    else {
      const data = decodeBase64(request.audio ?? '')
      if (!data) return errorAnswer(415, 'unsupported_audio', 'The recording isn\'t valid base64.')
      if (data.length > MAX_UPLOAD_BYTES) return errorAnswer(413, 'audio_too_big', `A recording may be at most ${MAX_UPLOAD_BYTES} bytes.`)
      const container = sniffContainer(data)
      if (!container) return errorAnswer(415, 'unsupported_audio', 'The recording isn\'t in a container the recorder takes.')
      sourceBytes = data.length
      seconds = guessSeconds(data, container)
    }
    if (this.#startedToday(session) >= RECORDINGS_PER_DAY) return errorAnswer(429, 'daily_limit', `A visitor may record ${RECORDINGS_PER_DAY} meetings a day.`)
    let failure = this.#pendingFailure
    this.#pendingFailure = undefined
    if (failure === undefined && seconds > MAX_RECORDING_SECONDS) failure = 'too_long'
    if (failure === undefined && seconds < 0.5) failure = 'too_short'
    const found = sample ? { segments: sample.segments, items: sample.items, dropped: 0 } : uploadFound(Math.min(seconds, MAX_RECORDING_SECONDS))
    const meeting: MeetingRecord = {
      id: newId(),
      session,
      sampleKey: sample?.key ?? '',
      mode: request.mode,
      language: request.language ?? '',
      createdAt: this.now(),
      runId: `lb09-${newId()}`,
      sourceBytes,
      durationSeconds: Math.min(seconds, MAX_RECORDING_SECONDS),
      speakers: sample?.speakers ?? 2,
      failure,
      found,
    }
    this.#meetings.set(meeting.id, meeting)
    return { status: 202, body: this.#view(meeting) }
  }

  /** The visitor's own meetings, newest first. */
  list(session: string): Answer {
    const mine = [...this.#meetings.values()].filter(meeting => meeting.session === session && !this.#expired(meeting)).sort((a, b) => b.createdAt - a.createdAt)
    return { status: 200, body: mine.slice(0, 20).map(meeting => this.#view(meeting)) }
  }

  /** Where one of the visitor's meetings stands. */
  get(session: string, id: string): Answer {
    const meeting = this.#own(session, id)
    if (!meeting) return errorAnswer(404, 'not_found', 'There is no such meeting.')
    return { status: 200, body: this.#view(meeting) }
  }

  /** The transcript of a finished meeting. */
  transcript(session: string, id: string): Answer {
    const meeting = this.#own(session, id)
    if (!meeting) return errorAnswer(404, 'not_found', 'There is no such meeting.')
    if (this.#status(meeting) !== 'done') return errorAnswer(409, 'not_done', 'The transcript is ready once the meeting is done.')
    return { status: 200, body: { meeting: meeting.id, labels_note: 'Speaker labels are inferred from the words, not matched to voices.', segments: meeting.found.segments } }
  }

  /** The items of a finished meeting. */
  items(session: string, id: string): Answer {
    const meeting = this.#own(session, id)
    if (!meeting) return errorAnswer(404, 'not_found', 'There is no such meeting.')
    if (this.#status(meeting) !== 'done') return errorAnswer(409, 'not_done', 'The items are ready once the meeting is done.')
    return { status: 200, body: { meeting: meeting.id, dropped: meeting.found.dropped, items: meeting.found.items } }
  }

  /** An export of a finished meeting, in one of the three formats. */
  export(session: string, id: string, format: string | null): Answer {
    const meeting = this.#own(session, id)
    if (!meeting) return errorAnswer(404, 'not_found', 'There is no such meeting.')
    if (format !== 'json' && format !== 'csv' && format !== 'text') return { status: 422, body: { error: { code: 'invalid_request', message: 'The request doesn\'t have the expected form.', fields: 'format' } } }
    if (this.#status(meeting) !== 'done') return errorAnswer(409, 'not_done', 'An export is ready once the meeting is done.')
    const suffix = { json: '.json', csv: '.csv', text: '.txt' }[format]
    const contentType = { json: 'application/json', csv: 'text/csv', text: 'text/plain' }[format]
    const content = format === 'json'
      ? `${JSON.stringify({ meeting: { id: meeting.id }, items: meeting.found.items, transcript: meeting.found.segments }, null, 2)}\n`
      : format === 'csv'
        ? `kind,text,owner,deadline,start_seconds,end_seconds,evidence\n${meeting.found.items.map(item => [item.kind, item.text, item.owner ?? '', item.deadline ?? '', item.start, item.end, item.evidence].map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n')}\n`
        : `When the minutes of this meeting are approved, follow up on them.\n${meeting.found.items.map(item => `- ${item.text}.`).join('\n')}\n`
    return { status: 200, body: { format, filename: `meeting-${meeting.id}${suffix}`, content_type: contentType, content } }
  }

  /** The spans of a meeting's trace, as far as the worker has got, or undefined for a run that is not LB-09's. */
  spansOf(runId: string): MockSpan[] | undefined {
    const meeting = [...this.#meetings.values()].find(candidate => candidate.runId === runId)
    if (!meeting) return undefined
    const facts: MeetingTraceFacts = {
      mode: meeting.mode,
      sample: meeting.sampleKey !== '',
      seconds: meeting.durationSeconds,
      segments: meeting.found.segments.length,
      speakers: meeting.speakers,
      decisions: meeting.found.items.filter(item => item.kind === 'decision').length,
      actions: meeting.found.items.filter(item => item.kind === 'action').length,
      dropped: meeting.found.dropped,
      failure: this.#status(meeting) === 'failed' ? meeting.failure : undefined,
    }
    const reached = this.#reached(meeting)
    const over = this.#status(meeting) === 'done' || this.#status(meeting) === 'failed'
    return meetingSpans(meeting.runId, meeting.createdAt, this.stageMs, facts, reached, over)
  }

  /** Opens a connection that will follow a meeting once it has said hello. */
  open(transport: Transport): Lb09Connection {
    const connection = new Lb09Connection(this, transport)
    this.#connections.add(connection)
    return connection
  }

  /** Forgets a connection that closed. */
  forget(connection: Lb09Connection): void {
    this.#connections.delete(connection)
  }

  /** Describes one of the visitor's meetings for the WebSocket, or undefined when there is no such meeting. */
  stateFor(session: string, id: string): Record<string, unknown> | undefined {
    const meeting = this.#own(session, id)
    return meeting ? this.#state(meeting) : undefined
  }

  /** The start of today, UTC. */
  #midnight(): number {
    return Math.floor(this.now() / DAY_MS) * DAY_MS
  }

  /** How many meetings a visitor started since midnight. */
  #startedToday(session: string): number {
    const midnight = this.#midnight()
    return [...this.#meetings.values()].filter(meeting => meeting.session === session && meeting.createdAt >= midnight).length
  }

  /** Whether a meeting's 24 hours are up. */
  #expired(meeting: MeetingRecord): boolean {
    return meeting.createdAt + LIFETIME_MS <= this.now()
  }

  /** Finds a visitor's own meeting; anyone else's, or an expired one, is not found. */
  #own(session: string, id: string): MeetingRecord | undefined {
    const meeting = this.#meetings.get(id)
    return meeting && meeting.session === session && !this.#expired(meeting) ? meeting : undefined
  }

  /** The stage the worker has reached, from how long the meeting has been running, stopping at the stage it fails in. */
  #reached(meeting: MeetingRecord): Stage {
    const elapsed = Math.max(this.now() - meeting.createdAt, 0)
    const index = Math.min(Math.floor(elapsed / this.stageMs), STAGES.length - 1)
    const failing = meeting.failure === undefined ? undefined : FAILURE_STAGE[meeting.failure]
    if (failing !== undefined && index >= stageIndex(failing)) return failing
    return STAGES[index] ?? 'received'
  }

  /** Whether the worker has finished with the meeting, well or badly: the stage after the failing one, or `done`. */
  #status(meeting: MeetingRecord): 'received' | 'processing' | 'done' | 'failed' {
    const elapsed = Math.max(this.now() - meeting.createdAt, 0)
    const index = Math.min(Math.floor(elapsed / this.stageMs), STAGES.length - 1)
    const failing = meeting.failure === undefined ? undefined : FAILURE_STAGE[meeting.failure]
    if (failing !== undefined && index > stageIndex(failing)) return 'failed'
    if (index === 0) return 'received'
    return index >= STAGES.length - 1 ? 'done' : 'processing'
  }

  /** The stage as the API names it: `failed` once the meeting has failed. */
  #stage(meeting: MeetingRecord): string {
    return this.#status(meeting) === 'failed' ? 'failed' : this.#reached(meeting)
  }

  /** When the meeting's row last changed: at the start of its current stage. */
  #updatedAt(meeting: MeetingRecord): number {
    const status = this.#status(meeting)
    const stage = status === 'failed' ? stageIndex(FAILURE_STAGE[meeting.failure ?? 'pipeline_error'] ?? 'extracting') + 1 : stageIndex(this.#reached(meeting))
    return meeting.createdAt + stage * this.stageMs
  }

  /** The state a WebSocket event and the API's meeting share. */
  #state(meeting: MeetingRecord): Record<string, unknown> {
    const status = this.#status(meeting)
    const over = status === 'done'
    return {
      meeting: meeting.id,
      status,
      stage: this.#stage(meeting),
      failure: status === 'failed' ? meeting.failure ?? null : null,
      run_id: meeting.runId,
      model_calls: over ? 2 : stageIndex(this.#reached(meeting)) >= stageIndex('extracting') ? 1 : 0,
      dropped_items: over ? meeting.found.dropped : 0,
      updated_at: new Date(this.#updatedAt(meeting)).toISOString(),
    }
  }

  /** A meeting as the API describes it. */
  #view(meeting: MeetingRecord): Record<string, unknown> {
    const state = this.#state(meeting)
    const reached = stageIndex(this.#reached(meeting))
    const heard = reached >= stageIndex('labelling') || this.#status(meeting) === 'done'
    return {
      id: meeting.id,
      sample: meeting.sampleKey || null,
      mode: meeting.mode,
      status: state.status,
      stage: state.stage,
      failure: state.failure,
      run_id: meeting.runId,
      language: meeting.language || null,
      heard_language: heard ? 'en' : '',
      transcriber: heard ? (meeting.mode === 'fast' ? 'lb-stt' : 'local/faster-whisper/base') : '',
      duration_seconds: reached >= stageIndex('transcribing') ? meeting.durationSeconds : 0,
      source_bytes: meeting.sourceBytes,
      model_calls: state.model_calls,
      dropped_items: state.dropped_items,
      labels_inferred_from_text: true,
      created_at: new Date(meeting.createdAt).toISOString(),
      updated_at: state.updated_at,
      expires_at: new Date(meeting.createdAt + LIFETIME_MS).toISOString(),
    }
  }
}

/** One visitor's connection to a meeting's progress: a hello first, then the states as the stages move on. */
export class Lb09Connection {
  readonly #mock: Lb09Mock
  readonly #transport: Transport
  #session: string | undefined
  #meeting: string | undefined
  #lastState: string | undefined
  #frames = 0
  #closed = false
  #helloTimer: ReturnType<typeof setTimeout> | undefined
  #ticker: ReturnType<typeof setInterval> | undefined
  #lingerTimer: ReturnType<typeof setTimeout> | undefined

  /** Starts the hello timeout. */
  constructor(mock: Lb09Mock, transport: Transport) {
    this.#mock = mock
    this.#transport = transport
    this.#helloTimer = setTimeout(() => this.#close(CLOSE.timedOut), mock.helloTimeoutMs)
  }

  /** Takes one text frame from the client. */
  receive(text: string): void {
    if (this.#closed) return
    if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) {
      this.#close(CLOSE.tooBig)
      return
    }
    this.#frames += 1
    if (this.#meeting !== undefined) {
      if (this.#frames > 8) this.#close(CLOSE.badFrame)
      else this.#send({ type: 'error', code: 'already_said_hello', message: 'This connection is already open.' })
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(text)
    }
    catch {
      this.#close(CLOSE.badFrame)
      return
    }
    if (!isHello(frame)) {
      this.#close(CLOSE.badFrame)
      return
    }
    const session = this.#mock.verify(frame.token)
    if (session === undefined) {
      this.#close(CLOSE.unauthorized)
      return
    }
    if (this.#helloTimer !== undefined) clearTimeout(this.#helloTimer)
    this.#helloTimer = undefined
    this.#session = session
    this.#meeting = frame.meeting
    const state = this.#mock.stateFor(session, frame.meeting)
    if (!state) {
      this.#send({ type: 'error', code: 'meeting_gone', message: 'That meeting doesn\'t exist, or its data has been removed.' })
      this.#close(CLOSE.notFound)
      return
    }
    this.#show(state)
    this.#ticker = setInterval(() => this.#tick(), 100)
  }

  /** The client closed the connection, or the socket died. */
  dispose(): void {
    this.#stopTimers()
    this.#closed = true
    this.#mock.forget(this)
  }

  /** The server closes the connection with a code, as a restart or a dropped network would. */
  drop(code: number): void {
    this.#close(code)
  }

  /** Looks at the meeting again and sends its state when it changed; once it is over, lingers and closes. */
  #tick(): void {
    if (this.#session === undefined || this.#meeting === undefined) return
    const state = this.#mock.stateFor(this.#session, this.#meeting)
    if (!state) return
    this.#show(state)
  }

  /** Sends a state the client has not seen, and arranges the close once the meeting is over. */
  #show(state: Record<string, unknown>): void {
    const text = JSON.stringify({ type: 'state', ...state })
    if (text === this.#lastState) return
    this.#lastState = text
    this.#transport.send(text)
    if ((state.status === 'done' || state.status === 'failed') && this.#lingerTimer === undefined) {
      if (this.#ticker !== undefined) clearInterval(this.#ticker)
      this.#ticker = undefined
      this.#lingerTimer = setTimeout(() => this.#close(CLOSE.normal), this.#mock.lingerMs)
    }
  }

  /** Sends an event. */
  #send(event: Record<string, unknown>): void {
    if (!this.#closed) this.#transport.send(JSON.stringify(event))
  }

  /** Closes the connection with a code and forgets it. */
  #close(code: number): void {
    if (this.#closed) return
    this.#stopTimers()
    this.#closed = true
    this.#mock.forget(this)
    this.#transport.close(code)
  }

  /** Stops every timer the connection holds. */
  #stopTimers(): void {
    if (this.#helloTimer !== undefined) clearTimeout(this.#helloTimer)
    if (this.#ticker !== undefined) clearInterval(this.#ticker)
    if (this.#lingerTimer !== undefined) clearTimeout(this.#lingerTimer)
    this.#helloTimer = undefined
    this.#ticker = undefined
    this.#lingerTimer = undefined
  }
}

/** Tells whether a frame is a hello of the protocol's shape: a type, a token and a meeting ID, and nothing else. */
function isHello(frame: unknown): frame is { type: 'hello', token: string, meeting: string } {
  if (typeof frame !== 'object' || frame === null) return false
  const keys = Object.keys(frame).sort()
  if (keys.join(',') !== 'meeting,token,type') return false
  const { type, token, meeting } = frame as Record<string, unknown>
  return type === 'hello' && typeof token === 'string' && token.length > 0 && token.length <= 2_048 && typeof meeting === 'string' && /^[\w-]{16,24}$/.test(meeting)
}
