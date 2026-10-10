// Component tests for LB-01's board parts: the pipeline's steps, the cited draft (with a failed
// claim marked in words), the agent console and its decisions, the composer and the counters, in
// English and in Czech. The tickets come from the in-memory mock, so their drafts have the shapes
// the real API's have.
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'

import AgentConsole from '~/boards/lb-01/components/AgentConsole.vue'
import DraftView from '~/boards/lb-01/components/DraftView.vue'
import PipelineSteps from '~/boards/lb-01/components/PipelineSteps.vue'
import StatsCounters from '~/boards/lb-01/components/StatsCounters.vue'
import TicketComposer from '~/boards/lb-01/components/TicketComposer.vue'
import { ApiProblem } from '~/board-kit/problem'
import { LB01_SAMPLES } from '#shared/data/samples/lb01'

import { mountWithSite } from '../support/mount'
import { makeCzechTicket, makeEscalatedTicket, makeTicket, makeTicketWithUnsupportedClaim } from '../support/tickets'

describe('PipelineSteps', () => {
  const steps = [
    { label: 'redact PII', state: 'done' as const },
    { label: 'screen for injection', state: 'running' as const },
    { label: 'classify', state: 'waiting' as const },
    { label: 'route', state: 'skipped' as const },
    { label: 'check claims', state: 'failed' as const },
  ]

  it('lists the steps in order, each with its state written in words', () => {
    const wrapper = mountWithSite(PipelineSteps, { props: { steps } })
    const rows = wrapper.findAll('[data-testid="pipeline-step"]')
    expect(rows.map(row => row.get('.label').text())).toEqual(steps.map(step => step.label))
    expect(rows.map(row => row.get('.state').text())).toEqual(['done', 'running', 'waiting', 'skipped', 'failed'])
    expect(rows.map(row => row.attributes('data-state'))).toEqual(['done', 'running', 'waiting', 'skipped', 'failed'])
    expect(wrapper.get('ol').attributes('aria-label')).toBe('Steps of the ticket pipeline')
  })

  it('writes the states in Czech', () => {
    const wrapper = mountWithSite(PipelineSteps, { locale: 'cs', props: { steps } })
    expect(wrapper.findAll('.state').map(item => item.text())).toEqual(['hotovo', 'běží', 'čeká', 'přeskočeno', 'selhalo'])
  })
})

