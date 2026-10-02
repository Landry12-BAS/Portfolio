// Unit tests for the Scope store: it follows a live run by polling the trace route (a run's
// first spans appear a moment after it starts, its root span comes last), gives up honestly when
// the trace stops arriving or never existed, and shows a replay's spans without polling anything.
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GIVE_UP_AFTER_MS } from '~/board-kit/follow'
import { useScopeStore } from '~/stores/scope'

import { FakeSite } from '../support/fake-site'
import { recordLb01Sample } from '../support/recording'

/**
 * Starts a fake site with a ticket already filed, and a fresh store reading through it. The site
 * names the run when the ticket is filed, since these tests follow a run from its start; the
 * board's tests cover a back end that names it only at the end.
 */
function start(options: ConstructorParameters<typeof FakeSite>[0] = {}) {
  const site = new FakeSite({ verified: true, runId: 'at-filing', ...options })
  vi.stubGlobal('fetch', site.fetch)
  setActivePinia(createPinia())
  const filed = site.mock.file('fake-session', { customer: 'cus-0001', language: 'en', body: 'Order BB-1040 arrived with a torn bag.' })
  const ticket = filed.body as { id: string, run_id: string }
  return { site, scope: useScopeStore(), ticket }
}

/** Moves the mock's pipeline on one step, as the board's own reads of the ticket do. */
function advance(site: FakeSite, ticketId: string): void {
  site.mock.get('fake-session', ticketId)
}

