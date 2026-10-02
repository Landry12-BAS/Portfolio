// Tests of the panels around LB-02's phone: the live calendar, the start panel, the controls over a
// conversation, the recorded confirmation email, the handoff to a person, the second-tab guide and the
// installable-app panel. Each is mounted alone with the site's real messages, in English and in Czech.
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LB02_SAMPLES } from '#shared/data/samples/lb02'

import AppPanel from '~/boards/lb-02/components/AppPanel.vue'
import ConfirmationEmail from '~/boards/lb-02/components/ConfirmationEmail.vue'
import ConversationBar from '~/boards/lb-02/components/ConversationBar.vue'
import HandoffCard from '~/boards/lb-02/components/HandoffCard.vue'
import LiveCalendar from '~/boards/lb-02/components/LiveCalendar.vue'
import SecondTabGuide from '~/boards/lb-02/components/SecondTabGuide.vue'
import StartPanel from '~/boards/lb-02/components/StartPanel.vue'
import type { ChangeNote } from '~/boards/lb-02/store'
import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'

import { CONFIRMATION, HANDOFF, slot, slotMap } from '../support/lb02-fixtures'
import { mountWithSite } from '../support/mount'

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

/** The names of the offerings, as the board writes them. */
const titleOf = (key: string): string => ({ 'cupping': 'Cupping session', 'tasting': 'Coffee tasting', 'roasting-workshop': 'Roasting workshop' }[key] ?? key)
const NOW = Date.parse('2026-10-02T09:30:00.000Z')

/** Writes a text with its non-breaking spaces as plain ones, for comparing. */
const plain = (text: string): string => text.replaceAll('\u00A0', ' ')

