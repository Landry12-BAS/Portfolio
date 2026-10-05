// Tests of LB-09's whole board, mounted against the fake site: a curated meeting run live from the
// picker through the stages to its transcript, items and exports, a replay from a recording with no
// request, the recorder's explanation before any permission is asked and its states when the browser
// cannot record or the visitor says no, the mode choice, the day's recordings used up, Czech, and
// the Brief reading.
import { recordingSchema } from '@lb/contracts'
import { flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Lb09Board from '~/boards/lb-09/Lb09Board.vue'
import { useReadingStore } from '~/stores/reading'

import { recordLb09Sample } from '../support/lb09-recording'
import { FakeLb09Site, NOW, SESSION } from '../support/lb09-site'
import type { FakeLb09Options } from '../support/lb09-site'
import { mountWithSite } from '../support/mount'

/** Mounts the board against a fake site (a new one, or one a test has set the scene on) and waits for what it reads when it opens. */
async function openBoard(options: FakeLb09Options & { locale?: 'en' | 'cs', brief?: boolean, site?: FakeLb09Site } = {}) {
  const { locale, brief, site: given, ...siteOptions } = options
  const site = given ?? new FakeLb09Site({ verified: true, ...siteOptions })
  vi.stubGlobal('fetch', site.fetch)
  vi.stubGlobal('WebSocket', site.socketClass())
  vi.stubGlobal('location', new URL('http://site.test/'))
  const wrapper = mountWithSite(Lb09Board, { locale, props: { permalinkFor: (id: string) => `/runs/${id}`, now: NOW } })
  if (brief) useReadingStore().mode = 'brief'
  await flushPromises()
  await vi.advanceTimersByTimeAsync(0)
  return { site, wrapper }
}

/** Lets time pass with the board's timers running. */
async function pass(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}

/** Bytes that start like a WebM file and weigh three seconds of the mock's reckoning (16,000 bytes a second). */
function webmBytes(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(48_000))
  bytes.set([0x1A, 0x45, 0xDF, 0xA3])
  return bytes
}

/** Opens the recorder side of the board. */
async function openRecorder(wrapper: VueWrapper): Promise<void> {
  await wrapper.findAll('.choices .lb-seg__btn')[1]?.trigger('click')
  await flushPromises()
}

/** Has the audio element say it can be sought anywhere in its minute, as a browser does once the audio is loaded. */
function makeSeekable(audio: HTMLAudioElement): void {
  Object.defineProperty(audio, 'readyState', { value: 4, configurable: true })
  Object.defineProperty(audio, 'seekable', { value: { length: 1, start: () => 0, end: () => 60 }, configurable: true })
}

