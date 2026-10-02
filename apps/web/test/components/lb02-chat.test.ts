// Tests of the parts of LB-02's board that make up the phone: the chat log, the message field, the hold
// and the booking above it, and the state of the conversation in the side column. Each is mounted alone
// with the site's real messages, in English and in Czech.
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import BookingStatus from '~/boards/lb-02/components/BookingStatus.vue'
import ChatComposer from '~/boards/lb-02/components/ChatComposer.vue'
import ChatLog from '~/boards/lb-02/components/ChatLog.vue'
import ConversationFacts from '~/boards/lb-02/components/ConversationFacts.vue'
import PhoneFrame from '~/boards/lb-02/components/PhoneFrame.vue'
import SampleScript from '~/boards/lb-02/components/SampleScript.vue'
import type { ChatLine } from '~/boards/lb-02/chat'
import type { ConversationState } from '~/boards/lb-02/wire'
import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'

import { BOOKING, hold } from '../support/lb02-fixtures'
import { mountWithSite } from '../support/mount'

afterEach(() => {
  document.body.innerHTML = ''
})

/** The names of the offerings, as the board writes them. */
const titleOf = (key: string): string => ({ cupping: 'Cupping session', tasting: 'Coffee tasting' }[key] ?? key)

const LINES: ChatLine[] = [
  { id: 1, kind: 'visitor', text: 'A cupping for two tomorrow afternoon, please.' },
  { id: 2, kind: 'concierge', text: 'Two slots are free tomorrow afternoon.', receipt: null, tools: [{ name: 'search_availability', executed: true, ok: true, error: '' }] },
  { id: 3, kind: 'action', text: 'Held slot 7 for 5 minutes.' },
  { id: 4, kind: 'concierge', text: 'I have held the 14:30 session for you.', receipt: 'hold_placed', tools: [{ name: 'hold_slot', executed: true, ok: true, error: '' }, { name: 'confirm_booking', executed: false, ok: false, error: 'no hold' }] },
]

