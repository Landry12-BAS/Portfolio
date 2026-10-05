// Tests of LB-09's microphone recorder over stand-ins for the browser's pieces: it asks for the
// microphone only when started, counts the seconds and stops itself at the limit, reads the level only
// when asked to, hands over the recording and lets go of the microphone, and says plainly when the
// browser cannot record, the visitor said no, there is no microphone, or it could not be read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LEVEL_EVERY_MS, MicrophoneRecorder, TICK_MS } from '~/boards/lb-09/recorder'
import type { MediaRecorderLike, RecorderDeps, RecorderFailure, RecorderState, StreamLike } from '~/boards/lb-09/recorder'
import { MAX_RECORDING_SECONDS } from '~/boards/lb-09/schemas'

/** A MediaRecorder the test drives: `stop()` fires the data and the stop event a moment later, as the browser does. */
class HandRecorder implements MediaRecorderLike {
  readonly mimeType: string
  started = 0
  readonly listeners: Record<string, ((event: never) => void)[]> = { dataavailable: [], stop: [], error: [] }
  // What the recorder hands over on stop: null means the browser recorded nothing.
  readonly chunk: Blob | null

  /** Writes a recorder for a format, with a chunk of audio to hand over, or none. */
  constructor(mimeType: string, empty: boolean) {
    this.mimeType = mimeType
    this.chunk = empty ? null : new Blob([new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, 1, 2, 3])], { type: mimeType })
  }

  /** Subscribes. */
  addEventListener(type: string, listener: (event: never) => void): void {
    this.listeners[type]?.push(listener)
  }

  /** Starts. */
  start(): void {
    this.started += 1
  }

  /** Stops: the data and the stop event follow on the next tick. */
  stop(): void {
    void Promise.resolve().then(() => {
      if (this.chunk) for (const listener of this.listeners.dataavailable ?? []) (listener as (event: { data: Blob }) => void)({ data: this.chunk })
      for (const listener of this.listeners.stop ?? []) (listener as () => void)()
    })
  }

  /** The browser reports an error. */
  fails(): void {
    for (const listener of this.listeners.error ?? []) (listener as () => void)()
  }
}

/** What the test may choose about the browser's pieces. */
interface Harness {
  supported?: boolean
  refuse?: { name: string }
  formats?: string[]
  // Whether the browser's recorder hands over no audio at all.
  empty?: boolean
  levels?: number[]
}