/** An Audio element the recorder asks for a file's length, which says the length it was given. */
function audioOfLength(seconds: number) {
  return class {
    duration = seconds
    preload = ''
    readonly #listeners: Record<string, (() => void)[]> = {}
    /** Subscribes. */
    addEventListener(type: string, listener: () => void) {
      (this.#listeners[type] ??= []).push(listener)
    }

    /** Lets go of the source. */
    removeAttribute() {
      return undefined
    }

    /** Starts loading: the metadata arrives a moment later. */
    set src(_value: string) {
      void Promise.resolve().then(() => {
        for (const listener of this.#listeners.loadedmetadata ?? []) listener()
      })
    }
  }
}

/** Chooses a file in the recorder's picker. */
async function chooseFile(wrapper: VueWrapper, file: File): Promise<void> {
  const input = wrapper.get('[data-testid="file-input"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await flushPromises()
}

/** Bytes that start like a WAV file. */
function wavBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(size))
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
  return bytes
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the board', () => {
  it('opens on the curated meetings with the day counted, and runs one live to its result', async () => {
    const { site, wrapper } = await openBoard()
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('5 of 5')
    expect(wrapper.findAll('[data-testid="sample-picker"] input[type="radio"]')).toHaveLength(3)
    expect(wrapper.get('[data-testid="sample-facts"]').text()).toContain('Speakers: 4')
    expect(wrapper.get('[data-testid="mode-note"]').text()).toContain('Fast mode')

    await wrapper.get('[data-testid="run-sample"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="progress"]').attributes('data-status')).toBe('received')
    expect(wrapper.get('[data-testid="progress-queued"]').text()).toContain('waits for the worker')
    expect(wrapper.get('[data-testid="announcement"]').text()).toContain('waits for the worker')
    expect(wrapper.get('[data-testid="playback"]').text()).toContain('The sample meeting')
    expect(wrapper.get('[data-testid="audio-player"]').attributes('data-source')).toBe('/lb09/monday-roasting-plan.mp3')
    await pass(2 * 700 + 50)
    expect(wrapper.get('[data-testid="progress-feed"]').text()).toContain('WebSocket')
    expect(wrapper.find('[data-stage="decoding"]').attributes('data-mark')).toBe('done')
    expect(wrapper.find('[data-stage="transcribing"]').attributes('data-mark')).toBe('running')
    // Each stage is said in words, to the eye and to a screen reader, never by a colour alone.
    expect(wrapper.get('[data-stage="transcribing"]').text()).toContain('running')
    expect(wrapper.get('[data-stage="transcribing"]').text()).toContain('through the AI gateway')
    expect(wrapper.get('[data-stage="transcribing"]').attributes('aria-current')).toBe('step')
    expect(wrapper.get('[data-testid="announcement"]').text()).toBe('Transcribe: running')
    await pass(7 * 700)
    expect(wrapper.get('[data-testid="announcement"]').text()).toBe('The meeting is done')
    expect(wrapper.findAll('[data-testid="decisions"] li')).toHaveLength(2)
    expect(wrapper.findAll('[data-testid="actions"] li')).toHaveLength(3)
    expect(wrapper.get('[data-testid="transcript"]').text()).toContain('inferred from the words')
    expect(wrapper.findAll('[data-testid="transcript"] li').length).toBeGreaterThan(3)
    expect(wrapper.get('[data-testid="facts"] [data-fact="transcriber"]').text()).toBe('lb-stt')
    expect(wrapper.get('[data-testid="facts"] [data-fact="audio"]').text()).toContain('Deleted')
    expect((wrapper.get('[data-testid="export-content"]').element as HTMLTextAreaElement).value).toContain('Speaker labels are inferred from the words')
    expect(wrapper.get('[data-testid="export-lb08"] a').attributes('href')).toBe('/systems/lb-08/board')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('4 of 5')
    expect(site.callsTo('/api/lb09/meetings', 'POST')).toHaveLength(1)
  })

  it('gives the keyboard\'s focus to the progress when the run button it was on is switched off, and to the result when the meeting is done', async () => {
    const { wrapper } = await openBoard()
    const run = wrapper.get('[data-testid="run-sample"]').element as HTMLButtonElement
    run.focus()
    await wrapper.get('[data-testid="run-sample"]').trigger('click')
    await pass(2 * 700)
    expect(run.disabled).toBe(true)
    expect(document.activeElement?.id).toBe('lb09-progress-title')
    await pass(8 * 700)
    expect(wrapper.find('[data-testid="progress"]').exists()).toBe(false)
    expect(document.activeElement?.id).toBe('lb09-items-title')
  })

  it('leaves the keyboard\'s focus where the visitor put it while a meeting runs', async () => {
    const { wrapper } = await openBoard()
    await wrapper.get('[data-testid="run-sample"]').trigger('click')
    await pass(2 * 700)
    const privateMode = wrapper.findAll('.mode .lb-seg__btn')[1]?.element as HTMLButtonElement
    privateMode.focus()
    await pass(8 * 700)
    expect(wrapper.find('[data-testid="items"]').exists()).toBe(true)
    expect(document.activeElement).toBe(privateMode)
  })

  it('jumps the player to an item\'s evidence when the item is clicked, and marks the segment being heard', async () => {
    const { wrapper } = await openBoard()
    await wrapper.get('[data-testid="run-sample"]').trigger('click')
    await pass(9 * 700 + 100)
    const audio = wrapper.get('[data-testid="audio-player"]').element as HTMLAudioElement
    makeSeekable(audio)
    const play = vi.fn(() => Promise.resolve())
    Object.defineProperty(audio, 'play', { value: play, configurable: true })
    await wrapper.get('[data-testid="actions"] li button').trigger('click')
    // The first action, the order of bags, is said in turn 4 of the committed audio, from 20.1 s.
    expect(audio.currentTime).toBeCloseTo(20.1, 0)
    expect(play).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="transcript"] [aria-current="true"]').text()).toContain('order two thousand')
    const firstSegment = wrapper.get('[data-testid="transcript"] li button')
    await firstSegment.trigger('click')
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('makes a jump asked for before the audio can be sought as soon as it can, rather than starting from the beginning', async () => {
    const { wrapper } = await openBoard()
    await wrapper.get('[data-testid="run-sample"]').trigger('click')
    await pass(9 * 700 + 100)
    const audio = wrapper.get('[data-testid="audio-player"]').element as HTMLAudioElement
    const play = vi.fn(() => Promise.resolve())
    Object.defineProperty(audio, 'play', { value: play, configurable: true })
    await wrapper.get('[data-testid="actions"] li button').trigger('click')
    // Nothing is sought or played while the browser cannot seek; the transcript already marks the target.
    expect(audio.currentTime).toBe(0)
    expect(play).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="transcript"] [aria-current="true"]').text()).toContain('order two thousand')
    makeSeekable(audio)
    audio.dispatchEvent(new Event('loadedmetadata'))
    expect(audio.currentTime).toBeCloseTo(20.1, 0)
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('plays a sample\'s file from the page\'s memory, so it can be sought on a server that does not answer byte ranges', async () => {
    const site = new FakeLb09Site({ verified: true })
    const audioFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input), 'http://site.test')
      if (url.pathname.startsWith('/lb09/')) return new Response(new Uint8Array([0xFF, 0xFB, 0x90, 0x00]), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
      return site.fetch(input, init)
    }
    vi.stubGlobal('fetch', audioFetch)
    vi.stubGlobal('WebSocket', site.socketClass())
    vi.stubGlobal('location', new URL('http://site.test/'))
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:site.test/sample', revokeObjectURL: vi.fn() }))
    const wrapper = mountWithSite(Lb09Board, { props: { permalinkFor: (id: string) => `/runs/${id}`, now: NOW } })
    await flushPromises()
    await wrapper.get('[data-testid="run-sample"]').trigger('click')
    await flushPromises()
    const player = wrapper.get('[data-testid="playback"] [data-testid="audio-player"]')
    expect(player.attributes('data-source')).toBe('/lb09/monday-roasting-plan.mp3')
    expect(player.attributes('src')).toBe('blob:site.test/sample')
  })

  it('runs private mode when the visitor chooses it', async () => {
    const { site, wrapper } = await openBoard()
    await wrapper.findAll('.mode .lb-seg__btn')[1]?.trigger('click')
    expect(wrapper.get('[data-testid="mode-note"]').text()).toContain('faster-whisper')
    await wrapper.get('[data-testid="run-sample"]').trigger('click')
    await flushPromises()
    expect((site.callsTo('/api/lb09/meetings', 'POST')[0]?.body as { mode: string }).mode).toBe('private')
    await pass(9 * 700 + 100)
    expect(wrapper.get('[data-testid="facts"] [data-fact="mode"]').text()).toContain('Private')
    expect(wrapper.get('[data-testid="facts"] [data-fact="transcriber"]').text()).toContain('faster-whisper')
  })

  it('replays a recorded meeting without a request, labelled as a replay', async () => {
    const recording = recordingSchema.parse(recordLb09Sample({ sample: 'weekend-staffing' }))
    const { site, wrapper } = await openBoard({ recordings: [recording] })
    await wrapper.findAll('[data-testid="sample-picker"] input[type="radio"]')[1]?.setValue(true)
    await flushPromises()
    const before = site.calls.length
    await wrapper.get('[data-testid="replay-sample"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="replay-banner"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="progress"]').text()).toContain('Replaying')
    await pass(30_000)
    expect(wrapper.findAll('[data-testid="actions"] li')).toHaveLength(1)
    expect(wrapper.get('[data-testid="no-decisions"]').text()).toContain('No decision')
    expect(site.calls.slice(before).filter(call => call.path.startsWith('/api/lb09/'))).toEqual([])
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('5 of 5')
  })

  it('says a meeting has no recording and offers only the live run', async () => {
    const { wrapper } = await openBoard({ recordings: [] })
    await wrapper.findAll('[data-testid="sample-picker"] input[type="radio"]')[2]?.setValue(true)
    await flushPromises()
    expect(wrapper.find('[data-testid="sample-no-recording"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="replay-sample"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="run-sample"]').exists()).toBe(true)
  })

  it('shows the worker\'s failure with its reason', async () => {
    const { site, wrapper } = await openBoard()
    site.lb09.failNext('undecodable')
    await wrapper.get('[data-testid="run-sample"]').trigger('click')
    await pass(9 * 700 + 100)
    expect(wrapper.get('[data-testid="progress"]').attributes('data-status')).toBe('failed')
    expect(wrapper.get('[data-testid="progress-failure"]').text()).toContain('could not be decoded')
    expect(wrapper.find('[data-stage="decoding"]').attributes('data-mark')).toBe('failed')
    expect(wrapper.find('[data-testid="transcript"]').exists()).toBe(false)
    // A recording the decoder refused was the visitor's to send, and still counts.
    expect(wrapper.find('[data-testid="progress-given-back"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('4 of 5')
  })

  it('marks the stage a meeting failed in even when it only read the meeting now and then, and gives the day back for a failure of its own', async () => {
    const { site, wrapper } = await openBoard()
    site.refuseConnections = true
    site.lb09.failNext('model')
    await wrapper.get('[data-testid="run-sample"]').trigger('click')
    // The board reads the meeting every second and a half, so it does not see the labelling begin before the failure.
    await pass(9 * 700 + 2_000)
    expect(wrapper.get('[data-testid="progress"]').attributes('data-status')).toBe('failed')
    expect(wrapper.find('[data-stage="decoding"]').attributes('data-mark')).toBe('done')
    expect(wrapper.find('[data-stage="transcribing"]').attributes('data-mark')).toBe('done')
    expect(wrapper.find('[data-stage="labelling"]').attributes('data-mark')).toBe('failed')
    expect(wrapper.find('[data-stage="extracting"]').attributes('data-mark')).toBe('waiting')
    // The service fails a meeting this way when the models are out of reach as well as when their answers will not do.
    expect(wrapper.get('[data-testid="progress-failure"]').text()).toContain('could not be reached')
    expect(wrapper.get('[data-testid="progress-given-back"]').text()).toContain('does not count')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('5 of 5')
    expect(wrapper.get('[data-testid="facts"] [data-fact="calls"]').text()).toBe('2')
    expect(wrapper.get('[data-testid="facts"] [data-fact="transcriber"]').text()).toBe('lb-stt')
  })

  it('lists the visitor\'s meetings, and opens one again after the page was reloaded', async () => {
    const site = new FakeLb09Site({ verified: true })
    site.lb09.start(SESSION, { source: 'sample', sample: 'weekend-staffing', mode: 'private', language: 'en' })
    const { wrapper } = await openBoard({ site })
    const rows = wrapper.findAll('[data-testid="my-meeting"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text()).toContain('Weekend staffing')
    expect(rows[0]?.text()).toContain('Private mode')
    await wrapper.get('[data-testid="open-meeting"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="progress"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="my-meetings"]').text()).toContain('On the board now')
    await pass(9 * 700 + 100)
    expect(wrapper.findAll('[data-testid="actions"] li')).toHaveLength(1)
    expect(wrapper.get('[data-testid="audio-player"]').attributes('data-source')).toBe('/lb09/weekend-staffing.mp3')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('4 of 5')
    expect(site.callsTo('/api/lb09/meetings', 'POST')).toHaveLength(0)
  })

  it('says a reopened recording of the visitor\'s own cannot be played, and still shows its result', async () => {
    const site = new FakeLb09Site({ verified: true })
    site.lb09.start(SESSION, { source: 'upload', audio: Buffer.from(webmBytes()).toString('base64'), mode: 'fast' })
    vi.setSystemTime(NOW + 60_000)
    const { wrapper } = await openBoard({ site })
    await wrapper.get('[data-testid="open-meeting"]').trigger('click')
    await pass(100)
    expect(wrapper.findAll('[data-testid="actions"] li')).toHaveLength(1)
    expect(wrapper.find('[data-testid="playback"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="audio-gone"]').text()).toContain('deleted it once it was transcribed')
  })

  it('turns live runs off when the day\'s recordings are used up', async () => {
    const site = new FakeLb09Site({ verified: true })
    for (let count = 0; count < 5; count += 1) site.lb09.start(SESSION, { source: 'sample', sample: 'weekend-staffing', mode: 'fast', language: 'en' })
    vi.stubGlobal('fetch', site.fetch)
    vi.stubGlobal('WebSocket', site.socketClass())
    vi.stubGlobal('location', new URL('http://site.test/'))
    const wrapper = mountWithSite(Lb09Board, { props: { permalinkFor: (id: string) => `/runs/${id}`, now: NOW } })
    await flushPromises()
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('0 of 5')
    expect(wrapper.find('[data-testid="sample-no-allowance"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="run-sample"]').attributes('disabled')).toBeDefined()
  })
})

