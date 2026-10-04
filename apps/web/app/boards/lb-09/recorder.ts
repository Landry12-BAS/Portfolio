// The microphone recorder: one minute of audio from the visitor's microphone, held in the browser
// until the visitor decides to send it. The browser's own pieces (getUserMedia, MediaRecorder and an
// AudioContext for the level meter) are handed in, so the tests drive the recorder with stand-ins and
// the page hands it the real ones (`browserRecorderDeps`). It asks for the microphone only when the
// visitor presses record, never on load; it counts the seconds and stops itself at the limit; it reads
// the sound level only while recording and only when the page asks for it (a visitor who prefers
// reduced motion gets no meter); and it lets go of the microphone the moment recording stops, so the
// browser's recording indicator goes off. The audio never leaves the page from here: the store sends
// the recording the visitor chose to send, and nothing else.
import { pickMimeType } from './audio.ts'
import { MAX_RECORDING_SECONDS } from './schemas.ts'

/** Where the recorder stands. */
export type RecorderState = 'idle' | 'asking' | 'recording' | 'recorded' | 'denied' | 'unsupported' | 'failed'

/** Why recording could not happen, when the state is `failed`. */
export type RecorderFailure = 'no_microphone' | 'in_use' | 'recorder' | 'empty'

/** One track of a media stream, as far as the recorder needs it. */
export interface TrackLike {
  stop: () => void
}

/** A media stream, as far as the recorder needs it. */
export interface StreamLike {
  getTracks: () => TrackLike[]
}

/** The part of the browser's MediaRecorder the recorder uses. */
export interface MediaRecorderLike {
  readonly mimeType: string
  start: () => void
  stop: () => void
  addEventListener: ((type: 'dataavailable', listener: (event: { data: Blob }) => void) => void)
    & ((type: 'stop', listener: () => void) => void)
    & ((type: 'error', listener: () => void) => void)
}

/** Reads the sound level of a stream, from 0 (silence) to 1, and lets go of the stream when closed. */
export interface LevelMeterLike {
  read: () => number
  close: () => void
}

/** What the recorder needs from the browser. */
export interface RecorderDeps {
  // Whether this browser can record at all.
  supported: () => boolean
  // Asks for the microphone; rejects as the browser does when the visitor says no or there is none.
  getUserMedia: () => Promise<StreamLike>
  // Whether the browser's recorder writes a format.
  isTypeSupported: (mime: string) => boolean
  // Makes a recorder over a stream, in a format.
  makeRecorder: (stream: StreamLike, mimeType: string) => MediaRecorderLike
  // Makes a level meter over a stream, or undefined when the browser can't.
  makeLevelMeter: (stream: StreamLike) => LevelMeterLike | undefined
}

/** What the recorder tells the page. */
export interface RecorderHandlers {
  // The recorder moved to a state; a failure says why when it is `failed`.
  state: (state: RecorderState, failure?: RecorderFailure) => void
  // Another second of recording passed.
  elapsed: (seconds: number) => void
  // The sound level now, from 0 to 1, a few times a second while recording with the meter on.
  level: (level: number) => void
  // Recording stopped and the audio is in the blob.
  recorded: (blob: Blob) => void
}

/** How often the recorder counts a second. */
export const TICK_MS = 1_000
/** How often the level meter is read while recording. */
export const LEVEL_EVERY_MS = 100

/** What a page may choose when it starts recording. */
export interface StartOptions {
  // Whether to read the sound level while recording. Off for a visitor who prefers reduced motion.
  levels: boolean
}

/** The errors `getUserMedia` rejects with when the visitor or the browser said no. */
const DENIED = new Set(['NotAllowedError', 'SecurityError', 'PermissionDeniedError'])
/** The errors that mean there is no microphone to record from. */
const NO_MICROPHONE = new Set(['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError'])
/** The errors that mean the microphone is there but could not be read. */
const IN_USE = new Set(['NotReadableError', 'TrackStartError', 'AbortError'])

/** Names a rejection of `getUserMedia`, which is a DOMException in a browser and anything in a test. */
function nameOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : ''
}