describe('the live calendar', () => {
  // Saturday 3 October, noon and 14:30 in Prague, and Monday 5 October.
  const noon = slot(1, '2026-10-03T10:00:00.000Z', 'booked', { offering: 'tasting' })
  const afternoon = slot(2, '2026-10-03T12:30:00.000Z', 'free')
  const monday = slot(3, '2026-10-05T12:30:00.000Z', 'free')

  /** Mounts the calendar. */
  function mountCalendar(props: Record<string, unknown> = {}, locale: 'en' | 'cs' = 'en') {
    return mountWithSite(LiveCalendar, {
      locale,
      props: { slots: slotMap(noon, afternoon, monday), now: NOW, status: 'ready', lastChange: undefined, recentlyChanged: new Set<number>(), offerings: [], replay: false, titleOf, ...props },
    })
  }

  it('offers the days as one group of choices, opens on the first with a free slot, and lists its slots from morning to evening', () => {
    const wrapper = mountCalendar()
    expect(wrapper.findAll('input[type="radio"]').map(input => (input.element as HTMLInputElement).checked)).toEqual([true, false])
    const rows = wrapper.findAll('[data-testid="slots"] li')
    expect(rows.map(row => row.attributes('data-slot'))).toEqual(['1', '2'])
    expect(rows[0]?.text()).toContain('12:00')
    expect(rows[0]?.text()).toContain('Coffee tasting')
    expect(rows[1]?.text()).toContain('14:30')
    expect(wrapper.get('h3').text()).toBe('Saturday, October 3')
  })

  it('says each state in a word beside an icon, never by colour alone', () => {
    const rows = mountCalendar().findAll('[data-testid="slots"] li')
    expect(rows[0]?.get('.state').text()).toBe(en.lb02.calendar.status.booked)
    expect(rows[1]?.get('.state').text()).toBe(en.lb02.calendar.status.free)
    expect(rows[1]?.find('.state svg, .state use, .state [class*="icon"]').exists() || rows[1]?.html().includes('svg')).toBe(true)
  })

  it('says how many slots of the day are free, held and booked', () => {
    expect(mountCalendar().get('.counts').text()).toBe('1 free, 0 held, 1 booked')
  })

  it('opens on the day with the visitor\'s own slot, and says the slot is theirs', () => {
    const mine = slot(3, '2026-10-05T12:30:00.000Z', 'held', { mine: true, until: '2026-10-02T09:34:00.000Z' })
    const wrapper = mountCalendar({ slots: slotMap(noon, afternoon, mine) })
    expect(wrapper.get('h3').text()).toBe('Monday, October 5')
    expect(wrapper.get('[data-slot="3"] .state').text()).toBe(en.lb02.calendar.status.heldMine)
    expect(wrapper.get('[data-testid="day-2026-10-05"]').attributes('aria-describedby')).toBeDefined()
    const description = document.getElementById(wrapper.get('[data-testid="day-2026-10-05"]').attributes('aria-describedby') ?? '')
    expect(description?.textContent).toContain(en.lb02.calendar.dayMarker)
  })

  it('shows a hold whose time has passed as free at once, and says why', () => {
    const lapsed = slot(2, '2026-10-03T12:30:00.000Z', 'held', { until: '2026-10-02T09:29:00.000Z' })
    const wrapper = mountCalendar({ slots: slotMap(noon, lapsed) })
    expect(wrapper.get('[data-slot="2"]').attributes('data-state')).toBe('free')
    expect(wrapper.get('[data-slot="2"]').text()).toContain(en.lb02.calendar.lapsed)
  })

  it('shows the day the visitor chooses', async () => {
    const wrapper = mountCalendar()
    await wrapper.get('[data-testid="day-2026-10-05"]').setValue(true)
    expect(wrapper.findAll('[data-testid="slots"] li').map(row => row.attributes('data-slot'))).toEqual(['3'])
    expect(wrapper.get('h3').text()).toBe('Monday, October 5')
  })

  it('marks the slots that just changed', () => {
    const wrapper = mountCalendar({ recentlyChanged: new Set([2]) })
    expect(wrapper.get('[data-slot="2"]').classes()).toContain('fresh')
    expect(wrapper.get('[data-slot="1"]').classes()).not.toContain('fresh')
  })

  it('tells a screen reader politely, in words, what changed', async () => {
    const wrapper = mountCalendar()
    const live = wrapper.get('[data-testid="calendar-announcement"]')
    expect(live.attributes('role')).toBe('status')
    expect(live.attributes('aria-live')).toBe('polite')
    const held = slot(2, '2026-10-03T12:30:00.000Z', 'held', { until: '2026-10-02T09:35:00.000Z' })
    const note: ChangeNote = { slots: [held], sequence: 1, cause: 'live' }
    await wrapper.setProps({ slots: slotMap(noon, held, monday), lastChange: note })
    expect(plain(live.text())).toBe('Cupping session on Sat, Oct 3 at 14:30 is now held.')
    await wrapper.setProps({ lastChange: { slots: [held, noon], sequence: 2, cause: 'live' } })
    expect(live.text()).toBe('2 slots on the calendar changed.')
    await wrapper.setProps({ lastChange: { slots: [], sequence: 3, cause: 'reset' } })
    expect(live.text()).toBe(en.lb02.calendar.reset)
    await wrapper.setProps({ lastChange: { slots: [], sequence: 4, cause: 'reconnect' } })
    expect(live.text()).toBe(en.lb02.calendar.reloaded)
  })

  it('says it is loading, and when it could not load offers to try again', async () => {
    const loading = mountCalendar({ slots: slotMap(), status: 'loading' })
    expect(loading.text()).toContain(en.lb02.calendar.loading)
    const failed = mountCalendar({ slots: slotMap(), status: 'failed' })
    expect(failed.get('[data-testid="calendar-failed"]').attributes('role')).toBe('alert')
    await failed.get('[data-testid="calendar-failed"] button').trigger('click')
    expect(failed.emitted('reload')).toHaveLength(1)
    expect(mountCalendar({ slots: slotMap(), status: 'ready' }).text()).toContain(en.lb02.calendar.empty)
  })

  it('says a replay\'s calendar is the recording\'s, and lists what can be booked', () => {
    const offerings = [
      { key: 'cupping', title: { en: 'Cupping session', cs: 'Cupping' }, summary: { en: '', cs: '' }, room: { en: '', cs: '' }, duration_minutes: 60, capacity: 8, price_czk: 450 },
    ]
    const wrapper = mountCalendar({ replay: true, offerings })
    expect(wrapper.text()).toContain(en.lb02.calendar.recorded)
    expect(wrapper.get('.offerings').text()).toContain('60 minutes')
    expect(wrapper.get('.offerings').text()).toContain('up to 8 guests')
  })

  it('is in Czech in Czech, with the days written the Czech way', () => {
    const wrapper = mountCalendar({}, 'cs')
    expect(wrapper.get('h3').text()).toMatch(/sobota\s+3\.\s+října/)
    expect(wrapper.get('.counts').text()).toBe(cs.lb02.calendar.counts.replace('{free}', '1').replace('{held}', '0').replace('{booked}', '1'))
    expect(wrapper.findAll('[data-testid="slots"] .state')[1]?.text()).toBe(cs.lb02.calendar.status.free)
  })
})