describe('the recorder', () => {
  it('explains before asking, and says when the browser cannot record', async () => {
    const { wrapper } = await openBoard()
    await openRecorder(wrapper)
    const panel = wrapper.get('[data-testid="recorder"]')
    expect(panel.text()).toContain('the browser asks you for the microphone')
    expect(panel.text()).toContain('transcribed and deleted')
    expect(wrapper.find('[data-testid="recorder-live"]').exists()).toBe(false)
    await wrapper.get('[data-testid="record"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="recorder-unsupported"]').text()).toContain('cannot record')
  })

  it('says when the visitor refused the microphone, and how to allow it', async () => {
    const { wrapper } = await openBoard()
    const refusal = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true })
    vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia: () => Promise.reject(refusal) } })
    await openRecorder(wrapper)
    await wrapper.get('[data-testid="record"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="recorder-announcement"]').text()).toBe('')
    expect(wrapper.get('[data-testid="recorder-denied"]').text()).toContain('address bar')
    expect(wrapper.find('[data-testid="recorder-made"]').exists()).toBe(false)
  })

  /** Stubs a microphone the page can record from, through a MediaRecorder that hands over three seconds of WebM bytes when stopped. */
  function fakeMicrophone() {
    const tracks = [{ stop: vi.fn() }]
    const listeners: Record<string, ((event?: unknown) => void)[]> = {}
    /** A MediaRecorder that hands over three seconds' worth of WebM bytes when stopped. */
    class FakeMediaRecorder {
      mimeType = 'audio/webm;codecs=opus'
      /** Every format is supported. */
      static isTypeSupported() {
        return true
      }

      /** Subscribes. */
      addEventListener(type: string, listener: (event?: unknown) => void) {
        (listeners[type] ??= []).push(listener)
      }

      /** Starts; the stand-in has nothing to start. */
      start() {
        return undefined
      }

      /** Stops: hands over a WebM chunk and the stop event. */
      stop() {
        for (const listener of listeners.dataavailable ?? []) listener({ data: new Blob([webmBytes()], { type: this.mimeType }) })
        for (const listener of listeners.stop ?? []) listener()
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => tracks }) } })
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:site.test/recording', revokeObjectURL: vi.fn() }))
    return { tracks }
  }

  it('keeps the keyboard\'s focus on the one button that records and stops, and gives it back when a recording is discarded', async () => {
    const { wrapper } = await openBoard()
    fakeMicrophone()
    await openRecorder(wrapper)
    const button = wrapper.get('[data-testid="record"]').element as HTMLButtonElement
    button.focus()
    await wrapper.get('[data-testid="record"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="stop-recording"]').element).toBe(button)
    expect(document.activeElement).toBe(button)
    await pass(2_000)
    await wrapper.get('[data-testid="stop-recording"]').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(button)
    expect(button.textContent?.trim()).toBe('Record again')
    const discard = wrapper.get('[data-testid="discard-recording"]')
    ;(discard.element as HTMLButtonElement).focus()
    await discard.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="recorder-made"]').exists()).toBe(false)
    expect(document.activeElement).toBe(button)
    expect(button.textContent?.trim()).toBe('Record')
  })

  it('leaves the level meter out for a visitor who prefers reduced motion, and keeps the countdown', async () => {
    const { wrapper } = await openBoard()
    fakeMicrophone()
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
    await openRecorder(wrapper)
    await wrapper.get('[data-testid="record"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="recorder-live"]').text()).toContain('60 s left of 60')
    expect(wrapper.find('[data-testid="level-meter"]').exists()).toBe(false)
  })

  it('records, counts down, offers to listen back, and sends the recording as the visitor\'s own', async () => {
    const { site, wrapper } = await openBoard()
    const { tracks } = fakeMicrophone()
    await openRecorder(wrapper)
    await wrapper.get('[data-testid="record"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="recorder-live"]').text()).toContain('60 s left of 60')
    expect(wrapper.find('[data-testid="level-meter"]').exists()).toBe(true)
    await pass(3_000)
    expect(wrapper.get('[data-testid="recorder-live"]').text()).toContain('57 s left of 60')
    await wrapper.get('[data-testid="stop-recording"]').trigger('click')
    await flushPromises()
    expect(tracks[0]?.stop).toHaveBeenCalled()
    expect(wrapper.get('[data-testid="recorder-made"] [data-testid="audio-player"]').attributes('src')).toBe('blob:site.test/recording')
    await wrapper.get('[data-testid="send-recording"]').trigger('click')
    await flushPromises()
    const sent = site.callsTo('/api/lb09/meetings', 'POST')[0]?.body as { source: string, audio: string, language?: string }
    expect(sent.source).toBe('upload')
    expect(sent.audio.startsWith('GkXfo')).toBe(true)
    expect(sent.language).toBeUndefined()
    expect(wrapper.get('[data-testid="playback"]').text()).toContain('Your recording')
    await pass(9 * 700 + 100)
    expect(wrapper.findAll('[data-testid="actions"] li')).toHaveLength(1)
    expect(wrapper.get('[data-testid="facts"] [data-fact="mode"]').text()).toContain('Fast')
  })
})

