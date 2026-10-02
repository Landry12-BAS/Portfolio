// Component tests for the evaluation-board kit's simpler parts: the shell and its live or replay
// badge, the limits panel, the notices, the replay banner and the sample picker, in English and
// in Czech where the words matter.
import { defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'

import { TICKETS_PER_DAY } from '~/boards/lb-01/store'
import BoardLimitsPanel from '~/components/board/LimitsPanel.vue'
import BoardNotice from '~/components/board/Notice.vue'
import BoardReplayBanner from '~/components/board/ReplayBanner.vue'
import BoardSamplePicker from '~/components/board/SamplePicker.vue'
import BoardShell from '~/components/board/Shell.vue'

import { recordLb01Sample } from '../support/recording'
import { mountWithSite } from '../support/mount'

describe('BoardShell', () => {
  it('names the part and the system, and says Live for a live board', () => {
    const wrapper = mountWithSite(BoardShell, { props: { part: 'LB-01', name: 'Support Copilot', state: 'live' } })
    expect(wrapper.text()).toContain('LB-01')
    expect(wrapper.text()).toContain('Support Copilot')
    expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Live')
    expect(wrapper.get('section').attributes('aria-label')).toBe('LB-01 Support Copilot, Evaluation board')
  })

  it('says Replay, in words, for a replay', () => {
    const wrapper = mountWithSite(BoardShell, { props: { part: 'LB-01', name: 'x', state: 'replay' } })
    expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Replay')
  })

  it('speaks Czech', () => {
    const wrapper = mountWithSite(BoardShell, { locale: 'cs', props: { part: 'LB-01', name: 'x', state: 'replay' } })
    expect(wrapper.get('[data-testid="board-state"]').text()).toBe('Přehrání')
    expect(wrapper.text()).toContain('Vývojová deska')
  })

  it('gives the Scope the whole width under both columns, and draws nothing there when it has none', () => {
    const withScope = mountWithSite(defineComponent({
      render: () => h(BoardShell, { part: 'LB-01', name: 'n', state: 'live' }, { default: () => h('p', 'main'), scope: () => h('p', { id: 'trace' }, 'trace') }),
    }))
    expect(withScope.find('.trace #trace').exists()).toBe(true)
    expect(withScope.find('.frame .trace').exists()).toBe(false)
    const without = mountWithSite(BoardShell, { props: { part: 'LB-01', name: 'n', state: 'live' } })
    expect(without.find('.trace').exists()).toBe(false)
  })

  it('has a main column and a side column that is a labelled landmark', () => {
    const wrapper = mountWithSite(defineComponent({
      render: () => h(BoardShell, { part: 'LB-01', name: 'n', state: 'live' }, { default: () => h('p', { id: 'm' }, 'main'), aside: () => h('p', { id: 's' }, 'side') }),
    }))
    expect(wrapper.find('.main #m').exists()).toBe(true)
    expect(wrapper.get('aside').attributes('aria-label')).toBe('Limits and trace of the run')
    expect(wrapper.find('aside #s').exists()).toBe(true)
  })
})

describe('BoardLimitsPanel', () => {
  const limits = [{ label: 'Tickets per visitor per day', value: '20' }, { label: 'Visitor data kept', value: '24 h' }]
  const resetsAt = '2026-10-03T00:00:00.000Z'
  const now = Date.parse('2026-10-02T18:40:00.000Z')
  const quota = { limit: TICKETS_PER_DAY, used: 6, remaining: 14, resetsAt }

  it('shows what is left of the day and when it starts again', () => {
    const wrapper = mountWithSite(BoardLimitsPanel, { props: { limits, quota, quotaLabel: 'Tickets left today', brief: false, now } })
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('14 of 20')
    expect(wrapper.text()).toContain('Starts again in 5 h 20 min, at 00:00 UTC.')
  })

  it('draws the bar from what is left', () => {
    const wrapper = mountWithSite(BoardLimitsPanel, { props: { limits, quota, quotaLabel: 'Tickets left today', brief: false, now } })
    expect(wrapper.get('.fill').attributes('style')).toContain('width: 70%')
    expect(wrapper.get('.meter').attributes('aria-hidden')).toBe('true')
  })

  it('says so when none is left', () => {
    const wrapper = mountWithSite(BoardLimitsPanel, { props: { limits, quota: { ...quota, used: 20, remaining: 0 }, quotaLabel: 'x', brief: false, now } })
    expect(wrapper.text()).toContain('None left today.')
  })

  it('says it is counting before it knows', () => {
    const wrapper = mountWithSite(BoardLimitsPanel, { props: { limits, quota: undefined, quotaLabel: 'Tickets left today', brief: false } })
    expect(wrapper.text()).toContain('Counting…')
    expect(wrapper.find('.meter').exists()).toBe(false)
  })

  it('lists the datasheet\'s limits in the Technical reading and leaves them out of the Brief', () => {
    const technical = mountWithSite(BoardLimitsPanel, { props: { limits, quota, quotaLabel: 'x', brief: false, now } })
    expect(technical.findAll('tbody tr')).toHaveLength(2)
    expect(technical.text()).toContain('Tickets per visitor per day')
    const brief = mountWithSite(BoardLimitsPanel, { props: { limits, quota, quotaLabel: 'x', brief: true, now } })
    expect(brief.find('table').exists()).toBe(false)
    expect(brief.get('[data-testid="quota"]').text()).toContain('14 of 20')
  })

  it('counts in Czech', () => {
    const wrapper = mountWithSite(BoardLimitsPanel, { locale: 'cs', props: { limits, quota, quotaLabel: 'Zbývající požadavky dnes', brief: true, now } })
    expect(wrapper.get('[data-testid="quota"]').text()).toMatch(/14 z\s20/)
    expect(wrapper.text()).toMatch(/o\spůlnoci UTC/)
  })
})

describe('BoardNotice', () => {
  const kinds = ['unavailable', 'verification', 'quota', 'rejected', 'notFound', 'conflict', 'upstream', 'timeout', 'network', 'unknown'] as const

  it.each(kinds)('has words of its own for a %s failure, in both languages', (kind) => {
    const english = mountWithSite(BoardNotice, { props: { kind } })
    const czech = mountWithSite(BoardNotice, { locale: 'cs', props: { kind } })
    expect(english.get('.title').text()).not.toBe('')
    expect(czech.get('.title').text()).not.toBe('')
    expect(english.get('.title').text()).not.toBe(czech.get('.title').text())
    expect(english.text()).not.toContain('board.notice')
  })

  it('announces a failure to act on as an alert and a state to know about politely', () => {
    expect(mountWithSite(BoardNotice, { props: { kind: 'upstream' } }).get('[data-testid="notice"]').attributes('role')).toBe('alert')
    expect(mountWithSite(BoardNotice, { props: { kind: 'network' } }).get('[data-testid="notice"]').attributes('role')).toBe('alert')
    expect(mountWithSite(BoardNotice, { props: { kind: 'quota' } }).get('[data-testid="notice"]').attributes('role')).toBe('status')
    expect(mountWithSite(BoardNotice, { props: { kind: 'unavailable' } }).get('[data-testid="notice"]').attributes('role')).toBe('status')
  })

  it('says when the allowance starts again, in UTC', () => {
    const wrapper = mountWithSite(BoardNotice, { props: { kind: 'quota', resetsAt: '2026-10-03T00:00:00.000Z' } })
    expect(wrapper.text()).toContain('It starts again at')
    expect(wrapper.text()).toContain('UTC')
  })

  it('shows what the system said was wrong only for a refused input', () => {
    expect(mountWithSite(BoardNotice, { props: { kind: 'rejected', detail: 'The ticket is too long.' } }).text()).toContain('The ticket is too long.')
    expect(mountWithSite(BoardNotice, { props: { kind: 'upstream', detail: 'Traceback (most recent call last)' } }).text()).not.toContain('Traceback')
  })

  it('draws a button the board gives it', () => {
    const wrapper = mountWithSite(defineComponent({
      render: () => h(BoardNotice, { kind: 'network' }, { default: () => h('button', { type: 'button' }, 'Try again') }),
    }))
    expect(wrapper.get('button').text()).toBe('Try again')
  })
})

describe('BoardReplayBanner', () => {
  it('says plainly that this is a recording, when it was made and that it costs nothing', () => {
    const wrapper = mountWithSite(BoardReplayBanner, { props: { recording: recordLb01Sample({ origin: 'live' }), playing: false, canRunLive: true } })
    expect(wrapper.text()).toContain('Replay of a recorded run')
    expect(wrapper.text()).toContain('This is a recording of a real run, made on')
    expect(wrapper.text()).toContain('Oct 2, 2026')
    expect(wrapper.text()).toContain('none of your allowance is used')
  })

  it('says so when the recording came from the test mock', () => {
    const wrapper = mountWithSite(BoardReplayBanner, { props: { recording: recordLb01Sample({ origin: 'mock' }), playing: false, canRunLive: true } })
    expect(wrapper.text()).toContain('from the test mock')
    expect(wrapper.text()).toContain('It is not a real run')
  })

  it('offers to replay it and to run it live, and reports the choice', async () => {
    const wrapper = mountWithSite(BoardReplayBanner, { props: { recording: recordLb01Sample(), playing: false, canRunLive: true } })
    const [again, live] = wrapper.findAll('button')
    await again?.trigger('click')
    await live?.trigger('click')
    expect(wrapper.emitted('again')).toHaveLength(1)
    expect(wrapper.emitted('live')).toHaveLength(1)
  })

  it('cannot be replayed while it plays, and offers no live run on a deployment without a back end', () => {
    const wrapper = mountWithSite(BoardReplayBanner, { props: { recording: recordLb01Sample(), playing: true, canRunLive: false } })
    expect(wrapper.findAll('button')).toHaveLength(1)
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
  })
})

describe('BoardSamplePicker', () => {
  const samples = [
    { id: 'torn-bag', title: 'Torn bag', note: 'A damaged delivery.', language: 'en' as const, excerpt: 'Hi, my order' },
    { id: 'stale-decaf', title: 'Stale decaf', note: 'A Czech ticket.', language: 'cs' as const, excerpt: 'Dobrý den' },
  ]

  it('is a group of radio buttons named by its legend', () => {
    const wrapper = mountWithSite(BoardSamplePicker, { props: { samples, recorded: ['torn-bag'], legend: 'Choose a sample', modelValue: 'torn-bag' } })
    expect(wrapper.get('legend').text()).toBe('Choose a sample')
    const radios = wrapper.findAll('input[type="radio"]')
    expect(radios).toHaveLength(2)
    expect((radios[0]?.element as HTMLInputElement).checked).toBe(true)
    expect(radios[0]?.attributes('aria-describedby')).toBe('sample-torn-bag-about')
  })

  it('says which samples have a recording and which do not, in words', () => {
    const wrapper = mountWithSite(BoardSamplePicker, { props: { samples, recorded: ['torn-bag'], legend: 'x', modelValue: undefined } })
    const states = wrapper.findAll('.state').map(item => item.text())
    expect(states).toEqual(['Recording available', 'No recording yet'])
  })

  it('says it is looking while the list of recordings is not known', () => {
    const wrapper = mountWithSite(BoardSamplePicker, { props: { samples, recorded: undefined, legend: 'x', modelValue: undefined } })
    expect(wrapper.findAll('.state').map(item => item.text())).toEqual(['Looking for a recording…', 'Looking for a recording…'])
  })

  it('keeps each card short and reads what the sample shows and says as the radio button\'s description', () => {
    const wrapper = mountWithSite(BoardSamplePicker, { props: { samples, recorded: [], legend: 'x', modelValue: undefined } })
    const description = wrapper.get('#sample-torn-bag-about')
    expect(description.text()).toBe('A damaged delivery. Hi, my order')
    expect(description.classes()).toContain('lb-sr-only')
    expect(wrapper.get('.choice').text()).not.toContain('A damaged delivery.')
    expect(wrapper.get('.choice').element.contains(description.element)).toBe(false)
  })

  it('reports the sample chosen and starts nothing by itself', async () => {
    const wrapper = mountWithSite(BoardSamplePicker, { props: { samples, recorded: [], legend: 'x', modelValue: 'torn-bag' } })
    await wrapper.findAll('input[type="radio"]')[1]?.setValue(true)
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['stale-decaf'])
    expect(wrapper.findAll('button')).toHaveLength(0)
  })

  it('marks the language each sample is written in', () => {
    const wrapper = mountWithSite(BoardSamplePicker, { props: { samples, recorded: [], legend: 'x', modelValue: undefined } })
    expect(wrapper.findAll('.lang').map(item => item.text())).toEqual(['EN', 'CS'])
  })
})