/** A recorder of one recording at a time. */
export class MicrophoneRecorder {
  readonly #deps: RecorderDeps
  readonly #handlers: RecorderHandlers
  #state: RecorderState = 'idle'
  #stream: StreamLike | undefined
  #recorder: MediaRecorderLike | undefined
  #meter: LevelMeterLike | undefined
  #chunks: Blob[] = []
  #elapsed = 0
  #tick: ReturnType<typeof setInterval> | undefined
  #levelTimer: ReturnType<typeof setInterval> | undefined
  // Which start is current: the callbacks of an older one are ignored.
  #generation = 0

  /** Makes a recorder that has not asked for anything yet. */
  constructor(deps: RecorderDeps, handlers: RecorderHandlers) {
    this.#deps = deps
    this.#handlers = handlers
  }

  /** Where the recorder stands. */
  get state(): RecorderState {
    return this.#state
  }

  /** How many whole seconds have been recorded. */
  get elapsed(): number {
    return this.#elapsed
  }

  /** Asks for the microphone and starts recording. Nothing happens while a recording is being asked for or made. */
  async start(options: StartOptions = { levels: true }): Promise<void> {
    if (this.#state === 'asking' || this.#state === 'recording') return
    this.#letGo()
    this.#chunks = []
    this.#elapsed = 0
    if (!this.#deps.supported()) {
      this.#move('unsupported')
      return
    }
    const generation = ++this.#generation
    this.#move('asking')
    let stream: StreamLike
    try {
      stream = await this.#deps.getUserMedia()
    }
    catch (error) {
      if (generation !== this.#generation) return
      this.#moveAfterRefusal(error)
      return
    }
    if (generation !== this.#generation) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    this.#stream = stream
    const mimeType = pickMimeType(this.#deps.isTypeSupported)
    if (mimeType === undefined) {
      this.#letGo()
      this.#move('unsupported')
      return
    }
    try {
      this.#recorder = this.#deps.makeRecorder(stream, mimeType)
      this.#listen(this.#recorder, generation)
      this.#recorder.start()
    }
    catch {
      this.#letGo()
      this.#move('failed', 'recorder')
      return
    }
    if (options.levels) this.#meter = this.#deps.makeLevelMeter(stream)
    this.#move('recording')
    this.#tick = setInterval(() => this.#count(), TICK_MS)
    if (this.#meter) this.#levelTimer = setInterval(() => this.#handlers.level(this.#meter?.read() ?? 0), LEVEL_EVERY_MS)
  }

  /** Stops recording; the audio arrives through `recorded` a moment later. */
  stop(): void {
    if (this.#state !== 'recording') return
    this.#stopTimers()
    const recorder = this.#recorder
    try {
      recorder?.stop()
    }
    catch {
      this.#letGo()
      this.#move('failed', 'recorder')
    }
  }

  /** Forgets the recording, or stops asking, and goes back to the start. */
  discard(): void {
    this.#generation += 1
    this.#letGo()
    this.#chunks = []
    this.#elapsed = 0
    this.#move('idle')
  }

  /** Lets go of everything, for when the page closes. */
  dispose(): void {
    this.#generation += 1
    this.#letGo()
  }

  /** Subscribes to what the browser's recorder reports. */
  #listen(recorder: MediaRecorderLike, generation: number): void {
    recorder.addEventListener('dataavailable', (event) => {
      if (generation === this.#generation && event.data.size > 0) this.#chunks.push(event.data)
    })
    recorder.addEventListener('stop', () => {
      if (generation !== this.#generation) return
      this.#finish(recorder.mimeType)
    })
    recorder.addEventListener('error', () => {
      if (generation !== this.#generation) return
      this.#letGo()
      this.#move('failed', 'recorder')
    })
  }

  /** Counts a second, and stops at the limit. */
  #count(): void {
    this.#elapsed += 1
    this.#handlers.elapsed(this.#elapsed)
    if (this.#elapsed >= MAX_RECORDING_SECONDS) this.stop()
  }

  /** Gathers the recording once the browser's recorder has stopped. */
  #finish(mimeType: string): void {
    this.#letGo()
    const blob = new Blob(this.#chunks, { type: mimeType })
    this.#chunks = []
    if (blob.size === 0) {
      this.#move('failed', 'empty')
      return
    }
    this.#move('recorded')
    this.#handlers.recorded(blob)
  }

  /** Says why the microphone was not given. */
  #moveAfterRefusal(error: unknown): void {
    const name = nameOf(error)
    if (DENIED.has(name)) this.#move('denied')
    else if (NO_MICROPHONE.has(name)) this.#move('failed', 'no_microphone')
    else if (IN_USE.has(name)) this.#move('failed', 'in_use')
    else this.#move('failed', 'recorder')
  }

  /** Moves to a state and tells the page. */
  #move(state: RecorderState, failure?: RecorderFailure): void {
    this.#state = state
    this.#handlers.state(state, failure)
  }

  /** Stops counting and reading the level. */
  #stopTimers(): void {
    if (this.#tick !== undefined) clearInterval(this.#tick)
    if (this.#levelTimer !== undefined) clearInterval(this.#levelTimer)
    this.#tick = undefined
    this.#levelTimer = undefined
  }

  /** Lets go of the microphone, the recorder and the meter. */
  #letGo(): void {
    this.#stopTimers()
    this.#meter?.close()
    this.#meter = undefined
    this.#recorder = undefined
    const stream = this.#stream
    this.#stream = undefined
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
    }
  }
}

/** The constructor of the browser's recorder, as far as the recorder needs it. */
interface MediaRecorderClass {
  new (stream: StreamLike, options: { mimeType: string }): MediaRecorderLike
  isTypeSupported: (mime: string) => boolean
}

/** The constructor of the browser's audio context, as far as the level meter needs it. */
interface AudioContextClass {
  new (): AudioContextLike
}

/** The part of an audio context the level meter uses. */
interface AudioContextLike {
  createMediaStreamSource: (stream: StreamLike) => { connect: (node: AnalyserLike) => void }
  createAnalyser: () => AnalyserLike
  close: () => Promise<void>
}

/** The part of an analyser node the level meter uses. */
interface AnalyserLike {
  fftSize: number
  getByteTimeDomainData: (array: Uint8Array) => void
}

/** The globals the browser gives, looked up when they are used so a test can stand them in. */
function browserGlobals(): { recorder: MediaRecorderClass | undefined, audio: AudioContextClass | undefined, media: { getUserMedia?: (constraints: { audio: boolean }) => Promise<StreamLike> } | undefined } {
  const scope = globalThis as unknown as { MediaRecorder?: MediaRecorderClass, AudioContext?: AudioContextClass, navigator?: { mediaDevices?: { getUserMedia?: (constraints: { audio: boolean }) => Promise<StreamLike> } } }
  return { recorder: scope.MediaRecorder, audio: scope.AudioContext, media: scope.navigator?.mediaDevices }
}

/** Speech is loud at a fraction of full scale, so the meter is scaled to fill at ordinary speaking volume. */
const LEVEL_GAIN = 4

/** Makes a level meter from the browser's analyser: the root mean square of the waveform, scaled. */
function browserLevelMeter(stream: StreamLike): LevelMeterLike | undefined {
  const { audio } = browserGlobals()
  if (!audio) return undefined
  try {
    const context = new audio()
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    context.createMediaStreamSource(stream).connect(analyser)
    const samples = new Uint8Array(analyser.fftSize)
    return {
      read: () => {
        analyser.getByteTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) {
          const centered = (sample - 128) / 128
          sum += centered * centered
        }
        return Math.min(Math.sqrt(sum / samples.length) * LEVEL_GAIN, 1)
      },
      close: () => {
        void context.close().catch(() => undefined)
      },
    }
  }
  catch {
    return undefined
  }
}

/** The browser's own pieces, for the page. */
export function browserRecorderDeps(): RecorderDeps {
  return {
    supported: () => {
      const { recorder, media } = browserGlobals()
      return recorder !== undefined && typeof media?.getUserMedia === 'function'
    },
    getUserMedia: () => {
      const { media } = browserGlobals()
      if (typeof media?.getUserMedia !== 'function') return Promise.reject(new Error('This browser cannot record.'))
      return media.getUserMedia({ audio: true })
    },
    isTypeSupported: (mime) => {
      const { recorder } = browserGlobals()
      return recorder !== undefined && recorder.isTypeSupported(mime)
    },
    makeRecorder: (stream, mimeType) => {
      const { recorder } = browserGlobals()
      if (!recorder) throw new Error('This browser cannot record.')
      return new recorder(stream, { mimeType })
    },
    makeLevelMeter: browserLevelMeter,
  }
}