describe('a file of the visitor\'s own', () => {
  /** Stubs the browser pieces a chosen file needs: object URLs, and the length the browser reads from it. */
  function browserFor(seconds: number): void {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:site.test/file', revokeObjectURL: vi.fn() }))
    vi.stubGlobal('Audio', audioOfLength(seconds))
  }

  it('is checked, offered to listen back, and sent as the visitor\'s own recording, without the page\'s language', async () => {
    const { site, wrapper } = await openBoard({ locale: 'cs' })
    browserFor(41)
    await openRecorder(wrapper)
    await chooseFile(wrapper, new File([wavBytes(64_000)], 'porada.wav', { type: 'audio/wav' }))
    expect(wrapper.get('[data-testid="file-chosen"]').text()).toContain('porada.wav, 41 sekund')
    expect(wrapper.get('[data-testid="recorder-made"] [data-testid="audio-player"]').attributes('src')).toBe('blob:site.test/file')
    await wrapper.get('[data-testid="send-recording"]').trigger('click')
    await flushPromises()
    const sent = site.callsTo('/api/lb09/meetings', 'POST')[0]?.body as { source: string, audio: string, language?: string }
    expect(sent.source).toBe('upload')
    expect(sent.audio.startsWith('UklGR')).toBe(true)
    expect(sent.language).toBeUndefined()
  })

  it('stays in the picker, which says so, until it is sent or discarded, and leaves the button saying record rather than record again', async () => {
    const { wrapper } = await openBoard()
    browserFor(20)
    await openRecorder(wrapper)
    const input = wrapper.get('[data-testid="file-input"]').element as HTMLInputElement
    const emptied: string[] = []
    Object.defineProperty(input, 'value', { get: () => '', set: (value: string) => emptied.push(value), configurable: true })
    await chooseFile(wrapper, new File([wavBytes(64_000)], 'stand-up.wav', { type: 'audio/wav' }))
    expect(wrapper.get('[data-testid="file-chosen"]').text()).toContain('stand-up.wav')
    expect(emptied).toEqual([])
    expect(wrapper.get('[data-testid="record"]').text()).toBe('Record')
    await wrapper.get('[data-testid="discard-recording"]').trigger('click')
    await flushPromises()
    expect(emptied).toEqual([''])
    expect(wrapper.find('[data-testid="file-chosen"]').exists()).toBe(false)
  })

  it('is refused before it is sent when it is too big, not audio, or longer than a minute, and nothing is spent', async () => {
    const { site, wrapper } = await openBoard()
    browserFor(75)
    await openRecorder(wrapper)
    await chooseFile(wrapper, new File([new Uint8Array(3 * 1024 * 1024 + 1)], 'big.wav', { type: 'audio/wav' }))
    expect(wrapper.get('[data-testid="file-problem"]').attributes('data-problem')).toBe('too_big')
    // The picker says it holds a file that will not do, and why, to a screen reader as well.
    expect(wrapper.get('[data-testid="file-input"]').attributes('aria-invalid')).toBe('true')
    expect(wrapper.get('[data-testid="file-input"]').attributes('aria-describedby')).toContain('lb09-file-problem')
    await chooseFile(wrapper, new File(['<html>not audio</html>'], 'page.mp3', { type: 'audio/mpeg' }))
    expect(wrapper.get('[data-testid="file-problem"]').attributes('data-problem')).toBe('unreadable')
    await chooseFile(wrapper, new File([wavBytes(64_000)], 'long.wav', { type: 'audio/wav' }))
    expect(wrapper.get('[data-testid="file-problem"]').text()).toContain('75 seconds')
    expect(wrapper.find('[data-testid="recorder-made"]').exists()).toBe(false)
    expect(site.callsTo('/api/lb09/meetings', 'POST')).toHaveLength(0)
  })
})