describe('DraftView', () => {
  it('shows each sentence with numbered links to the sources it cites', () => {
    const ticket = makeTicket()
    const wrapper = mountWithSite(DraftView, { props: { draft: ticket.draft!, language: 'en' } })
    const sentences = wrapper.findAll('[data-testid="draft-sentence"]')
    expect(sentences).toHaveLength(ticket.draft!.sentences.length)
    const link = sentences[0]?.get('a.cite')
    expect(link?.text()).toBe('[1]')
    expect(link?.attributes('href')).toBe('#source-1')
    expect(link?.attributes('aria-label')).toBe('Cites source 1')
  })

  it('lists the sources as cards with their title and text, numbered to match', () => {
    const ticket = makeTicket()
    const wrapper = mountWithSite(DraftView, { props: { draft: ticket.draft!, language: 'en' } })
    const cards = wrapper.findAll('[data-testid="source-card"]')
    expect(cards).toHaveLength(ticket.draft!.sources.length)
    expect(cards[0]?.attributes('id')).toBe('source-1')
    expect(cards[0]?.text()).toContain('Source 1')
    expect(cards[0]?.text()).toContain(ticket.draft!.sources[0]!.title)
    expect(cards[0]?.text()).toContain(ticket.draft!.sources[0]!.text)
  })

  it('says every sentence is supported when the claim check accepted them all', () => {
    const wrapper = mountWithSite(DraftView, { props: { draft: makeTicket().draft!, language: 'en' } })
    expect(wrapper.get('[data-testid="claim-check"]').text()).toContain('every sentence is supported')
    expect(wrapper.find('mark').exists()).toBe(false)
  })

  it('marks a sentence the check did not accept, in words and with its reason, not by colour alone', () => {
    const wrapper = mountWithSite(DraftView, { props: { draft: makeTicketWithUnsupportedClaim().draft!, language: 'en' } })
    expect(wrapper.get('[data-testid="claim-check"]').text()).toContain('some sentences are not supported')
    const flagged = wrapper.findAll('[data-supported="false"]')
    expect(flagged).toHaveLength(1)
    expect(flagged[0]?.get('mark').text()).toBe('We will refund you today.')
    expect(flagged[0]?.text()).toContain('Not supported')
    expect(flagged[0]?.text()).toContain('No source says a refund is promised.')
    expect(flagged[0]?.text()).toContain('no source cited')
  })

  it('marks the draft and the sources with the ticket\'s language, and the flag with the page\'s', () => {
    const ticket = makeCzechTicket()
    const wrapper = mountWithSite(DraftView, { props: { draft: ticket.draft!, language: 'cs' } })
    expect(wrapper.get('ol.sentences').attributes('lang')).toBe('cs')
    expect(wrapper.get('ol.source-list').attributes('lang')).toBe('cs')
    expect(ticket.draft!.sources.at(-1)!.text).toMatch(/[ěščřžýáíé]/)
  })

  it('sets Czech content the way the site sets Czech text, and leaves other languages alone', () => {
    const sentences = [{ text: 'Zboží je v balíku a k němu patří doklad.', citations: [], supported: true, problem: null }]
    const draft = { ...makeTicket().draft!, sentences }
    const czech = mountWithSite(DraftView, { props: { draft, language: 'cs' } })
    expect(czech.get('[data-testid="draft-sentence"]').text()).toContain('v\u00A0balíku a\u00A0k\u00A0němu')
    const english = mountWithSite(DraftView, { props: { draft: { ...draft, sentences: [{ ...sentences[0]!, text: 'A bag is in a box.' }] }, language: 'en' } })
    expect(english.get('[data-testid="draft-sentence"]').text()).toContain('A bag is in a box.')
  })

  it('shows a citation that names no listed source as unknown, not as a link', () => {
    const draft = { ...makeTicket().draft!, sentences: [{ text: 'A claim.', citations: ['passage:nonexistent'], supported: true, problem: null }] }
    const wrapper = mountWithSite(DraftView, { props: { draft, language: 'en' } })
    expect(wrapper.find('a.cite').exists()).toBe(false)
    expect(wrapper.get('.cite--missing').text()).toBe('[?]')
  })

  it('shows the model\'s text as text and never as markup', () => {
    const draft = { ...makeTicket().draft!, sentences: [{ text: '<img src=x onerror=alert(1)> **bold**', citations: [], supported: false, problem: '<script>alert(2)</script>' }] }
    const wrapper = mountWithSite(DraftView, { props: { draft, language: 'en' } })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)> **bold**')
    expect(wrapper.text()).toContain('<script>alert(2)</script>')
  })
})

