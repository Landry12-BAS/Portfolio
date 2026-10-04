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

/** Mounts the board against a fake site and waits for what it reads when it opens. */
async function openBoard(options: FakeLb09Options & { locale?: 'en' | 'cs', brief?: boolean } = {}) {
  const { locale, brief, ...siteOptions } = options
  const site = new FakeLb09Site({ verified: true, ...siteOptions })
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
    expect(wrapper.get('[data-testid="playback"]').text()).toContain('The sample meeting')
    expect(wrapper.get('[data-testid="audio-player"]').attributes('src')).toBe('/lb09/monday-roasting-plan.mp3')
    await pass(2 * 700 + 50)
    expect(wrapper.get('[data-testid="progress-feed"]').text()).toContain('WebSocket')
    expect(wrapper.find('[data-stage="decoding"]').attributes('data-mark')).toBe('done')
    expect(wrapper.find('[data-stage="transcribing"]').attributes('data-mark')).toBe('running')
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

  it('jumps the player to an item\'s evidence when the item is clicked', async () => {
    const { wrapper } = await openBoard()
    await wrapper.get('[data-testid="run-sample"]').trigger('click')
    await pass(9 * 700 + 100)
    const audio = wrapper.get('[data-testid="audio-player"]').element as HTMLAudioElement
    const play = vi.fn(() => Promise.resolve())
    Object.defineProperty(audio, 'play', { value: play, configurable: true })
    await wrapper.get('[data-testid="actions"] li button').trigger('click')
    expect(audio.currentTime).toBeGreaterThan(0)
    expect(play).toHaveBeenCalledTimes(1)
    const firstSegment = wrapper.get('[data-testid="transcript"] li button')
    await firstSegment.trigger('click')
    expect(play).toHaveBeenCalledTimes(1)
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

  it('records, counts down, offers to listen back, and sends the recording as the visitor\'s own', async () => {
    const { site, wrapper } = await openBoard()
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
    await openRecorder(wrapper)
    await wrapper.get('[data-testid="record"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="recorder-live"]').text()).toContain('60 s left of 60')
    await pass(3_000)
    expect(wrapper.get('[data-testid="recorder-live"]').text()).toContain('57 s left of 60')
    await wrapper.get('[data-testid="stop-recording"]').trigger('click')
    await flushPromises()
    expect(tracks[0]?.stop).toHaveBeenCalled()
    expect(wrapper.get('[data-testid="recorder-made"] [data-testid="audio-player"]').attributes('src')).toBe('blob:site.test/recording')
    await wrapper.get('[data-testid="send-recording"]').trigger('click')
    await flushPromises()
    const sent = site.callsTo('/api/lb09/meetings', 'POST')[0]?.body as { source: string, audio: string }
    expect(sent.source).toBe('upload')
    expect(sent.audio.startsWith('GkXfo')).toBe(true)
    expect(wrapper.get('[data-testid="playback"]').text()).toContain('Your recording')
    await pass(9 * 700 + 100)
    expect(wrapper.findAll('[data-testid="actions"] li')).toHaveLength(1)
    expect(wrapper.get('[data-testid="facts"] [data-fact="mode"]').text()).toContain('Fast')
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

  it('keeps the Brief reading to the essentials: no export panel, the facts cut down', async () => {
    const { wrapper } = await openBoard({ brief: true })
    await wrapper.get('[data-testid="run-sample"]').trigger('click')
    await pass(9 * 700 + 100)
    expect(wrapper.find('[data-testid="export"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="facts"] [data-fact="mode"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="facts"] [data-fact="calls"]').exists()).toBe(false)
  })
})
