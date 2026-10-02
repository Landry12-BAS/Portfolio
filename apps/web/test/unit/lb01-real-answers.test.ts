// Unit tests against answers the real Django API and the real gateway gave, word for word, so the
// board is held to what the services actually say and not only to the mock's idea of it. They were
// captured on 2026-10-02 from the real LB-01 API (services/django-systems), the real gateway's trace
// route and the real tracer's spans, with the pipeline run by the Django tests' fake models: the
// shapes, the field values and the timings' kinds are the services', and the draft sentences were
// written by a test script, not by a model. A change to the API that these files no longer fit is
// exactly what they are here to catch; recapture them from a running stack to update them.
import { tracePageSchema } from '@lb/contracts'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { findSystemIn } from '#shared/data/datasheets'

import { buildTimeline } from '~/board-kit/timeline'
import { pipelineSteps } from '~/boards/lb-01/pipeline'
import { ticketSchema } from '~/boards/lb-01/schemas'
import { TICKET_POLL_MS, useLb01Store } from '~/boards/lb-01/store'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import awaitingApproval from '../fixtures/django/ticket-awaiting-approval.json'
import awaitingApprovalCzech from '../fixtures/django/ticket-awaiting-approval-cs.json'
import escalated from '../fixtures/django/ticket-escalated-injection.json'
import draftedTrace from '../fixtures/django/trace-of-a-drafted-run.json'
import escalatedTrace from '../fixtures/django/trace-of-an-escalated-run.json'
import { FakeSite } from '../support/fake-site'

// The answer to filing a ticket, as the real API gave it right after: the pipeline had not started.
const filed = {
  ...awaitingApproval,
  status: 'received',
  category: '',
  order_number: '',
  run_id: '',
  draft: null,
}

const chain = findSystemIn('lb-01', 'en')?.chain ?? []

describe('the real LB-01 API\'s answers', () => {
  it('fit the board\'s ticket schema: a ticket just filed, one waiting for approval in English and in Czech, and one handed to a person', () => {
    for (const answer of [filed, awaitingApproval, awaitingApprovalCzech, escalated]) {
      const parsed = ticketSchema.safeParse(answer)
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    }
  })

  it('name the run only when the pipeline has finished', () => {
    expect(filed.run_id).toBe('')
    expect(awaitingApproval.run_id).toMatch(/^[\w-]{8,64}$/)
    expect(escalated.run_id).toMatch(/^[\w-]{8,64}$/)
  })

  it('mark the sentence no source supports, with the reason the claim check gave', () => {
    const flagged = awaitingApproval.draft.sentences.filter(sentence => !sentence.supported)
    expect(flagged).toEqual([{ text: 'We will refund you today.', citations: [], supported: false, problem: 'states a fact without citing a source' }])
    expect(awaitingApproval.draft.claims_supported).toBe(false)
    expect(awaitingApproval.draft.sources.map(source => source.id)).toEqual(['order:BB-1040', 'passage:damaged.torn-bags'])
  })

  it('hand a ticket the injection screen flagged to a person, with no draft', () => {
    expect(escalated).toMatchObject({ status: 'escalated', escalation_reason: 'injection', draft: null, decision: null })
  })
})

describe('the real gateway\'s trace of a real run', () => {
  it('fits the trace page schema, and the Scope draws it as a run with its nine steps inside', () => {
    const page = tracePageSchema.parse(draftedTrace)
    const timeline = buildTimeline(page.spans)

    expect(page).toMatchObject({ more: false, finished: true })
    expect(timeline.rows[0]?.span.name).toBe('support ticket')
    expect(timeline.rows.map(row => row.depth)).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1, 1])
    expect(timeline.summary).toMatchObject({ steps: 9, modelCalls: 0 })
    expect(timeline.open).toBe(false)
  })

  it('marks all nine steps of a run that drafted as done', () => {
    const page = tracePageSchema.parse(draftedTrace)

    expect(pipelineSteps(chain, page.spans, true).map(step => step.state)).toEqual(Array.from({ length: 9 }, () => 'done'))
  })

  it('marks the steps a ticket handed to a person never reached as skipped', () => {
    const page = tracePageSchema.parse(escalatedTrace)

    expect(pipelineSteps(chain, page.spans, true).map(step => step.state)).toEqual(['done', 'done', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'done'])
  })
})

describe('the board\'s store, given the real answers one after another', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('waits for the trace while the ticket is worked on, then reads the real trace once the ticket names the run', async () => {
    const site = new FakeSite({ verified: true })
    vi.stubGlobal('fetch', site.fetch)
    vi.stubGlobal('location', new URL('http://site.test/'))
    setActivePinia(createPinia())
    const store = useLb01Store()
    await useSessionStore().load()
    const scope = useScopeStore()

    // Filing, then one read while the worker has it, then the finished ticket, then the trace.
    site.failNext('POST /api/lb01/tickets', { status: 202, body: filed })
    site.failNext('GET /api/lb01/tickets/', { status: 200, body: { ...filed, status: 'processing' } })
    site.failNext('GET /api/lb01/tickets/', { status: 200, body: awaitingApproval })
    site.failNext('GET /api/runs/', { status: 200, body: draftedTrace })

    await store.file({ customer: 'cus-0001', language: 'en', body: awaitingApproval.body })
    expect(store.ticket?.run_id).toBe('')
    expect(scope.phase).toBe('waiting')

    await vi.advanceTimersByTimeAsync(TICKET_POLL_MS)
    expect(store.ticket?.status).toBe('processing')
    expect(scope.phase).toBe('waiting')

    await vi.advanceTimersByTimeAsync(TICKET_POLL_MS + 2_000)
    expect(store.ticket?.status).toBe('awaiting_approval')
    expect(store.canDecide).toBe(true)
    expect(scope.runId).toBe(awaitingApproval.run_id)
    expect(scope.phase).toBe('finished')
    expect(scope.timeline.rows).toHaveLength(10)
  })
})