describe('AgentConsole', () => {
  const idle = { canDecide: false, replay: false, deciding: false, decisionProblem: undefined, working: false }

  it('says what it will show before there is a ticket, and that the pipeline is working while it is', () => {
    expect(mountWithSite(AgentConsole, { props: { ...idle, ticket: undefined } }).text()).toContain('appear here once the pipeline has finished')
    expect(mountWithSite(AgentConsole, { props: { ...idle, ticket: makeTicket({ stage: 'processing' }), working: true } }).get('[role="status"]').text()).toContain('The pipeline is working on the ticket.')
  })

  it('shows who wrote what, the category, the order and where the ticket stands', () => {
    const ticket = makeTicket()
    const wrapper = mountWithSite(AgentConsole, { props: { ...idle, ticket } })
    expect(wrapper.text()).toContain(ticket.customer.name)
    expect(wrapper.text()).toContain('Damaged, stale or faulty item')
    expect(wrapper.text()).toContain('BB-1040')
    expect(wrapper.get('[data-testid="ticket-status"]').text()).toBe('Waiting for approval')
    expect(wrapper.get('[data-testid="ticket-body"]').text()).toContain('ripped open')
    expect(wrapper.get('[data-testid="ticket-body"]').attributes('lang')).toBe('en')
    expect(wrapper.text()).toContain('Deleted after')
  })

  it('offers approve, edit and escalate on a live draft, and says nothing is sent', async () => {
    const wrapper = mountWithSite(AgentConsole, { props: { ...idle, ticket: makeTicket(), canDecide: true } })
    const buttons = wrapper.findAll('.buttons button')
    expect(buttons.map(button => button.text())).toEqual(['Approve', 'Edit', 'Escalate'])
    expect(wrapper.text()).toContain('Auto-send is off for visitors')
    await buttons[0]?.trigger('click')
    await buttons[2]?.trigger('click')
    expect(wrapper.emitted('decide')).toEqual([['approve'], ['escalate']])
  })

  it('opens an editor with the draft in it, focuses it, and records the edited text', async () => {
    const ticket = makeTicket()
    const wrapper = mountWithSite(AgentConsole, { props: { ...idle, ticket, canDecide: true } })
    await wrapper.findAll('.buttons button')[1]?.trigger('click')
    await nextTick()
    const box = wrapper.get('textarea')
    expect((box.element as HTMLTextAreaElement).value).toBe(ticket.draft!.sentences.map(sentence => sentence.text).join(' '))
    expect(document.activeElement).toBe(box.element)
    expect(wrapper.get('label').attributes('for')).toBe('lb01-edit')
    await box.setValue('  My own reply.  ')
    await wrapper.findAll('.buttons button')[0]?.trigger('click')
    expect(wrapper.emitted('decide')).toEqual([['edit', 'My own reply.']])
  })

  it('does not record an empty edit, and can cancel the editor', async () => {
    const wrapper = mountWithSite(AgentConsole, { props: { ...idle, ticket: makeTicket(), canDecide: true } })
    await wrapper.findAll('.buttons button')[1]?.trigger('click')
    await wrapper.get('textarea').setValue('   ')
    const [send, cancel] = wrapper.findAll('.buttons button')
    expect(send?.attributes('disabled')).toBeDefined()
    await cancel?.trigger('click')
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.emitted('decide')).toBeUndefined()
  })

  it('disables the buttons while a decision is being recorded', () => {
    const wrapper = mountWithSite(AgentConsole, { props: { ...idle, ticket: makeTicket(), canDecide: true, deciding: true } })
    expect(wrapper.findAll('.buttons button').every(button => button.attributes('disabled') !== undefined)).toBe(true)
  })

  it('offers no decision in a replay and says why', () => {
    const wrapper = mountWithSite(AgentConsole, { props: { ...idle, ticket: makeTicket(), replay: true } })
    expect(wrapper.find('.buttons').exists()).toBe(false)
    expect(wrapper.text()).toContain('This is a replay, so there is no ticket to decide on.')
  })

  it('shows a recorded decision and the reply that was recorded', () => {
    const decided = { ...makeTicket(), status: 'sent' as const, decision: { action: 'edit', final_text: 'My own reply.', decided_at: '2026-10-02T09:31:00.000Z' } }
    const wrapper = mountWithSite(AgentConsole, { props: { ...idle, ticket: decided } })
    expect(wrapper.get('[data-testid="decision"]').text()).toContain('Edited and approved')
    expect(wrapper.get('[data-testid="decision"]').text()).toContain('My own reply.')
    expect(wrapper.find('.buttons').exists()).toBe(false)
  })

  it('says why no draft was written when the ticket was handed to a person', () => {
    const wrapper = mountWithSite(AgentConsole, { props: { ...idle, ticket: makeEscalatedTicket() } })
    expect(wrapper.get('[data-testid="handoff"]').text()).toContain('The injection screen flagged this ticket')
    expect(wrapper.find('[data-testid="claim-check"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="ticket-status"]').text()).toBe('Escalated')
  })

  it('says a step of the pipeline failed when it crashed and left the ticket failed with no reason written', () => {
    const crashed = { ...makeTicket({ stage: 'received' }), status: 'failed' as const }
    const wrapper = mountWithSite(AgentConsole, { props: { ...idle, ticket: crashed } })
    expect(wrapper.get('[data-testid="handoff"]').text()).toContain('A step of the pipeline failed')
    expect(wrapper.get('[data-testid="ticket-status"]').text()).toBe('Pipeline failed')
  })

  it('shows what went wrong with a decision', () => {
    const wrapper = mountWithSite(AgentConsole, { props: { ...idle, ticket: makeTicket(), canDecide: true, decisionProblem: new ApiProblem(409, 'not_waiting', 'x') } })
    expect(wrapper.get('[data-testid="notice"]').attributes('data-kind')).toBe('conflict')
  })

  it('speaks Czech, with the ticket in its own language', () => {
    const ticket = makeCzechTicket()
    const wrapper = mountWithSite(AgentConsole, { locale: 'cs', props: { ...idle, ticket, canDecide: true } })
    expect(wrapper.text()).toContain('Konzole agenta')
    expect(wrapper.get('[data-testid="ticket-status"]').text()).toBe('Čeká na schválení')
    expect(wrapper.get('[data-testid="ticket-body"]').attributes('lang')).toBe('cs')
    expect(wrapper.findAll('.buttons button').map(button => button.text())).toEqual(['Schválit', 'Upravit', 'Eskalovat'])
  })
})