describe('the start panel', () => {
  const samples = LB02_SAMPLES.map(sample => ({
    id: sample.id,
    title: en.lb02.samples[sample.id].title,
    note: en.lb02.samples[sample.id].note,
    language: sample.language,
    excerpt: sample.turns[0]?.say ?? '',
  }))
  const scripts = Object.fromEntries(LB02_SAMPLES.map(sample => [sample.id, sample]))

  /** Mounts the panel. */
  function mountStart(props: Record<string, unknown> = {}, locale: 'en' | 'cs' = 'en') {
    return mountWithSite(StartPanel, {
      locale,
      props: { samples, scripts, recorded: [], busy: false, canRunLive: true, allowanceUsedUp: false, remembered: undefined, titleOf, ...props },
    })
  }

  it('opens on the five curated samples, with what the first says message by message', () => {
    const wrapper = mountStart()
    expect(wrapper.findAll('input[type="radio"][name="sample"]')).toHaveLength(5)
    const preview = wrapper.get('[data-testid="sample-preview"]')
    expect(preview.findAll('.messages li')).toHaveLength(3)
    expect(preview.text()).toContain('I\'d like to book a cupping session')
  })

  it('runs a sample that has no recording live, and says so', async () => {
    const wrapper = mountStart()
    expect(wrapper.get('[data-testid="no-recording"]').text()).toContain(en.lb02.start.noRecording)
    const button = wrapper.get('[data-testid="start-sample"]')
    expect(button.text()).toBe(en.lb02.start.runSampleLive)
    await button.trigger('click')
    expect(wrapper.emitted('runSample')).toEqual([['book-cupping-en']])
    expect(wrapper.emitted('replay')).toBeUndefined()
  })

  it('replays a sample that has a recording, for free, and offers the live run instead', async () => {
    const wrapper = mountStart({ recorded: ['book-cupping-en'] })
    const button = wrapper.get('[data-testid="start-sample"]')
    expect(button.text()).toBe(en.lb02.start.replay)
    await button.trigger('click')
    expect(wrapper.emitted('replay')).toEqual([['book-cupping-en']])
    await wrapper.get('[data-testid="run-sample-live"]').trigger('click')
    expect(wrapper.emitted('runSample')).toEqual([['book-cupping-en']])
  })

  it('shows what other visitors do in a sample, and how to see it live', async () => {
    const wrapper = mountStart()
    await wrapper.findAll('input[type="radio"][name="sample"]')[2]?.setValue(true)
    const preview = wrapper.get('[data-testid="sample-preview"]')
    expect(preview.text()).toContain(en.lb02.start.worldTitle)
    expect(preview.text()).toContain('Another visitor books Coffee tasting tomorrow at 12:00, before message 1.')
    expect(preview.text()).toContain(en.lb02.script.secondTab)
  })

  it('shows the wait between messages in a sample', async () => {
    const wrapper = mountStart()
    await wrapper.findAll('input[type="radio"][name="sample"]')[3]?.setValue(true)
    expect(wrapper.get('[data-testid="sample-preview"]').text()).toContain('Then 6 minutes pass.')
  })

  it('starts the visitor\'s own conversation', async () => {
    const wrapper = mountStart()
    await wrapper.findAll('.lb-seg__btn')[1]?.trigger('click')
    await wrapper.get('[data-testid="begin"]').trigger('click')
    expect(wrapper.emitted('begin')).toHaveLength(1)
  })

  it.each([
    [{ canRunLive: false, allowanceUsedUp: true }, en.lb02.start.noAllowance],
    [{ canRunLive: false, allowanceUsedUp: false }, en.lb02.start.noLive],
  ])('turns the live run off, and says why, with %j', async (props, hint) => {
    const wrapper = mountStart(props)
    expect(wrapper.get('[data-testid="live-hint"]').text()).toBe(hint)
    expect(wrapper.get('[data-testid="start-sample"]').attributes('disabled')).toBeDefined()
    await wrapper.findAll('.lb-seg__btn')[1]?.trigger('click')
    expect(wrapper.get('[data-testid="begin"]').attributes('disabled')).toBeDefined()
  })

  it('still replays a recorded sample when live runs are off', () => {
    const wrapper = mountStart({ canRunLive: false, allowanceUsedUp: true, recorded: ['book-cupping-en'] })
    expect(wrapper.get('[data-testid="start-sample"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="run-sample-live"]').exists()).toBe(false)
  })

  it('offers to pick up the conversation this tab left, or to forget it', async () => {
    const wrapper = mountStart({ remembered: 'abcdefghijklmnopqrst' })
    expect(wrapper.get('[data-testid="resume"]').text()).toContain(en.lb02.start.resumeTitle)
    await wrapper.get('[data-testid="resume-conversation"]').trigger('click')
    expect(wrapper.emitted('resume')).toHaveLength(1)
    await wrapper.findAll('[data-testid="resume"] button')[1]?.trigger('click')
    expect(wrapper.emitted('forget')).toHaveLength(1)
  })

  it('takes the keyboard\'s focus on its heading when asked', () => {
    const wrapper = mountStart()
    ;(wrapper.vm as unknown as { focus: () => void }).focus()
    expect(document.activeElement?.textContent).toBe(en.lb02.start.title)
  })

  it('is in Czech in Czech, the samples included', () => {
    const wrapper = mountStart({ samples: LB02_SAMPLES.map(sample => ({ id: sample.id, title: cs.lb02.samples[sample.id].title, note: cs.lb02.samples[sample.id].note, language: sample.language, excerpt: sample.turns[0]?.say ?? '' })) }, 'cs')
    expect(wrapper.text()).toContain(cs.lb02.samples['book-cupping-en'].title)
    expect(wrapper.get('[data-testid="start-sample"]').text()).toBe(cs.lb02.start.runSampleLive)
  })
})

