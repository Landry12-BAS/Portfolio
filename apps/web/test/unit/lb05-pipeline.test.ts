// Unit tests for LB-05's chain of steps: which of the datasheet's seven steps are done, running,
// waiting, skipped or failed, read from the spans a run has written, whether the run is a whole one
// (a live run's trace arrives when the answer does) or a replay revealing its spans one by one.
import type { Span } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { findSystemIn } from '#shared/data/datasheets'

import { pipelineSteps, STEP_SPANS } from '~/boards/lb-05/pipeline'

let counter = 0

/** Makes the span of a step that ended at a moment, with the details it carries. */
function span(name: string, endMs: number, status: Span['status'] = 'ok', attrs: Span['attrs'] = {}, kind: Span['kind'] = 'system.step'): Span {
  counter += 1
  return { v: 1, runId: 'run-0123456789abcdef', system: 'lb-05', spanId: counter.toString(16).padStart(16, '0'), kind, name, status, startMs: endMs - 5, endMs, attrs }
}

/** The spans of a question that went straight through. */
function straightThrough(): Span[] {
  return [
    span('resolve metrics', 10),
    span('write SQL', 900),
    span('parse and allowlist', 910),
    span('explain plan', 930, 'ok', {}, 'system.tool'),
    span('run read-only', 1_000, 'ok', {}, 'system.tool'),
    span('build chart', 1_010),
    span('explain result', 1_900),
    span('data question', 1_910, 'ok', {}, 'system.run'),
  ]
}

/** Lists the states of the seven steps. */
function states(spans: readonly Span[], over: boolean): string[] {
  return pipelineSteps(spans, over).map(step => step.state)
}

describe('the chain of steps', () => {
  it('has the datasheet\'s seven steps, in its order', () => {
    expect(STEP_SPANS).toHaveLength(7)
    expect(findSystemIn('lb-05', 'en')?.chain).toEqual(['resolve metrics', 'write SQL', 'parse + allowlist', 'EXPLAIN', 'run read-only', 'self-correct', 'chart + explain'])
  })

  it('marks every step done but self-correct, which was not needed, when a question goes straight through', () => {
    expect(states(straightThrough(), true)).toEqual(['done', 'done', 'done', 'done', 'done', 'skipped', 'done'])
  })

  it('marks self-correct done, and counts the second parse, when the model corrected its query', () => {
    const spans = [
      span('resolve metrics', 10),
      span('write SQL', 900),
      span('parse and allowlist', 910, 'error', { layer: 'allowlist', rule: 'unknown_column' }),
      span('write SQL again', 1_800),
      span('self-correct', 1_801, 'ok', { layer: 'allowlist', rule: 'unknown_column', retryable: true }),
      span('parse and allowlist', 1_810),
      span('explain plan', 1_830, 'ok', {}, 'system.tool'),
      span('run read-only', 1_900, 'ok', {}, 'system.tool'),
      span('build chart', 1_910),
      span('explain result', 2_700),
    ]
    const steps = pipelineSteps(spans, true)
    expect(steps.map(step => step.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'done'])
    expect(steps[2]?.runs).toBe(2)
    expect(steps[5]).toMatchObject({ runs: 1, layer: 'allowlist', rule: 'unknown_column' })
  })

  it('marks the step a layer stopped as failed, with the layer and rule, and the steps after it skipped', () => {
    const spans = [
      span('resolve metrics', 10),
      span('write SQL', 900),
      span('parse and allowlist', 910, 'error', { layer: 'parse', rule: 'not_select', retryable: false }),
      span('data question', 915, 'ok', {}, 'system.run'),
    ]
    const steps = pipelineSteps(spans, true)
    expect(steps.map(step => step.state)).toEqual(['done', 'done', 'failed', 'skipped', 'skipped', 'skipped', 'skipped'])
    expect(steps[2]).toMatchObject({ layer: 'parse', rule: 'not_select' })
  })

  it('marks the step that was reached last as failed when the model call failed, and stops there', () => {
    const spans = [span('resolve metrics', 10), span('write SQL', 60_000, 'error')]
    expect(states(spans, true)).toEqual(['done', 'failed', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped'])
  })

  it('reads a question the model declined: it wrote no query, so nothing after writing it ran', () => {
    const spans = [span('resolve metrics', 10), span('write SQL', 900)]
    expect(states(spans, true)).toEqual(['done', 'done', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped'])
  })
})

describe('the chain while a replay reveals its spans', () => {
  it('marks nothing running before a span has been seen: the first step is the one being waited on', () => {
    expect(states([], false)).toEqual(['running', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting'])
  })

  it('marks the step after the last finished one as running, and skips nothing that may still come', () => {
    expect(states(straightThrough().slice(0, 3), false)).toEqual(['done', 'done', 'done', 'running', 'waiting', 'waiting', 'waiting'])
  })

  it('does not call self-correct running: it is the one step a question may never need', () => {
    expect(states(straightThrough().slice(0, 5), false)).toEqual(['done', 'done', 'done', 'done', 'done', 'waiting', 'running'])
  })

  it('marks a step with only some of its spans as running', () => {
    expect(states(straightThrough().slice(0, 6), false)[6]).toBe('running')
  })

  it('calls the second attempt at the SQL part of the correction still going', () => {
    const spans = [span('resolve metrics', 10), span('write SQL', 900), span('parse and allowlist', 910, 'error'), span('write SQL again', 1_800)]
    expect(states(spans, false)[5]).toBe('running')
  })

  it('does not guess what is next after a step has failed, while the replay is still going', () => {
    const spans = [span('resolve metrics', 10), span('write SQL', 900), span('parse and allowlist', 910, 'error')]
    expect(states(spans, false)).toEqual(['done', 'done', 'failed', 'waiting', 'waiting', 'waiting', 'waiting'])
  })
})