describe('TicketComposer', () => {
  const customers = [
    { key: 'cus-0001', name: 'Anna Nováková', language: 'cs' },
    { key: 'cus-0002', name: 'Tom Smith', language: 'en' },
  ]
  const samples = LB01_SAMPLES.map(sample => ({ id: sample.id, title: sample.id, note: 'note', language: sample.language, excerpt: sample.body }))
  const bodies = Object.fromEntries(LB01_SAMPLES.map(sample => [sample.id, sample.body]))
  const props = { samples, recorded: [] as string[], customers, busy: false, canRunLive: true, allowanceUsedUp: false, customersFailed: false, defaultLanguage: 'en' as const, bodies }

  it('opens on the curated samples, with the first chosen, its text shown and what it is there to show', () => {
    const wrapper = mountWithSite(TicketComposer, { props })
    expect(wrapper.findAll('input[type="radio"]')).toHaveLength(LB01_SAMPLES.length)
    expect(wrapper.get('blockquote').text()).toBe(LB01_SAMPLES[0]!.body)
    expect(wrapper.get('.shows').text()).toBe('note')
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('replays a sample that has a recording, for free', async () => {
    const wrapper = mountWithSite(TicketComposer, { props: { ...props, recorded: ['torn-bag'] } })
    const button = wrapper.get('[data-testid="start-sample"]')
    expect(button.text()).toBe('Replay this sample')
    expect(wrapper.find('[data-testid="no-recording"]').exists()).toBe(false)
    await button.trigger('click')
    expect(wrapper.emitted('replay')).toEqual([['torn-bag']])
    expect(wrapper.emitted('runSample')).toBeUndefined()
  })

  it('says so when a sample has no recording, and offers the live run with its cost', async () => {
    const wrapper = mountWithSite(TicketComposer, { props })
    expect(wrapper.get('[data-testid="no-recording"]').text()).toContain('There is no recording of this sample yet')
    expect(wrapper.get('[data-testid="no-recording"]').text()).toContain('uses one of your tickets today')
    const button = wrapper.get('[data-testid="start-sample"]')
    expect(button.text()).toBe('Run this sample live')
    await button.trigger('click')
    expect(wrapper.emitted('runSample')).toEqual([['torn-bag']])
  })

  it('offers the live run as well as the replay when a recording exists', async () => {
    const wrapper = mountWithSite(TicketComposer, { props: { ...props, recorded: ['torn-bag'] } })
    await wrapper.get('[data-testid="run-sample-live"]').trigger('click')
    expect(wrapper.emitted('runSample')).toEqual([['torn-bag']])
  })

  it('waits until it knows whether the samples have recordings', () => {
    const wrapper = mountWithSite(TicketComposer, { props: { ...props, recorded: undefined } })
    expect(wrapper.get('[data-testid="start-sample"]').attributes('disabled')).toBeDefined()
  })

  it('cannot run anything live where there is no back end or no ticket left, but can still replay', () => {
    const wrapper = mountWithSite(TicketComposer, { props: { ...props, recorded: ['torn-bag'], canRunLive: false } })
    expect(wrapper.get('[data-testid="start-sample"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="run-sample-live"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('cannot run tickets live right now')
    const none = mountWithSite(TicketComposer, { props: { ...props, canRunLive: false } })
    expect(none.get('[data-testid="start-sample"]').attributes('disabled')).toBeDefined()
  })

  it('says the day\'s tickets are used up, and does not blame the site, when that is why a live run is off', async () => {
    const wrapper = mountWithSite(TicketComposer, { props: { ...props, recorded: ['torn-bag'], canRunLive: false, allowanceUsedUp: true } })
    expect(wrapper.get('[data-testid="live-hint"]').text()).toContain('Today\'s tickets are used up')
    expect(wrapper.text()).not.toContain('cannot run tickets live right now')
    await wrapper.findAll('.lb-seg__btn')[1]?.trigger('click')
    expect(wrapper.get('[data-testid="live-hint"]').text()).toContain('Today\'s tickets are used up')
    expect(wrapper.get('[data-testid="file-ticket"]').attributes('disabled')).toBeDefined()

    const czech = mountWithSite(TicketComposer, { locale: 'cs', props: { ...props, canRunLive: false, allowanceUsedUp: true, defaultLanguage: 'cs' } })
    expect(czech.get('[data-testid="live-hint"]').text()).toContain('Dnešní požadavky jsou vyčerpané')
  })

  it('shows no hint while a live run is possible', () => {
    const wrapper = mountWithSite(TicketComposer, { props })
    expect(wrapper.find('[data-testid="live-hint"]').exists()).toBe(false)
  })

  it('files the visitor\'s own ticket as a chosen customer, in a chosen language', async () => {
    const wrapper = mountWithSite(TicketComposer, { props })
    await wrapper.findAll('.lb-seg__btn')[1]?.trigger('click')
    expect(wrapper.find('form').exists()).toBe(true)
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('cus-0001')
    await wrapper.get('select').setValue('cus-0002')
    await wrapper.get('textarea').setValue('  My coffee machine leaks.  ')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('file')).toEqual([[{ customer: 'cus-0002', language: 'en', body: 'My coffee machine leaks.' }]])
  })

  it('labels its fields, counts what was typed and limits it to what the API accepts', async () => {
    const wrapper = mountWithSite(TicketComposer, { props })
    await wrapper.findAll('.lb-seg__btn')[1]?.trigger('click')
    expect(wrapper.get('label[for="lb01-customer"]').text()).toBe('Customer')
    expect(wrapper.get('label[for="lb01-body"]').text()).toBe('What the customer writes')
    expect(wrapper.get('textarea').attributes('maxlength')).toBe('2000')
    await wrapper.get('textarea').setValue('Hello')
    expect(wrapper.get('.count').text()).toBe('5 of 2000')
  })

  it('does not file an empty ticket, or while another is running, or without a back end', async () => {
    const wrapper = mountWithSite(TicketComposer, { props })
    await wrapper.findAll('.lb-seg__btn')[1]?.trigger('click')
    expect(wrapper.get('[data-testid="file-ticket"]').attributes('disabled')).toBeDefined()
    await wrapper.get('textarea').setValue('Hello')
    expect(wrapper.get('[data-testid="file-ticket"]').attributes('disabled')).toBeUndefined()
    await wrapper.setProps({ busy: true })
    expect(wrapper.get('[data-testid="file-ticket"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="file-ticket"]').text()).toBe('Filing the ticket…')
    await wrapper.setProps({ busy: false, canRunLive: false })
    expect(wrapper.get('[data-testid="file-ticket"]').attributes('disabled')).toBeDefined()
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('file')).toBeUndefined()
  })

  it('says the customers could not be loaded, in the form where they would be chosen', async () => {
    const wrapper = mountWithSite(TicketComposer, { props: { ...props, customers: [], customersFailed: true } })
    expect(wrapper.find('[data-testid="no-customers"]').exists()).toBe(false)
    await wrapper.findAll('.lb-seg__btn')[1]?.trigger('click')
    expect(wrapper.get('[data-testid="no-customers"]').text()).toContain('could not be loaded')
    expect(wrapper.get('[data-testid="file-ticket"]').attributes('disabled')).toBeDefined()
  })

  it('starts the language in the site\'s language, and says what is done with the text', async () => {
    const wrapper = mountWithSite(TicketComposer, { locale: 'cs', props: { ...props, defaultLanguage: 'cs' } })
    await wrapper.findAll('.lb-seg__btn')[1]?.trigger('click')
    await wrapper.get('textarea').setValue('Dobrý den')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('file')?.[0]?.[0]).toMatchObject({ language: 'cs' })
    expect(wrapper.text()).toContain('skrytím osobních údajů')
  })
})

describe('StatsCounters', () => {
  const stats = { tickets: 4, awaiting_approval: 1, sent: 2, sent_unedited: 1, escalated: 1, deflection: 0.6667, accuracy: 0.5 }

  it('shows the visitor\'s counters and what deflection and accuracy count', () => {
    const wrapper = mountWithSite(StatsCounters, { props: { stats } })
    expect(wrapper.get('[data-testid="deflection"]').text()).toBe('67%')
    expect(wrapper.get('[data-testid="accuracy"]').text()).toBe('50%')
    expect(wrapper.text()).toContain('The share of decided tickets answered with the draft')
    expect(wrapper.text()).toContain('The share of recorded replies that were approved without an edit')
  })

  it('says "no data yet" for a share with nothing to count, never zero', () => {
    const wrapper = mountWithSite(StatsCounters, { props: { stats: { ...stats, deflection: null, accuracy: null } } })
    expect(wrapper.get('[data-testid="deflection"]').text()).toBe('no data yet')
    expect(wrapper.get('[data-testid="accuracy"]').text()).toBe('no data yet')
  })

  it('invites the visitor to file a ticket before there is anything to count', () => {
    expect(mountWithSite(StatsCounters, { props: { stats: undefined } }).text()).toContain('appear once you file a ticket')
  })

  it('writes the percentages the Czech way', () => {
    const wrapper = mountWithSite(StatsCounters, { locale: 'cs', props: { stats } })
    expect(wrapper.get('[data-testid="deflection"]').text()).toMatch(/67\s%/)
  })
})