describe('the chat log', () => {
  /** Mounts the log with the lines above. */
  function mountLog(props: Record<string, unknown> = {}, locale: 'en' | 'cs' = 'en') {
    return mountWithSite(ChatLog, { locale, props: { lines: LINES, working: false, language: 'en', brief: false, empty: 'Nothing yet.', ...props } })
  }

  it('is a log with a name, that can be reached and scrolled by keyboard, and announces what is added', () => {
    const log = mountLog().get('[data-testid="chat-log"]')
    expect(log.attributes('role')).toBe('log')
    expect(log.attributes('aria-label')).toBe(en.lb02.chat.logLabel)
    expect(log.attributes('tabindex')).toBe('0')
    expect(log.attributes('aria-relevant')).toBe('additions')
  })

  it('says who said each line before what was said', () => {
    const items = mountLog().findAll('.lines > li')
    expect(items.map(item => item.attributes('data-testid'))).toEqual(['line-visitor', 'line-concierge', 'line-action', 'line-concierge'])
    expect(items[0]?.text()).toBe(`${en.lb02.chat.you}A cupping for two tomorrow afternoon, please.`)
    expect(items[1]?.text()).toContain(en.lb02.chat.concierge)
    expect(items[2]?.text()).toContain(en.lb02.chat.note)
  })

  it('marks a message the booking code wrote, and explains the mark in the Technical reading only', () => {
    const technical = mountLog()
    expect(technical.findAll('[data-testid="receipt"]')).toHaveLength(1)
    expect(technical.get('[data-testid="receipt"]').text()).toBe(`${en.lb02.chat.receipt}: ${en.lb02.chat.receipts.hold_placed}`)
    expect(technical.text()).toContain(en.lb02.chat.receiptHelp)
    const brief = mountLog({ brief: true })
    expect(brief.get('[data-testid="receipt"]').text()).toContain(en.lb02.chat.receipts.hold_placed)
    expect(brief.text()).not.toContain(en.lb02.chat.receiptHelp)
  })

  it('lists the tools a turn called, including one the booking rules refused, in the Technical reading only', () => {
    const lists = mountLog().findAll('[data-testid="tools"]')
    expect(lists).toHaveLength(2)
    expect(lists[1]?.text()).toContain('hold_slot')
    expect(lists[1]?.text()).toContain(en.lb02.chat.toolOutcome.ran)
    expect(lists[1]?.text()).toContain('confirm_booking')
    expect(lists[1]?.text()).toContain(en.lb02.chat.toolOutcome.refused)
    expect(mountLog({ brief: true }).findAll('[data-testid="tools"]')).toHaveLength(0)
  })

  it('shows every word as text, never as markup', () => {
    const hostile: ChatLine[] = [
      { id: 1, kind: 'visitor', text: '<img src=x onerror=alert(1)>' },
      { id: 2, kind: 'concierge', text: '<script>alert(2)</script><b>bold</b>', receipt: null, tools: [{ name: '<i>made_up_tool</i>', executed: false, ok: false, error: '' }] },
      { id: 3, kind: 'action', text: '<u>note</u>' },
    ]
    const wrapper = mountLog({ lines: hostile })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('b').exists()).toBe(false)
    expect(wrapper.find('i').exists()).toBe(false)
    expect(wrapper.find('u').exists()).toBe(false)
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>')
    expect(wrapper.text()).toContain('<i>made_up_tool</i>')
  })

  it('says what it is waiting for while the log is empty, and that the concierge is working while it is', () => {
    const empty = mountLog({ lines: [] })
    expect(empty.text()).toContain('Nothing yet.')
    const working = mountLog({ working: true })
    expect(working.get('[data-testid="working"]').attributes('role')).toBe('status')
    expect(working.get('[data-testid="working"]').text()).toBe(en.lb02.chat.working)
  })

  it('writes the visitor\'s language, with Czech typeset so no line ends on a single letter, and words every label in Czech', () => {
    const wrapper = mountLog({ language: 'cs', lines: [{ id: 1, kind: 'concierge', text: 'Je to v pořádku a už z toho máme radost.', receipt: 'booking_confirmed', tools: [] }] }, 'cs')
    const bubble = wrapper.get('.bubble')
    expect(bubble.attributes('lang')).toBe('cs')
    expect(bubble.text()).toContain('v pořádku')
    expect(bubble.text()).toContain('a už')
    expect(wrapper.get('[data-testid="receipt"]').text()).toBe(`${cs.lb02.chat.receipt}: ${cs.lb02.chat.receipts.booking_confirmed}`)
  })
})

