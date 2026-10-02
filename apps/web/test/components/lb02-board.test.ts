// Tests of LB-02's whole board, mounted against the fake site and the mock back end's conversation hub
// (no port is opened): the board as a visitor first finds it, a curated sample run live message by
// message to a recorded booking, the visitor's own conversation, a second visitor changing the calendar
// while the first watches, a handoff to a person, a connection that closes and is picked up again, the
// Brief reading, a deployment with no back end, and Czech.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { recordingSchema } from '@lb/contracts'
import type { Recording } from '@lb/contracts'
import { flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LB02_SAMPLES } from '#shared/data/samples/lb02'

import Lb02Board from '~/boards/lb-02/Lb02Board.vue'
import { useReadingStore } from '~/stores/reading'
import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'

import { FakeLb02Site, NOW } from '../support/lb02-site'
import type { FakeLb02Options } from '../support/lb02-site'
import { mountWithSite } from '../support/mount'

/** A map standing in for the tab's session storage. */
class MemoryStorage {
  readonly items = new Map<string, string>()
  /** Reads an item. */
  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }

  /** Keeps an item. */
  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }

  /** Forgets an item. */
  removeItem(key: string): void {
    this.items.delete(key)
  }
}

/** Reads one of the recordings the recorder made on the mock (scripts/record-fixtures.ts). */
function recordingOf(sample: string): Recording {
  // Tests run from the app's own folder (`pnpm test`), where the fixtures are.
  const file = join(process.cwd(), 'e2e/fixtures/recordings/lb-02', `${sample}.json`)
  return recordingSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
}

/** Mounts the board against a fake site and waits for what it reads when it opens. */
async function openBoard(options: FakeLb02Options & { locale?: 'en' | 'cs', brief?: boolean } = {}) {
  const { locale, brief, ...siteOptions } = options
  const site = new FakeLb02Site(siteOptions)
  const storage = new MemoryStorage()
  vi.stubGlobal('fetch', site.fetch)
  vi.stubGlobal('WebSocket', site.socketClass())
  vi.stubGlobal('location', new URL('http://site.test/'))
  vi.stubGlobal('sessionStorage', storage)
  const wrapper = mountWithSite(Lb02Board, { locale, props: { permalinkFor: (id: string) => `/runs/${id}`, now: NOW } })
  if (brief) useReadingStore().mode = 'brief'
  await settle()
  return { site, wrapper, storage }
}

/** Lets the pending promises and zero-length timers run, a few times over, as the page's chains of calls need. */
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
  }
}

/** Lets a number of seconds pass, with the board's timers running. */
async function seconds(count: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(count * 1_000)
  await flushPromises()
}

/** Chooses a sample in the picker. */
async function chooseSample(wrapper: VueWrapper, id: string): Promise<void> {
  await wrapper.get(`input[name="sample"][value="${id}"]`).setValue(true)
}

/** Starts the chosen sample, which runs live because the fake site has no recordings. */
async function runChosenSample(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('[data-testid="start-sample"]').trigger('click')
  await settle()
}

/** Writes a message in the field and sends it with Enter. */
async function say(wrapper: VueWrapper, text: string): Promise<void> {
  const field = wrapper.get('[data-testid="composer-field"]')
  await field.setValue(text)
  await field.trigger('keydown', { key: 'Enter' })
  await settle()
}

/** The texts of the chat's lines, by kind. */
function lines(wrapper: VueWrapper, kind: 'visitor' | 'concierge' | 'action') {
  return wrapper.findAll(`[data-testid="line-${kind}"]`)
}