describe('the Scope store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('follows a run: nothing yet, then the first spans, then the root span, then it stops', async () => {
    const { site, scope, ticket } = start()
    scope.follow(ticket.run_id, { notFoundGraceMs: 10_000 })
    expect(scope.phase).toBe('following')

    // The ticket is only "received": the trace does not exist yet, which is not an error.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(scope.spans).toHaveLength(0)
    expect(scope.phase).toBe('following')

    advance(site, ticket.id)
    advance(site, ticket.id)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(scope.phase).toBe('finished')
    expect(scope.timeline.rows[0]?.span.name).toBe('support ticket')
    const reads = site.callsTo(`/api/runs/${ticket.run_id}/spans`).length

    // Finished means finished: no more reads.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(site.callsTo(`/api/runs/${ticket.run_id}/spans`)).toHaveLength(reads)
  })

  it('asks only for what is new, using the cursor the last page gave', async () => {
    const { site, scope, ticket } = start({ pollsToFinish: 3 })
    scope.follow(ticket.run_id, { notFoundGraceMs: 10_000 })
    advance(site, ticket.id)
    advance(site, ticket.id)
    await vi.advanceTimersByTimeAsync(700)
    expect(scope.phase).toBe('following')
    advance(site, ticket.id)
    await vi.advanceTimersByTimeAsync(2_000)
    const reads = site.callsTo(`/api/runs/${ticket.run_id}/spans`)
    expect(reads[0]?.path).not.toContain('after=')
    expect(reads.some(read => read.path.includes('after='))).toBe(true)
    expect(new Set(scope.spans.map(span => span.spanId)).size).toBe(scope.spans.length)
  })

  it('says the trace is missing for a run that has none, once the grace is over', async () => {
    const { scope } = start()
    scope.follow('run-doesnotexist00', { notFoundGraceMs: 1_000 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(scope.phase).toBe('missing')
  })

  it('says the trace is missing at once when no grace is asked for', async () => {
    const { scope, site } = start()
    scope.follow('run-doesnotexist00')
    await vi.advanceTimersByTimeAsync(500)
    expect(scope.phase).toBe('missing')
    expect(site.callsTo('/api/runs/run-doesnotexist00')).toHaveLength(1)
  })

  it('gives up with a stalled trace when the root span never arrives', async () => {
    const { site, scope, ticket } = start({ pollsToFinish: 3 })
    advance(site, ticket.id)
    advance(site, ticket.id)
    scope.follow(ticket.run_id, { notFoundGraceMs: 10_000 })
    await vi.advanceTimersByTimeAsync(GIVE_UP_AFTER_MS + 10_000)
    expect(scope.phase).toBe('stalled')
    expect(scope.spans.length).toBeGreaterThan(0)
    expect(scope.timeline.open).toBe(true)
  })

  it('gives up sooner once the board says the run is over', async () => {
    const { site, scope, ticket } = start({ pollsToFinish: 3 })
    advance(site, ticket.id)
    advance(site, ticket.id)
    scope.follow(ticket.run_id, { notFoundGraceMs: 10_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    scope.settle()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(scope.phase).toBe('stalled')
  })

  it('fails after three reads in a row that could not reach the site, and tries again before that', async () => {
    const { scope, ticket } = start()
    const fetchSpy = vi.fn(() => Promise.reject(new TypeError('offline')))
    vi.stubGlobal('fetch', fetchSpy)
    scope.follow(ticket.run_id)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(scope.phase).toBe('failed')
  })

  it('stops following the old run when a new one starts', async () => {
    const { site, scope, ticket } = start()
    scope.follow(ticket.run_id, { notFoundGraceMs: 60_000 })
    scope.follow('run-another000000', { notFoundGraceMs: 60_000 })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(site.callsTo(`/api/runs/${ticket.run_id}`)).toHaveLength(0)
    expect(scope.runId).toBe('run-another000000')
  })

  it('shows a replay\'s spans and does not read anything', async () => {
    const { site, scope } = start()
    const recording = recordLb01Sample()
    scope.showRecorded(recording.trace.runId, recording.trace.spans.slice(0, 3), false)
    expect(scope.replayed).toBe(true)
    expect(scope.phase).toBe('following')
    scope.showRecorded(recording.trace.runId, recording.trace.spans, true)
    expect(scope.phase).toBe('finished')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(site.callsTo('/api/runs/')).toHaveLength(0)
  })

  it('waits for a run the back end has not named, without reading anything', async () => {
    const { scope, site } = start()
    scope.wait()
    expect(scope).toMatchObject({ phase: 'waiting', runId: undefined })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(scope.phase).toBe('waiting')
    expect(site.callsTo('/api/runs/')).toHaveLength(0)
  })

  it('says a run that is over without ever being named has no trace', () => {
    const { scope } = start()
    scope.wait()
    scope.settle()
    expect(scope.phase).toBe('missing')
  })

  it('follows the run once it is named, and leaves a waiting Scope\'s state behind', async () => {
    const { site, scope, ticket } = start()
    scope.wait()
    advance(site, ticket.id)
    advance(site, ticket.id)
    scope.follow(ticket.run_id, { notFoundGraceMs: 10_000 })
    expect(scope.phase).toBe('following')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(scope.phase).toBe('finished')
  })

  describe('a trace with no root span, as a workflow run\'s is', () => {
    /** One step span of a run that has no span around its steps. */
    const stepSpan = { v: 1, runId: 'run-rootless000', system: 'lb-08', spanId: '00000000000000a1', kind: 'system.step', name: 'step.check_stock', status: 'ok', startMs: 1_000, endMs: 1_025, attrs: {} }

    /** Answers every read of the trace with the same page: the step span, never a root span. */
    function rootless() {
      const fetchSpy = vi.fn(() => Promise.resolve(Response.json({ runId: 'run-rootless000', spans: [stepSpan], cursor: '1-1', more: false, finished: false })))
      vi.stubGlobal('fetch', fetchSpy)
      return fetchSpy
    }

    it('keeps following it until the board says the run is over, then closes it as complete once a read brings nothing new', async () => {
      rootless()
      const scope = (setActivePinia(createPinia()), useScopeStore())
      scope.follow('run-rootless000', { notFoundGraceMs: 10_000 })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(scope.phase).toBe('following')
      expect(scope.spans).toHaveLength(1)

      scope.closeWhenQuiet()
      await vi.advanceTimersByTimeAsync(5_000)

      expect(scope.phase).toBe('finished')
    })

    it('does not close a trace that is still growing', async () => {
      let page = 0
      vi.stubGlobal('fetch', vi.fn(() => {
        page += 1
        return Promise.resolve(Response.json({ runId: 'run-rootless000', spans: [{ ...stepSpan, spanId: `00000000000000${String(page).padStart(2, '0')}`, name: `step.${page}` }], cursor: `1-${page}`, more: false, finished: false }))
      }))
      const scope = (setActivePinia(createPinia()), useScopeStore())
      scope.follow('run-rootless000', { notFoundGraceMs: 10_000 })
      await vi.advanceTimersByTimeAsync(1_500)
      scope.closeWhenQuiet()
      await vi.advanceTimersByTimeAsync(2_000)

      expect(scope.phase).toBe('following')
      expect(scope.spans.length).toBeGreaterThan(1)
    })

    it('says a run whose name never came has no trace, when the board says it is over', () => {
      const scope = (setActivePinia(createPinia()), useScopeStore())
      scope.wait()
      scope.closeWhenQuiet()

      expect(scope.phase).toBe('missing')
    })
  })

  it('empties itself for the next run', () => {
    const { scope } = start()
    const recording = recordLb01Sample()
    scope.showRecorded(recording.trace.runId, recording.trace.spans, true)
    scope.clear()
    expect(scope).toMatchObject({ runId: undefined, phase: 'idle', replayed: false })
    expect(scope.spans).toHaveLength(0)
  })
})

describe('the Scope store, for a run that goes on in turns', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps the spans already shown when the same run is followed again, and starts over for another run or without the option', async () => {
    const { site, scope, ticket } = start()
    advance(site, ticket.id)
    advance(site, ticket.id)
    scope.follow(ticket.run_id, { notFoundGraceMs: 10_000 })
    await vi.advanceTimersByTimeAsync(3_000)
    const shown = scope.spans.length
    expect(shown).toBeGreaterThan(0)

    scope.follow(ticket.run_id, { keepSpans: true })
    expect(scope.spans).toHaveLength(shown)
    expect(scope.phase).toBe('following')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(scope.spans).toHaveLength(shown)

    scope.follow('run-another-one-0000', { keepSpans: true })
    expect(scope.spans).toHaveLength(0)
    scope.follow(ticket.run_id)
    scope.follow(ticket.run_id)
    expect(scope.spans).toHaveLength(0)
  })

  it('calls a trace with no root span complete when the board says the run is over, and stops reading', async () => {
    const { site, scope } = start()
    const recording = recordLb01Sample()
    scope.showRecorded(recording.trace.runId, recording.trace.spans.filter(span => span.kind !== 'system.run'), false)
    expect(scope.phase).toBe('following')
    scope.finish()
    expect(scope.phase).toBe('finished')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(site.callsTo('/api/runs/')).toHaveLength(0)
  })

  it('does not call a run complete that never wrote a span', () => {
    const { scope } = start()
    scope.follow('run-nothing-written-0', { notFoundGraceMs: 1_000 })
    scope.finish()
    expect(scope.phase).toBe('following')
  })
})