describe('the controls over a conversation', () => {
  /** Mounts the bar. */
  function mountBar(props: Record<string, unknown> = {}, locale: 'en' | 'cs' = 'en') {
    return mountWithSite(ConversationBar, { locale, props: { mode: 'live', ending: undefined, hasConversation: true, finished: false, ...props } })
  }

  it('offers to end a live conversation, and nothing else', async () => {
    const wrapper = mountBar()
    expect(wrapper.find('[data-testid="ended"]').exists()).toBe(false)
    expect(wrapper.findAll('button')).toHaveLength(1)
    await wrapper.get('[data-testid="end"]').trigger('click')
    expect(wrapper.emitted('end')).toHaveLength(1)
  })

  it('offers a new conversation, in the same place, once it is over or while a replay shows', async () => {
    const replay = mountBar({ mode: 'replay' })
    expect(replay.find('[data-testid="end"]').exists()).toBe(false)
    await replay.get('[data-testid="again"]').trigger('click')
    expect(replay.emitted('again')).toHaveLength(1)
    expect(mountBar({ finished: true }).find('[data-testid="again"]').exists()).toBe(true)
  })

  it.each([
    ['lost', 'alert', true],
    ['timed_out', 'status', true],
    ['unavailable', 'alert', true],
    ['unauthorized', 'alert', true],
    ['too_big', 'alert', true],
    ['visitor', 'status', true],
    ['not_found', 'status', false],
    ['too_many', 'status', false],
    ['bad_frame', 'alert', false],
    ['malformed', 'alert', false],
  ] as const)('words an ending for %s in plain language, as %s, and offers to continue only if the conversation can be', async (reason, role, resumable) => {
    const wrapper = mountBar({ ending: { reason } })
    const message = wrapper.get('[data-testid="ended"]')
    expect(message.text()).toBe(en.lb02.ended[reason])
    expect(message.attributes('role')).toBe(role)
    expect(wrapper.find('[data-testid="resume-ended"]').exists()).toBe(resumable)
    expect(wrapper.find('[data-testid="again"]').exists()).toBe(true)
    if (resumable) {
      await wrapper.get('[data-testid="resume-ended"]').trigger('click')
      expect(wrapper.emitted('resume')).toHaveLength(1)
    }
  })

  it('does not offer to continue a conversation that does not exist or that a person has taken over', () => {
    expect(mountBar({ ending: { reason: 'lost' }, hasConversation: false }).find('[data-testid="resume-ended"]').exists()).toBe(false)
    expect(mountBar({ ending: { reason: 'lost' }, finished: true }).find('[data-testid="resume-ended"]').exists()).toBe(false)
  })

  it('offers to try again when the page could not get permission to open the conversation', async () => {
    const wrapper = mountBar({ ending: { reason: 'grant_failed' } })
    expect(wrapper.get('[data-testid="ended"]').text()).toBe(en.lb02.ended.grant_failed)
    await wrapper.get('[data-testid="retry-ended"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('is in Czech in Czech', () => {
    const wrapper = mountBar({ ending: { reason: 'timed_out' } }, 'cs')
    expect(wrapper.get('[data-testid="ended"]').text()).toBe(cs.lb02.ended.timed_out)
  })
})

describe('the recorded confirmation email', () => {
  it('says plainly that it is recorded and never sent, and shows who it is to and what it says', () => {
    const wrapper = mountWithSite(ConfirmationEmail, { props: { confirmation: CONFIRMATION, status: 'ready' } })
    expect(wrapper.get('[data-testid="email-badge"]').text()).toBe(en.lb02.email.badge)
    expect(wrapper.text()).toContain(en.lb02.email.help)
    expect(wrapper.get('[data-testid="email-to"]').text()).toBe('jana@example.test')
    expect(wrapper.get('[data-testid="email-subject"]').text()).toBe('Your cupping session is booked')
    expect(wrapper.get('[data-testid="email-body"]').text()).toContain('Saturday 3 October at 14:30')
  })

  it('shows the email as text and never as markup', () => {
    const wrapper = mountWithSite(ConfirmationEmail, { props: { confirmation: CONFIRMATION, status: 'ready' } })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('[data-testid="email-body"]').text()).toContain('<img src=x onerror=alert(1)>')
  })

  it('can be reached from the booking and takes focus', () => {
    const wrapper = mountWithSite(ConfirmationEmail, { props: { confirmation: null, status: 'loading' } })
    expect(wrapper.get('#lb02-email').attributes('tabindex')).toBe('-1')
    expect(wrapper.text()).toContain(en.lb02.email.loading)
  })

  it('says when the record could not be read', () => {
    const wrapper = mountWithSite(ConfirmationEmail, { props: { confirmation: null, status: 'failed' } })
    expect(wrapper.get('[role="alert"]').text()).toBe(en.lb02.detailFailed)
  })

  it('is in Czech in Czech', () => {
    const wrapper = mountWithSite(ConfirmationEmail, { locale: 'cs', props: { confirmation: { ...CONFIRMATION, language: 'cs' }, status: 'ready' } })
    expect(wrapper.get('[data-testid="email-badge"]').text()).toBe(cs.lb02.email.badge)
  })
})