/** Makes the recorder over stand-ins and records what it tells the page. */
function build(harness: Harness = {}) {
  const tracks = [{
    stopped: 0,
    /** Counts the stop, as the browser's track would let the microphone go. */
    stop() {
      this.stopped += 1
    },
  }]
  const stream: StreamLike = { getTracks: () => tracks }
  const recorders: HandRecorder[] = []
  let meterClosed = 0
  const levels = harness.levels ?? [0.25]
  const deps: RecorderDeps = {
    supported: () => harness.supported ?? true,
    getUserMedia: () => (harness.refuse ? Promise.reject(harness.refuse) : Promise.resolve(stream)),
    isTypeSupported: mime => (harness.formats ?? ['audio/webm;codecs=opus']).includes(mime),
    makeRecorder: (_, mimeType) => {
      const recorder = new HandRecorder(mimeType, harness.empty ?? false)
      recorders.push(recorder)
      return recorder
    },
    makeLevelMeter: () => ({
      read: () => levels[0] ?? 0,
      close: () => {
        meterClosed += 1
      },
    }),
  }
  const states: { state: RecorderState, failure?: RecorderFailure }[] = []
  const seconds: number[] = []
  const readings: number[] = []
  const blobs: Blob[] = []
  const recorder = new MicrophoneRecorder(deps, {
    state: (state, failure) => states.push(failure ? { state, failure } : { state }),
    elapsed: value => seconds.push(value),
    level: value => readings.push(value),
    recorded: blob => blobs.push(blob),
  })
  return { recorder, states, seconds, readings, blobs, tracks, recorders, meterClosed: () => meterClosed }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the microphone recorder', () => {
  it('asks, records, counts, reads the level, and hands the recording over while letting go of the microphone', async () => {
    const built = build()
    const starting = built.recorder.start()
    expect(built.states.map(entry => entry.state)).toEqual(['asking'])
    await starting
    expect(built.states.map(entry => entry.state)).toEqual(['asking', 'recording'])
    expect(built.recorders[0]?.mimeType).toBe('audio/webm;codecs=opus')
    await vi.advanceTimersByTimeAsync(TICK_MS * 3)
    expect(built.seconds).toEqual([1, 2, 3])
    expect(built.readings.length).toBeGreaterThanOrEqual((TICK_MS * 3) / LEVEL_EVERY_MS - 1)
    expect(built.readings[0]).toBe(0.25)
    built.recorder.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(built.states.at(-1)).toEqual({ state: 'recorded' })
    expect(built.blobs).toHaveLength(1)
    expect(built.blobs[0]?.type).toBe('audio/webm;codecs=opus')
    expect(built.tracks[0]?.stopped).toBe(1)
    expect(built.meterClosed()).toBe(1)
  })

  it('stops itself at the limit', async () => {
    const built = build()
    await built.recorder.start()
    await vi.advanceTimersByTimeAsync(TICK_MS * MAX_RECORDING_SECONDS)
    await vi.advanceTimersByTimeAsync(0)
    expect(built.seconds.at(-1)).toBe(MAX_RECORDING_SECONDS)
    expect(built.states.at(-1)).toEqual({ state: 'recorded' })
    await vi.advanceTimersByTimeAsync(TICK_MS * 5)
    expect(built.seconds.at(-1)).toBe(MAX_RECORDING_SECONDS)
  })

  it('reads no level when the page asks for none', async () => {
    const built = build()
    await built.recorder.start({ levels: false })
    await vi.advanceTimersByTimeAsync(TICK_MS * 2)
    expect(built.readings).toEqual([])
    expect(built.seconds).toEqual([1, 2])
  })

  it('says the browser cannot record, before asking for anything', async () => {
    const built = build({ supported: false })
    await built.recorder.start()
    expect(built.states).toEqual([{ state: 'unsupported' }])
    expect(built.recorders).toHaveLength(0)
  })

  it('says the browser writes no format the service takes, and lets the microphone go', async () => {
    const built = build({ formats: ['audio/flac'] })
    await built.recorder.start()
    expect(built.states.at(-1)).toEqual({ state: 'unsupported' })
    expect(built.tracks[0]?.stopped).toBe(1)
  })

  it('tells a refusal from a missing microphone from one that could not be read', async () => {
    for (const [name, expected] of [['NotAllowedError', { state: 'denied' }], ['NotFoundError', { state: 'failed', failure: 'no_microphone' }], ['NotReadableError', { state: 'failed', failure: 'in_use' }], ['Weird', { state: 'failed', failure: 'recorder' }]] as const) {
      const built = build({ refuse: { name } })
      await built.recorder.start()
      expect(built.states.at(-1), name).toEqual(expected)
    }
  })

  it('says when the recording came out empty, and when the browser\'s recorder failed', async () => {
    const empty = build({ empty: true })
    await empty.recorder.start()
    empty.recorder.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(empty.states.at(-1)).toEqual({ state: 'failed', failure: 'empty' })
    expect(empty.blobs).toHaveLength(0)

    const broken = build()
    await broken.recorder.start()
    broken.recorders[0]?.fails()
    expect(broken.states.at(-1)).toEqual({ state: 'failed', failure: 'recorder' })
    expect(broken.tracks[0]?.stopped).toBe(1)
  })

  it('discards a recording in progress, letting the microphone go, and ignores what the old recorder says afterwards', async () => {
    const built = build()
    await built.recorder.start()
    built.recorder.discard()
    expect(built.states.at(-1)).toEqual({ state: 'idle' })
    expect(built.tracks[0]?.stopped).toBe(1)
    built.recorders[0]?.stop()
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(built.blobs).toHaveLength(0)
    expect(built.seconds).toEqual([])
  })
})