describe('the message field', () => {
  /** Mounts the composer. */
  function mountComposer(props: Record<string, unknown> = {}, locale: 'en' | 'cs' = 'en') {
    return mountWithSite(ChatComposer, { locale, props: { mode: 'ready', working: false, language: 'en', unsent: undefined, messagesLeft: 30, ...props } })
  }

  it('sends on Enter and empties the field', async () => {
    const wrapper = mountComposer()
    const field = wrapper.get('[data-testid="composer-field"]')
    await field.setValue('  A tasting for four on Friday.  ')
    await field.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toEqual([['A tasting for four on Friday.']])
    expect((field.element as HTMLTextAreaElement).value).toBe('')
  })

  it('starts a new line on Shift and Enter, and sends nothing for an empty message', async () => {
    const wrapper = mountComposer()
    const field = wrapper.get('[data-testid="composer-field"]')
    await field.setValue('first line')
    await field.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('send')).toBeUndefined()
    await field.setValue('   ')
    await field.trigger('keydown', { key: 'Enter' })
    expect(wrapper.get('[data-testid="send"]').attributes('disabled')).toBeDefined()
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('stays open for writing while the concierge answers, and sends once it has', async () => {
    const wrapper = mountComposer({ working: true })
    const field = wrapper.get('[data-testid="composer-field"]')
    expect(field.attributes('disabled')).toBeUndefined()
    await field.setValue('And a second question.')
    await field.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()
    expect(wrapper.get('[data-testid="composer-hint"]').text()).toBe(en.lb02.composer.waiting)
    await wrapper.setProps({ working: false })
    await field.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toEqual([['And a second question.']])
  })

  it('counts the 500 characters the connection takes and does not take more', async () => {
    const wrapper = mountComposer()
    const field = wrapper.get('[data-testid="composer-field"]')
    expect(field.attributes('maxlength')).toBe('500')
    await field.setValue('hello')
    expect(wrapper.text()).toContain('5 of 500')
  })

  it.each([
    ['idle', en.lb02.composer.notStarted],
    ['connecting', en.lb02.composer.connecting],
    ['replay', en.lb02.composer.replaying],
    ['finished', en.lb02.composer.finished],
    ['ended', en.lb02.composer.ended],
    ['offline', en.lb02.composer.offline],
  ])('is closed, and says why, when the mode is %s', (mode, hint) => {
    const wrapper = mountComposer({ mode })
    expect(wrapper.get('[data-testid="composer-field"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="composer-hint"]').text()).toBe(hint)
    expect(wrapper.get('[data-testid="composer-field"]').attributes('aria-describedby')).toBe(wrapper.get('[data-testid="composer-hint"]').attributes('id'))
  })

  it('warns that the next message hands the conversation over once only one is left', () => {
    expect(mountComposer({ messagesLeft: 0 }).get('[data-testid="composer-hint"]').text()).toBe(en.lb02.composer.lastMessage)
  })

  it('puts a message the page is not sure was sent back in the field, unless the visitor started another', async () => {
    const wrapper = mountComposer()
    await wrapper.setProps({ unsent: 'Please book it.' })
    expect((wrapper.get('[data-testid="composer-field"]').element as HTMLTextAreaElement).value).toBe('Please book it.')
    const busy = mountComposer()
    await busy.get('[data-testid="composer-field"]').setValue('Something else')
    await busy.setProps({ unsent: 'Please book it.' })
    expect((busy.get('[data-testid="composer-field"]').element as HTMLTextAreaElement).value).toBe('Something else')
  })

  it('has a label, and takes the keyboard\'s focus when asked', async () => {
    const wrapper = mountComposer()
    expect(wrapper.get('label').text()).toBe(en.lb02.composer.label)
    ;(wrapper.vm as unknown as { focus: () => void }).focus()
    expect(document.activeElement).toBe(wrapper.get('[data-testid="composer-field"]').element)
  })

  it('is in Czech in Czech', () => {
    const wrapper = mountComposer({ mode: 'idle' }, 'cs')
    expect(wrapper.get('[data-testid="composer-hint"]').text()).toBe(cs.lb02.composer.notStarted)
    expect(wrapper.get('[data-testid="send"]').text()).toBe(cs.lb02.composer.send)
  })
})

describe('the hold and the booking', () => {
  const NOW = Date.parse('2026-10-02T09:30:00.000Z')

  /** Mounts the status card. */
  function mountStatus(props: Record<string, unknown> = {}, locale: 'en' | 'cs' = 'en') {
    return mountWithSite(BookingStatus, { locale, props: { hold: null, booking: null, now: NOW, replay: false, titleOf, emailHref: '#lb02-email', ...props } })
  }

  it('shows nothing when there is neither', () => {
    expect(mountStatus().find('[data-testid="booking-status"]').exists()).toBe(false)
  })

  it('counts down the time left on a hold from the server\'s clock, and says what is held', () => {
    const wrapper = mountStatus({ hold: hold('2026-10-02T09:34:12.000Z') })
    expect(wrapper.get('[data-testid="hold-timer"]').attributes('role')).toBe('timer')
    expect(wrapper.get('[data-testid="hold-timer"]').text()).toContain('4:12 left')
    expect(wrapper.text()).toContain('Cupping session')
    expect(wrapper.text()).toContain('14:30')
  })

  it('announces the hold twice only: when one minute is left and when it has run out', async () => {
    const wrapper = mountStatus({ hold: hold('2026-10-02T09:35:00.000Z') })
    const announced = () => wrapper.get('[role="status"]').text()
    expect(announced()).toBe('')
    await wrapper.setProps({ now: NOW + 200_000 })
    expect(announced()).toBe('')
    await wrapper.setProps({ now: NOW + 241_000 })
    expect(announced()).toBe(en.lb02.hold.lastMinute)
    await wrapper.setProps({ now: NOW + 280_000 })
    expect(wrapper.get('[data-testid="hold-timer"]').text()).toContain('0:20 left')
    expect(announced()).toBe(en.lb02.hold.lastMinute)
    await wrapper.setProps({ now: NOW + 301_000 })
    expect(wrapper.find('[data-testid="hold-timer"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="hold-ran-out"]').text()).toBe(en.lb02.hold.ranOut)
    expect(announced()).toBe(en.lb02.hold.ranOut)
  })

  it('shows what a hold was in a replay, not a clock that ran out long ago', () => {
    const wrapper = mountStatus({ hold: hold('2026-10-02T09:35:00.000Z'), replay: true, now: NOW + 3_600_000 })
    expect(wrapper.find('[data-testid="hold-timer"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="hold-ran-out"]').exists()).toBe(false)
    expect(wrapper.text()).toContain(en.lb02.hold.recorded)
  })

  it('shows the booking with its code and a link to the recorded email', () => {
    const wrapper = mountStatus({ booking: BOOKING })
    expect(wrapper.get('[data-testid="booking-code"]').text()).toBe('BB-7K2M')
    expect(wrapper.text()).toContain(en.lb02.booking.title)
    expect(wrapper.text()).toContain('Party of 2')
    expect(wrapper.get('a').attributes('href')).toBe('#lb02-email')
  })

  it('is in Czech in Czech, with the time on the roastery\'s clock', () => {
    const wrapper = mountStatus({ booking: BOOKING }, 'cs')
    expect(wrapper.text()).toContain(cs.lb02.booking.title)
    expect(wrapper.text()).toContain('14:30')
  })
})

describe('the phone', () => {
  it('is named, says the state of the connection in words, and holds the chat', () => {
    const wrapper = mountWithSite(PhoneFrame, { props: { status: 'reconnecting', attempt: 2 }, locale: 'en' })
    expect(wrapper.get('[data-testid="phone"]').attributes('aria-label')).toBe(en.lb02.phone.label)
    const status = wrapper.get('[data-testid="connection"]')
    expect(status.attributes('role')).toBe('status')
    expect(status.text()).toBe('Reconnecting, attempt 2 of 5')
  })

  it.each(['idle', 'connecting', 'open', 'closed', 'replay'] as const)('has a word for the state %s', (status) => {
    const wrapper = mountWithSite(PhoneFrame, { props: { status, attempt: 0 } })
    expect(wrapper.get('[data-testid="connection"]').text()).toBe(en.lb02.phone.status[status])
  })
})

describe('the sample script', () => {
  const turns = [
    { say: 'First message.', waitMinutes: 0 },
    { say: 'Second, after a wait.', waitMinutes: 6 },
  ] as const

  /** Mounts the script. */
  function mountScript(props: Record<string, unknown> = {}) {
    return mountWithSite(SampleScript, { props: { script: { sampleId: 'x', turns, sent: 1, autoplay: false }, language: 'en', canSend: true, ...props } })
  }

  it('lists the messages with which are sent, which is next and which come later, and counts them', () => {
    const wrapper = mountScript()
    expect(wrapper.get('[data-testid="script-progress"]').text()).toBe('Message 1 of 2 sent')
    expect(wrapper.findAll('li').map(item => item.attributes('data-place'))).toEqual(['sent', 'next'])
    expect(wrapper.findAll('li')[1]?.text()).toContain('Then 6 minutes pass.')
  })

  it('sends the next message, or all of them, or stops sending', async () => {
    const wrapper = mountScript()
    await wrapper.get('[data-testid="script-next"]').trigger('click')
    await wrapper.get('[data-testid="script-all"]').trigger('click')
    expect(wrapper.emitted('next')).toHaveLength(1)
    expect(wrapper.emitted('all')).toHaveLength(1)
    await wrapper.setProps({ script: { sampleId: 'x', turns, sent: 1, autoplay: true } })
    await wrapper.get('[data-testid="script-stop"]').trigger('click')
    expect(wrapper.emitted('stop')).toHaveLength(1)
  })

  it('cannot send while the concierge is answering, and says when it is all sent', async () => {
    const wrapper = mountScript({ canSend: false })
    expect(wrapper.get('[data-testid="script-next"]').attributes('disabled')).toBeDefined()
    await wrapper.setProps({ script: { sampleId: 'x', turns, sent: 2, autoplay: false } })
    expect(wrapper.get('[data-testid="script-finished"]').text()).toBe(en.lb02.script.finished)
    expect(wrapper.find('[data-testid="script-next"]').exists()).toBe(false)
  })
})

describe('the conversation\'s state', () => {
  /** A state of the conversation at a step. */
  function state(overrides: Partial<ConversationState> = {}): ConversationState {
    return { step: 'availability', language: 'cs', messages_left: 27, closed: false, options: [], hold: null, booking: null, ...overrides }
  }

  it('counts the thirty messages and names the step and the language', () => {
    const wrapper = mountWithSite(ConversationFacts, { props: { state: state(), modelCalls: 3, brief: false } })
    expect(wrapper.get('[data-testid="messages-count"]').text()).toBe('27 of 30')
    expect(wrapper.get('[data-testid="step"]').text()).toBe(en.lb02.facts.steps.availability)
    expect(wrapper.get('[data-testid="language"]').text()).toBe('Czech')
    expect(wrapper.get('[data-testid="model-calls"]').text()).toBe('3')
  })

  it('says the next message hands the conversation over when none is left', () => {
    const wrapper = mountWithSite(ConversationFacts, { props: { state: state({ messages_left: 0 }), modelCalls: 0, brief: false } })
    expect(wrapper.text()).toContain(en.lb02.messages.none)
  })

  it('lists the steps with where the conversation is among them, and only the handoff after a handoff', () => {
    const wrapper = mountWithSite(ConversationFacts, { props: { state: state({ step: 'hold' }), modelCalls: 0, brief: false } })
    expect(wrapper.findAll('[data-testid="chain"] li').map(item => item.attributes('data-mark'))).toEqual(['done', 'done', 'current', 'waiting'])
    const handed = mountWithSite(ConversationFacts, { props: { state: state({ step: 'handoff', closed: true }), modelCalls: 0, brief: false } })
    expect(handed.findAll('[data-testid="chain"] li')).toHaveLength(1)
    expect(handed.get('[data-testid="chain"]').text()).toContain(en.lb02.facts.steps.handoff)
  })

  it('leaves out the steps and the model calls in the Brief reading, and shows a full count before the start', () => {
    const wrapper = mountWithSite(ConversationFacts, { props: { state: undefined, modelCalls: 0, brief: true } })
    expect(wrapper.find('[data-testid="chain"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="model-calls"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="messages-count"]').text()).toBe('30 of 30')
    expect(wrapper.get('[data-testid="step"]').text()).toBe(en.lb02.facts.none)
  })

  it('is in Czech in Czech', async () => {
    const wrapper = mountWithSite(ConversationFacts, { locale: 'cs', props: { state: state(), modelCalls: 1, brief: false } })
    await flushPromises()
    expect(wrapper.get('[data-testid="step"]').text()).toBe(cs.lb02.facts.steps.availability)
    expect(wrapper.get('[data-testid="messages-count"]').text()).toBe('27 z\u00A030')
    expect(wrapper.get('[data-testid="language"]').text()).toBe('čeština')
  })
})