describe('LB-02\'s board', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('opens on the datasheet\'s part, as a live board, with its limits, the five samples and the calendar, and nothing started', async () => {
    const { wrapper, site } = await openBoard()
    expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Live')
    expect(wrapper.text()).toContain('LB-02')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('10 of 10')
    expect(wrapper.findAll('input[name="sample"]')).toHaveLength(5)
    expect(wrapper.findAll('input[type="radio"][data-testid^="day-"]')).toHaveLength(14)
    expect(wrapper.get('[data-testid="connection"]').text()).toBe(en.lb02.phone.status.idle)
    expect(wrapper.get('[data-testid="composer-hint"]').text()).toBe(en.lb02.composer.notStarted)
    expect(wrapper.get('[data-testid="messages-count"]').text()).toBe('30 of 30')
    expect(wrapper.findAll('tbody tr').length).toBeGreaterThan(0)
    expect(site.calls.filter(call => call.method !== 'GET')).toEqual([])
    expect(site.sockets).toHaveLength(0)
  })

  it('shows the limits the datasheet lists, including the thirty messages and the five-minute hold', async () => {
    const { wrapper } = await openBoard()
    const table = wrapper.get('aside').text()
    expect(table).toMatch(/30/)
    expect(table).toMatch(/5 min/i)
  })

  describe('a sample run live', () => {
    it('sends the first message by itself, then one at a time, to a hold and a recorded booking', async () => {
      const { wrapper } = await openBoard()
      await runChosenSample(wrapper)

      expect(wrapper.get('[data-testid="connection"]').text()).toBe(en.lb02.phone.status.open)
      expect(wrapper.get('[data-testid="script-progress"]').text()).toBe('Message 1 of 3 sent')
      expect(lines(wrapper, 'visitor')).toHaveLength(1)
      expect(lines(wrapper, 'concierge')).toHaveLength(1)

      await wrapper.get('[data-testid="script-next"]').trigger('click')
      await settle()
      expect(wrapper.get('[data-testid="booking-status"]').text()).toContain('Cupping session')
      expect(wrapper.get('[data-testid="hold-timer"]').text()).toContain('left')
      const receipts = wrapper.findAll('[data-testid="receipt"]').map(receipt => receipt.text())
      expect(receipts).toEqual([`${en.lb02.chat.receipt}: ${en.lb02.chat.receipts.hold_placed}`])
      const held = wrapper.findAll('[data-testid="slots"] [data-state="held"]')
      expect(held).toHaveLength(1)
      expect(held[0]?.text()).toContain(en.lb02.calendar.status.heldMine)

      await wrapper.get('[data-testid="script-next"]').trigger('click')
      await settle()
      expect(wrapper.get('[data-testid="booking-code"]').text()).toMatch(/^BB-/)
      expect(wrapper.get('[data-testid="script-finished"]').text()).toBe(en.lb02.script.finished)
      expect(wrapper.find('[data-testid="hold-timer"]').exists()).toBe(false)
      expect(wrapper.findAll('[data-testid="slots"] [data-state="booked"]').some(row => row.text().includes(en.lb02.calendar.status.bookedMine))).toBe(true)
      expect(wrapper.get('[data-testid="messages-count"]').text()).toBe('27 of 30')
      expect(wrapper.get('[data-testid="step"]').text()).toBe(en.lb02.facts.steps.done)
    })

    it('shows the confirmation email as recorded and never sent, to the address the visitor gave', async () => {
      const { wrapper } = await openBoard()
      await runChosenSample(wrapper)
      await wrapper.get('[data-testid="script-all"]').trigger('click')
      await seconds(5)
      await settle()
      expect(wrapper.get('[data-testid="email-badge"]').text()).toBe(en.lb02.email.badge)
      expect(wrapper.get('[data-testid="email-to"]').text()).toBe('jana@example.test')
      expect(wrapper.get('[data-testid="email-body"]').text()).toContain('never sent')
      expect(wrapper.get('[data-testid="booking-status"] a').attributes('href')).toBe('#lb02-email')
    })

    it('puts the keyboard in the message field once the conversation is open', async () => {
      const { wrapper } = await openBoard()
      await runChosenSample(wrapper)
      expect(document.activeElement).toBe(wrapper.get('[data-testid="composer-field"]').element)
    })

    it('runs the double-booking sample to a refusal, and never shows the taken slot as free or held', async () => {
      const { wrapper, site } = await openBoard()
      site.lb02.otherVisitor('books', 'tasting', 1, '12:00')
      await chooseSample(wrapper, 'double-book-taken-slot-en')
      await runChosenSample(wrapper)
      await wrapper.get('[data-testid="script-next"]').trigger('click')
      await settle()
      expect(wrapper.find('[data-testid="hold-timer"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="booking-code"]').exists()).toBe(false)
      expect(wrapper.findAll('[data-testid="slots"] [data-state="held"]')).toHaveLength(0)
    })

    it('runs the injection sample to a refusal made before any model reads the message', async () => {
      const { wrapper } = await openBoard()
      await chooseSample(wrapper, 'injection-confirm-slot-en')
      await runChosenSample(wrapper)
      const receipt = wrapper.get('[data-testid="receipt"]')
      expect(receipt.text()).toContain(en.lb02.chat.receipts.injection_refused)
      expect(wrapper.find('[data-testid="booking-code"]').exists()).toBe(false)
    })
  })

  describe('a sample replayed from its recording', () => {
    it('offers a recorded sample as a free replay and any other as a live run', async () => {
      const { wrapper } = await openBoard({ recordings: [recordingOf('book-cupping-en')] })
      expect(wrapper.get('[data-testid="start-sample"]').text()).toBe(en.lb02.start.replay)
      expect(wrapper.find('[data-testid="no-recording"]').exists()).toBe(false)
      await chooseSample(wrapper, 'book-tasting-cs')
      expect(wrapper.get('[data-testid="start-sample"]').text()).toBe(en.lb02.start.runSampleLive)
      expect(wrapper.find('[data-testid="no-recording"]').exists()).toBe(true)
    })

    it('replays the booking with no token, no socket and no write, labelled as a replay, and ends on the booking and the recorded email', async () => {
      const { wrapper, site } = await openBoard({ recordings: [recordingOf('book-cupping-en')] })
      await wrapper.get('[data-testid="start-sample"]').trigger('click')
      await settle()
      expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Replay')
      expect(wrapper.find('[data-testid="replay-banner"]').exists()).toBe(true)
      expect(wrapper.get('[data-testid="connection"]').text()).toBe(en.lb02.phone.status.replay)
      expect(wrapper.get('[data-testid="composer-hint"]').text()).toBe(en.lb02.composer.replaying)
      expect(wrapper.get('[data-testid="composer-field"]').attributes('disabled')).toBeDefined()

      await seconds(4)
      await settle()
      expect(lines(wrapper, 'visitor')).toHaveLength(3)
      expect(lines(wrapper, 'concierge')).toHaveLength(3)
      expect(wrapper.findAll('[data-testid="receipt"]').map(receipt => receipt.text())).toEqual([
        `${en.lb02.chat.receipt}: ${en.lb02.chat.receipts.hold_placed}`,
        `${en.lb02.chat.receipt}: ${en.lb02.chat.receipts.booking_confirmed}`,
      ])
      expect(wrapper.get('[data-testid="booking-code"]').text()).toMatch(/^BB-/)
      expect(wrapper.find('[data-testid="hold-timer"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="email-badge"]').text()).toBe(en.lb02.email.badge)
      expect(wrapper.get('[data-testid="email-to"]').text()).toBe('jana@example.test')
      expect(wrapper.get('[data-testid="calendar"]').text()).toContain(en.lb02.calendar.recorded)
      expect(wrapper.get('[data-testid="slots"] [data-state="booked"]').text()).toContain(en.lb02.calendar.status.bookedMine)

      expect(site.sockets).toHaveLength(0)
      expect(site.callsTo('/api/tokens')).toHaveLength(0)
      expect(site.calls.filter(call => call.method !== 'GET')).toEqual([])
      // The list of the visitor's conversations is read for the allowance; no conversation is read in full.
      expect(site.calls.filter(call => call.path.startsWith('/api/lb02/conversations/'))).toEqual([])
    })

    it('plays the replay again, and runs the same sample live when asked', async () => {
      const { wrapper, site } = await openBoard({ recordings: [recordingOf('book-cupping-en')] })
      await wrapper.get('[data-testid="start-sample"]').trigger('click')
      await seconds(4)
      await settle()
      const again = wrapper.findAll('[data-testid="replay-banner"] button')[0]
      await again?.trigger('click')
      await seconds(4)
      await settle()
      expect(lines(wrapper, 'visitor')).toHaveLength(3)
      expect(site.sockets).toHaveLength(0)

      await wrapper.findAll('[data-testid="replay-banner"] button')[1]?.trigger('click')
      await settle()
      expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Live')
      expect(site.sockets).toHaveLength(1)
      expect(wrapper.get('[data-testid="script-progress"]').text()).toBe('Message 1 of 3 sent')
    })

    it('shows the wait in the Czech conversation in which another visitor\'s hold runs out, and ends on a booking', async () => {
      const { wrapper } = await openBoard({ locale: 'cs', recordings: [recordingOf('two-tabs-held-by-other-cs')] })
      await chooseSample(wrapper, 'two-tabs-held-by-other-cs')
      await wrapper.get('[data-testid="start-sample"]').trigger('click')
      await seconds(10)
      await settle()
      expect(wrapper.get('[data-testid="line-pause"]').text()).toBe(cs.lb02.chat.later.replace('{minutes}', '6'))
      expect(lines(wrapper, 'visitor')).toHaveLength(4)
      expect(wrapper.get('[data-testid="booking-code"]').text()).toMatch(/^BB-/)
      expect(wrapper.get('[data-testid="email-badge"]').text()).toBe(cs.lb02.email.badge)
      expect(wrapper.get('[data-testid="board-state"]').text()).toBe(cs.board.replay)
    })

    it('says the sample has no recording yet when it has none, and offers the live run', async () => {
      const { wrapper } = await openBoard({ recordings: [] })
      expect(wrapper.get('[data-testid="no-recording"]').text()).toContain(en.lb02.start.noRecording)
      expect(wrapper.get('[data-testid="start-sample"]').text()).toBe(en.lb02.start.runSampleLive)
    })
  })

  describe('the visitor\'s own conversation', () => {
    /** Switches the start panel to the visitor's own conversation and begins it. */
    async function begin(wrapper: VueWrapper): Promise<void> {
      await wrapper.findAll('.lb-seg__btn')[1]?.trigger('click')
      await wrapper.get('[data-testid="begin"]').trigger('click')
      await settle()
    }

    it('opens a conversation, takes a message with Enter and answers it', async () => {
      const { wrapper, site } = await openBoard()
      await begin(wrapper)
      expect(wrapper.find('[data-testid="start"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="connection"]').text()).toBe(en.lb02.phone.status.open)
      expect(wrapper.get('[data-testid="composer-hint"]').text()).toBe(en.lb02.composer.hint)
      expect(wrapper.text()).toContain(en.lb02.chat.emptyLive)
      expect(JSON.parse(site.socket.sent[0] ?? '{}')).toMatchObject({ type: 'hello', conversation: null })
      expect(site.socket.url).not.toContain('token')

      await say(wrapper, 'Hello! I would like a cupping for two tomorrow afternoon. I am Jana Novak, jana@example.test.')
      expect(lines(wrapper, 'visitor')).toHaveLength(1)
      expect(lines(wrapper, 'concierge')).toHaveLength(1)
      expect(wrapper.get('[data-testid="messages-count"]').text()).toBe('29 of 30')
      expect(wrapper.get('[data-testid="model-calls"]').text()).not.toBe('0')
    })

    it('shows the tools the concierge called in the Technical reading only', async () => {
      const { wrapper } = await openBoard()
      await begin(wrapper)
      await say(wrapper, 'A cupping for two tomorrow afternoon please, I am Jana Novak, jana@example.test.')
      expect(wrapper.find('[data-testid="tools"]').exists()).toBe(true)
      useReadingStore().mode = 'brief'
      await settle()
      expect(wrapper.find('[data-testid="tools"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="chain"]').exists()).toBe(false)
    })

    it('hands the conversation to a person on request: a card with the reason and every line, focus on it, and no field to write in', async () => {
      const { wrapper } = await openBoard()
      await begin(wrapper)
      await say(wrapper, 'Can I speak to a real person please?')
      const card = wrapper.get('[data-testid="handoff"]')
      expect(card.text()).toContain(en.lb02.handoff.reasons.asked_for_person)
      expect(card.findAll('[data-testid="handoff-transcript"] li').length).toBeGreaterThanOrEqual(2)
      expect(document.activeElement).toBe(card.element)
      expect(wrapper.get('[data-testid="composer-field"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get('[data-testid="composer-hint"]').text()).toBe(en.lb02.composer.finished)
      expect(wrapper.get('[data-testid="receipt"]').text()).toContain(en.lb02.chat.receipts.handed_off)
      expect(wrapper.get('[data-testid="step"]').text()).toBe(en.lb02.facts.steps.handoff)
    })

    it('shows another visitor taking a slot on the live calendar, and says so to a screen reader', async () => {
      const { wrapper, site } = await openBoard()
      await begin(wrapper)
      const before = wrapper.findAll('[data-testid="slots"] [data-state="booked"]').length
      site.lb02.otherVisitor('books', 'tasting', 1, '12:00')
      await settle()
      await wrapper.get('[data-testid="day-2026-10-03"]').setValue(true)
      expect(wrapper.findAll('[data-testid="slots"] [data-state="booked"]').length).toBeGreaterThan(before)
      expect(wrapper.get('[data-testid="calendar-announcement"]').text()).toMatch(/is now booked|slots on the calendar changed/)
    })

    it('ends the conversation on request and goes back to the start with the keyboard on its heading', async () => {
      const { wrapper } = await openBoard()
      await begin(wrapper)
      await wrapper.get('[data-testid="end"]').trigger('click')
      await settle()
      expect(wrapper.get('[data-testid="ended"]').text()).toBe(en.lb02.ended.visitor)
      expect(wrapper.get('[data-testid="composer-hint"]').text()).toBe(en.lb02.composer.ended)
      await wrapper.get('[data-testid="again"]').trigger('click')
      await settle()
      expect(wrapper.find('[data-testid="start"]').exists()).toBe(true)
      expect(document.activeElement?.textContent).toBe(en.lb02.start.title)
      expect(wrapper.get('[data-testid="connection"]').text()).toBe(en.lb02.phone.status.idle)
    })

    it('is told the connection closed after a quiet quarter hour, and picks the conversation up where it was', async () => {
      const { wrapper, site } = await openBoard()
      await begin(wrapper)
      await say(wrapper, 'A cupping for two tomorrow afternoon please, I am Jana Novak, jana@example.test.')
      const before = lines(wrapper, 'visitor').length
      site.socket.serverCloses(4408)
      await settle()
      expect(wrapper.get('[data-testid="ended"]').text()).toBe(en.lb02.ended.timed_out)
      await wrapper.get('[data-testid="resume-ended"]').trigger('click')
      await settle()
      expect(wrapper.find('[data-testid="ended"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="connection"]').text()).toBe(en.lb02.phone.status.open)
      expect(lines(wrapper, 'visitor')).toHaveLength(before)
      expect(site.sockets).toHaveLength(2)
      expect(JSON.parse(site.socket.sent[0] ?? '{}').conversation).toMatch(/^[\w-]{16}$/)
    })

    it('reloads the calendar after the connection comes back, and says so', async () => {
      const { wrapper, site } = await openBoard()
      await begin(wrapper)
      const loads = site.callsTo('/api/lb02/calendar').length
      site.socket.serverCloses(1006)
      await seconds(3)
      await settle()
      expect(site.callsTo('/api/lb02/calendar').length).toBeGreaterThan(loads)
      expect(wrapper.get('[data-testid="connection"]').text()).toBe(en.lb02.phone.status.open)
      expect(wrapper.get('[data-testid="calendar-announcement"]').text()).toBe(en.lb02.calendar.reloaded)
    })

    it('words a message that was too long or not understood in plain language, and never shows the server\'s text', async () => {
      const { wrapper, site } = await openBoard()
      await begin(wrapper)
      site.socket.serverSays(JSON.stringify({ type: 'error', code: 'unavailable', message: '<b>the server\'s own words</b>' }))
      await settle()
      const notice = wrapper.get('[data-testid="notice"]')
      expect(notice.text()).toBe(en.lb02.notice.unavailable)
      expect(wrapper.html()).not.toContain('the server\'s own words')
    })

    it('closes the connection and says so when the server sends something this page does not understand', async () => {
      const { wrapper, site } = await openBoard()
      await begin(wrapper)
      site.socket.serverSays('{"type":"reply","text":"x","unexpected":true}')
      await settle()
      expect(wrapper.get('[data-testid="ended"]').text()).toBe(en.lb02.ended.malformed)
      expect(site.socket.readyState).toBe(3)
    })
  })

  describe('a deployment', () => {
    it('with no back end says so, turns live conversations off and leaves the board readable', async () => {
      const { wrapper, site } = await openBoard({ available: false })
      expect(wrapper.find('[data-kind="unavailable"]').exists()).toBe(true)
      expect(wrapper.get('[data-testid="start-sample"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get('[data-testid="live-hint"]').text()).toBe(en.lb02.start.noLive)
      expect(site.sockets).toHaveLength(0)
    })

    it('explains how to try to double-book a slot, and offers the board as an installable app', async () => {
      const { wrapper } = await openBoard()
      expect(wrapper.get('[data-testid="second-tab"]').text()).toContain(en.lb02.second.step1)
      expect(wrapper.get('[data-testid="app-panel"]').text()).toContain(en.lb02.app.text)
      expect(wrapper.find('[data-testid="app-unsupported"]').exists()).toBe(true)
    })
  })

  it('is in Czech in Czech, a sample run included', async () => {
    const { wrapper } = await openBoard({ locale: 'cs' })
    expect(wrapper.text()).toContain(cs.lb02.intro.slice(0, 40))
    expect(wrapper.get('[data-testid="composer-hint"]').text()).toBe(cs.lb02.composer.notStarted)
    await chooseSample(wrapper, 'book-tasting-cs')
    await runChosenSample(wrapper)
    expect(wrapper.get('[data-testid="connection"]').text()).toBe(cs.lb02.phone.status.open)
    expect(lines(wrapper, 'visitor')[0]?.text()).toContain('Dobrý den')
    await wrapper.get('[data-testid="script-next"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="receipt"]').text()).toContain(cs.lb02.chat.receipts.hold_placed)
    expect(wrapper.get('[data-testid="hold-timer"]').text()).toContain('zbývá')
  })

  it('has a sample for each of the five curated cases of the golden set', () => {
    expect(LB02_SAMPLES.map(sample => sample.id)).toEqual(['book-cupping-en', 'book-tasting-cs', 'double-book-taken-slot-en', 'two-tabs-held-by-other-cs', 'injection-confirm-slot-en'])
  })
})
