// Unit tests for how LB-01's board marks the steps of its pipeline from the trace: the chain is the
// datasheet's, a step is done when its span exists, and steps a ticket never needed are skipped.
import type { Span } from '@lb/contracts'
import { mockSpans } from '@lb/api-clients/testing'
import { describe, expect, it } from 'vitest'

import { findSystemIn } from '#shared/data/datasheets'

import { pipelineSteps } from '~/boards/lb-01/pipeline'

const CHAIN = findSystemIn('lb-01', 'en')?.chain ?? []
const RUN = 'run-0123456789abcdef'

/** The spans of a mock run in the order they were written, cut after the first `count`. */
function firstSpans(count: number, escalation?: string): Span[] {
  return (mockSpans(RUN, 1_000_000, escalation, 3) as Span[]).filter(span => span.kind !== 'gateway.call' && span.kind !== 'gateway.attempt').slice(0, count)
}

describe('pipelineSteps', () => {
  it('uses the datasheet\'s nine steps, which are the names the pipeline gives its spans', () => {
    expect(CHAIN).toHaveLength(9)
    const names = new Set((mockSpans(RUN, 0, undefined, 3) as Span[]).filter(span => span.kind === 'system.step' || span.kind === 'system.tool').map(span => span.name))
    expect([...names].sort()).toEqual([...CHAIN].sort())
  })

  it('marks the first step as running and the rest as waiting before any span has arrived', () => {
    const steps = pipelineSteps(CHAIN, [], false)
    expect(steps.map(step => step.state)).toEqual(['running', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting'])
  })

  it('moves the running step along as spans arrive', () => {
    const steps = pipelineSteps(CHAIN, firstSpans(3), false)
    expect(steps.map(step => step.state)).toEqual(['done', 'done', 'done', 'running', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting'])
  })

  it('has every step done for a run that drafted a reply', () => {
    const steps = pipelineSteps(CHAIN, mockSpans(RUN, 0, undefined, 3) as Span[], true)
    expect(steps.every(step => step.state === 'done')).toBe(true)
  })

  it('skips the steps a ticket handed to a person early never needed, even before the run is over', () => {
    const spans = mockSpans(RUN, 0, 'injection', 0) as Span[]
    const during = pipelineSteps(CHAIN, spans.filter(span => span.kind !== 'system.run'), false)
    expect(during.map(step => step.state)).toEqual(['done', 'done', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'done'])
    const after = pipelineSteps(CHAIN, spans, true)
    expect(after).toEqual(during)
  })

  it('skips whatever has no span once the run is over, so nothing looks stuck', () => {
    const steps = pipelineSteps(CHAIN, firstSpans(2), true)
    expect(steps.map(step => step.state)).toEqual(['done', 'done', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped'])
  })

  it('marks a step whose span failed, and one that was skipped by the pipeline itself', () => {
    const spans = firstSpans(3).map((span, index) => (index === 1 ? { ...span, status: 'error' as const } : index === 2 ? { ...span, status: 'skipped' as const } : span))
    const steps = pipelineSteps(CHAIN, spans, true)
    expect(steps.slice(0, 3).map(step => step.state)).toEqual(['done', 'failed', 'skipped'])
  })

  it('ignores a span of another kind that shares a step\'s name', () => {
    const fake: Span = { ...firstSpans(1)[0]!, name: 'classify', kind: 'gateway.call' }
    expect(pipelineSteps(CHAIN, [fake], false)[2]?.state).toBe('waiting')
  })
})