describe('the handoff to a person', () => {
  it('says why, what had been collected and every line said', () => {
    const wrapper = mountWithSite(HandoffCard, { props: { handoff: HANDOFF, status: 'ready', language: 'en' } })
    expect(wrapper.get('[data-testid="handoff-reason"]').text()).toBe(en.lb02.handoff.reasons.asked_for_person)
    expect(wrapper.get('[data-testid="handoff-summary"]').text()).toBe(HANDOFF.summary)
    const lines = wrapper.findAll('[data-testid="handoff-transcript"] li')
    expect(lines.map(line => line.attributes('data-role'))).toEqual(['visitor', 'concierge'])
    expect(lines[0]?.text()).toContain('Can I talk to a person?')
    expect(wrapper.text()).toContain(en.lb02.handoff.help)
  })

  it('words a reason it does not know as a plain handoff, and never repeats the server\'s own words', () => {
    const wrapper = mountWithSite(HandoffCard, { props: { handoff: { ...HANDOFF, reason: '<b>made up</b>' }, status: 'ready', language: 'en' } })
    expect(wrapper.get('[data-testid="handoff-reason"]').text()).toBe(en.lb02.handoff.reasons.other)
    expect(wrapper.find('b').exists()).toBe(false)
  })

  it('says when nothing had been collected', () => {
    const wrapper = mountWithSite(HandoffCard, { props: { handoff: { ...HANDOFF, summary: '' }, status: 'ready', language: 'en' } })
    expect(wrapper.get('[data-testid="handoff-summary"]').text()).toBe(en.lb02.handoff.noSummary)
  })

  it('takes the keyboard\'s focus when the conversation is handed over', () => {
    const wrapper = mountWithSite(HandoffCard, { props: { handoff: null, status: 'loading', language: 'en' } })
    ;(wrapper.vm as unknown as { focus: () => void }).focus()
    expect(document.activeElement).toBe(wrapper.get('[data-testid="handoff"]').element)
    expect(wrapper.text()).toContain(en.lb02.handoff.loading)
  })

  it('shows the transcript as text and never as markup', () => {
    const hostile = { ...HANDOFF, transcript: [{ position: 0, role: 'visitor' as const, text: '<img src=x onerror=alert(1)>', at: HANDOFF.created_at }] }
    const wrapper = mountWithSite(HandoffCard, { props: { handoff: hostile, status: 'ready', language: 'en' } })
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('is in Czech in Czech', () => {
    const wrapper = mountWithSite(HandoffCard, { locale: 'cs', props: { handoff: HANDOFF, status: 'ready', language: 'cs' } })
    expect(wrapper.get('[data-testid="handoff-reason"]').text()).toBe(cs.lb02.handoff.reasons.asked_for_person)
  })
})

describe('the second-tab guide', () => {
  it('lists the four steps, says why a second booking cannot succeed, and opens the board in a new tab', () => {
    const wrapper = mountWithSite(SecondTabGuide)
    expect(wrapper.findAll('.steps li')).toHaveLength(4)
    expect(wrapper.text()).toContain(en.lb02.second.why)
    const link = wrapper.get('[data-testid="open-second-tab"]')
    expect(link.attributes('href')).toBe('/systems/lb-02/board')
  })

  it('is in Czech in Czech', () => {
    expect(mountWithSite(SecondTabGuide, { locale: 'cs' }).text()).toContain(cs.lb02.second.step2)
  })
})

describe('the installable app', () => {
  /** Gives the page a service worker container, and a secure context. */
  function givePageWorkers(controller: unknown = null) {
    const register = vi.fn(() => Promise.resolve({}))
    Object.defineProperty(navigator, 'serviceWorker', { value: Object.assign(new EventTarget(), { register, controller }), configurable: true })
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    return register
  }

  beforeEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker')
  })

  it('says what is saved on the device, and that nothing else is', () => {
    const wrapper = mountWithSite(AppPanel, { props: { scope: '/systems/lb-02/', online: true } })
    expect(wrapper.text()).toContain(en.lb02.app.text)
    expect(en.lb02.app.text).toContain('no messages')
  })

  it('says a browser without service workers cannot install the board, and the board goes on working', async () => {
    const wrapper = mountWithSite(AppPanel, { props: { scope: '/systems/lb-02/', online: true } })
    await flushPromises()
    expect(wrapper.get('[data-testid="app-unsupported"]').text()).toBe(en.lb02.app.unsupported)
    expect(wrapper.find('[data-testid="app-install"]').exists()).toBe(false)
  })

  it('registers the worker for the board\'s part of the site, and asks for one more reload before it can say the page is on the device', async () => {
    const register = givePageWorkers()
    const wrapper = mountWithSite(AppPanel, { props: { scope: '/cs/systems/lb-02/', online: true } })
    await flushPromises()
    expect(register).toHaveBeenCalledWith('/lb02-sw.js', { scope: '/cs/systems/lb-02/' })
    expect(wrapper.get('[data-testid="app-preparing"]').text()).toBe(en.lb02.app.preparing)
    expect(wrapper.find('[data-testid="app-cached"]').exists()).toBe(false)
  })

  it('says the page is on the device once it was loaded through the worker', async () => {
    givePageWorkers({})
    const wrapper = mountWithSite(AppPanel, { props: { scope: '/systems/lb-02/', online: true } })
    await flushPromises()
    expect(wrapper.get('[data-testid="app-cached"]').text()).toContain(en.lb02.app.cachedTitle)
    expect(wrapper.find('[data-testid="app-preparing"]').exists()).toBe(false)
  })

  it('offers the browser\'s install prompt only on the visitor\'s own click', async () => {
    givePageWorkers()
    const wrapper = mountWithSite(AppPanel, { props: { scope: '/systems/lb-02/', online: true } })
    await flushPromises()
    expect(wrapper.get('[data-testid="app-hint"]').text()).toBe(en.lb02.app.hint)
    const prompt = vi.fn(() => Promise.resolve())
    const offer = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt, userChoice: Promise.resolve({ outcome: 'accepted' as const }) })
    window.dispatchEvent(offer)
    await flushPromises()
    expect(offer.defaultPrevented).toBe(true)
    expect(prompt).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="app-install"]').trigger('click')
    await flushPromises()
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="app-install"]').exists()).toBe(false)
  })

  it('says it is installed once it is', async () => {
    givePageWorkers()
    const wrapper = mountWithSite(AppPanel, { props: { scope: '/systems/lb-02/', online: true } })
    await flushPromises()
    window.dispatchEvent(new Event('appinstalled'))
    await flushPromises()
    expect(wrapper.get('[data-testid="app-installed"]').text()).toContain(en.lb02.app.installed)
  })

  it('is honest when there is no connection: the page opens, the concierge, the calendar and the recordings do not', () => {
    const wrapper = mountWithSite(AppPanel, { props: { scope: '/systems/lb-02/', online: false } })
    const offline = wrapper.get('[data-testid="app-offline"]')
    expect(offline.attributes('role')).toBe('status')
    expect(offline.text()).toContain(en.lb02.app.offlineTitle)
    expect(offline.text()).toContain(en.lb02.app.offlineText)
  })

  it('is in Czech in Czech', async () => {
    const wrapper = mountWithSite(AppPanel, { locale: 'cs', props: { scope: '/cs/systems/lb-02/', online: false } })
    await flushPromises()
    expect(wrapper.get('[data-testid="app-offline"]').text()).toContain(cs.lb02.app.offlineTitle)
  })
})
