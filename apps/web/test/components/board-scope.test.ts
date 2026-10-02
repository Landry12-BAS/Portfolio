// Component tests for the Scope panel: it draws the store's spans as a nested table a screen
// reader can read, says where the reading stands in words, offers the permalink for a live run
// only, and shows less in the Brief reading.
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import BoardScopePanel from '~/components/board/ScopePanel.vue'
import { useScopeStore } from '~/stores/scope'

import { mountWithSite } from '../support/mount'
import { recordLb01Sample } from '../support/recording'

/** Mounts the panel and fills the store with a recorded run, as a replay would. */
async function mountWithRun(options: { brief?: boolean, permalink?: string, locale?: 'en' | 'cs', finished?: boolean, spans?: number } = {}) {
  const wrapper = mountWithSite(BoardScopePanel, { locale: options.locale, props: { brief: options.brief ?? false, permalink: options.permalink } })
  const recording = recordLb01Sample()
  const scope = useScopeStore()
  scope.showRecorded(recording.trace.runId, recording.trace.spans.slice(0, options.spans ?? recording.trace.spans.length), options.finished ?? true)
  await nextTick()
  return { wrapper, scope, recording }
}

describe('BoardScopePanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('invites the visitor to start a run before there is a trace', () => {
    const wrapper = mountWithSite(BoardScopePanel, { props: { brief: false } })
    expect(wrapper.text()).toContain('Start a run and its trace appears here')
    expect(wrapper.find('table').exists()).toBe(false)
  })

  it('draws every span as a row, the run first and the steps and model calls nested under it', async () => {
    const { wrapper, recording } = await mountWithRun()
    const rows = wrapper.findAll('[data-testid="scope-row"]')
    expect(rows).toHaveLength(recording.trace.spans.length)
    expect(rows[0]?.text()).toContain('support ticket')
    expect(rows[0]?.attributes('data-kind')).toBe('run')
    const padding = rows.map(row => row.get('th').attributes('style') ?? '')
    expect(padding[0]).toContain('padding-inline-start: 8px')
    expect(padding.some(style => style.includes('36px'))).toBe(true)
    expect(padding.some(style => style.includes('50px'))).toBe(true)
  })

  it('is a table with column headers and row headers, in a scroll region the keyboard can reach', async () => {
    const { wrapper } = await mountWithRun()
    expect(wrapper.findAll('thead th[scope="col"]').map(item => item.text())).toEqual(['Step', 'Kind', 'Model', 'Tokens', 'Time'])
    expect(wrapper.findAll('tbody th[scope="row"]').length).toBeGreaterThan(5)
    const region = wrapper.get('[role="region"]')
    expect(region.attributes('tabindex')).toBe('0')
    expect(region.attributes('aria-label')).toBe('Trace of the run')
    expect(wrapper.get('caption').text()).toContain('Every step, tool call and model call')
  })

  it('tells a screen reader what each nested row sits inside, and hides the decorative bars', async () => {
    const { wrapper } = await mountWithRun()
    expect(wrapper.text()).toContain('(inside support ticket)')
    expect(wrapper.text()).toContain('(inside classify)')
    expect(wrapper.findAll('.track').every(track => track.attributes('aria-hidden') === 'true')).toBe(true)
  })

  it('shows a model call\'s model, tokens and time in the visitor\'s number format', async () => {
    const { wrapper } = await mountWithRun()
    const call = wrapper.findAll('[data-testid="scope-row"]').find(row => row.text().includes('lb-fast'))
    expect(call?.text()).toContain('groq/gpt-oss-20b')
    expect(call?.text()).toContain('410 in, 51 out')
    expect(call?.text()).toMatch(/520\s?ms/)
  })

  it('summarises the run: steps, model calls and time', async () => {
    const { wrapper } = await mountWithRun()
    const summary = wrapper.get('.summary').text()
    expect(summary).toContain('Steps')
    expect(summary).toContain('9')
    expect(summary).toContain('Model calls')
    expect(summary).toContain('5')
    expect(summary).toMatch(/2\.7\s?s/)
  })

  it('says the run is complete, or that this is the recorded trace of a replay', async () => {
    const { wrapper } = await mountWithRun()
    expect(wrapper.get('[role="status"]').text()).toContain('Recorded trace of the replayed run')
  })

  it('says it is following the run, and that the time is so far, while the root span is missing', async () => {
    const { wrapper, scope } = await mountWithRun({ finished: false, spans: 5 })
    expect(scope.phase).toBe('following')
    expect(wrapper.get('[role="status"]').text()).toContain('Following the run')
    expect(wrapper.get('.summary').text()).toContain('Time so far')
  })

  it.each([
    ['stalled', 'The trace stopped arriving'],
    ['missing', 'There is no trace for this run'],
    ['failed', 'The trace could not be read'],
  ] as const)('says in words when the reading is %s', async (phase, words) => {
    const wrapper = mountWithSite(BoardScopePanel, { props: { brief: false } })
    const scope = useScopeStore()
    scope.follow('run-0123456789ab')
    scope.stop()
    scope.$patch({ phase })
    await nextTick()
    expect(wrapper.get('[role="status"]').text()).toContain(words)
  })

  it('shows the summary and no table in the Brief reading', async () => {
    const { wrapper } = await mountWithRun({ brief: true })
    expect(wrapper.find('table').exists()).toBe(false)
    expect(wrapper.get('.summary').text()).toContain('Steps')
  })

  it('offers the permalink for a live run, and copies its absolute address', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { wrapper } = await mountWithRun({ permalink: '/runs/run-0123456789ab' })
    await nextTick()
    const link = wrapper.get('a')
    expect(link.attributes('href')).toBe('/runs/run-0123456789ab')
    await wrapper.get('button.copy').trigger('click')
    await nextTick()
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/runs/run-0123456789ab`)
    expect(wrapper.text()).toContain('Link copied')
  })

  it('offers no permalink when there is none, as for a replay', async () => {
    const { wrapper } = await mountWithRun()
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.find('button.copy').exists()).toBe(false)
  })

  it('speaks Czech', async () => {
    const { wrapper } = await mountWithRun({ locale: 'cs' })
    expect(wrapper.findAll('thead th').map(item => item.text())).toEqual(['Krok', 'Druh', 'Model', 'Tokeny', 'Čas'])
    expect(wrapper.text()).toContain('(uvnitř: support ticket)')
    expect(wrapper.get('.summary').text()).toMatch(/2,7\s?s/)
  })
})