describe('other readings', () => {
  it('speaks Czech', async () => {
    const { wrapper } = await openBoard({ locale: 'cs' })
    expect(wrapper.text()).toContain('Vyberte poradu')
    expect(wrapper.get('[data-testid="sample-facts"]').text()).toContain('Mluvčí: 4')
    await openRecorder(wrapper)
    expect(wrapper.get('[data-testid="record"]').text()).toBe('Nahrát')
  })

  it('names the language heard and writes the length as Czech does', async () => {
    const { wrapper } = await openBoard({ locale: 'cs' })
    await wrapper.get('[data-testid="run-sample"]').trigger('click')
    await pass(9 * 700 + 100)
    expect(wrapper.get('[data-testid="facts"] [data-fact="language"]').text()).toBe('Angličtina')
    expect(wrapper.get('[data-testid="facts"] [data-fact="duration"]').text()).toBe('41,1 s')
  })

  it('keeps the Brief reading to the essentials: no export panel, the facts cut down', async () => {
    const { wrapper } = await openBoard({ brief: true })
    await wrapper.get('[data-testid="run-sample"]').trigger('click')
    await pass(9 * 700 + 100)
    expect(wrapper.find('[data-testid="export"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="facts"] [data-fact="mode"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="facts"] [data-fact="calls"]').exists()).toBe(false)
  })
})
