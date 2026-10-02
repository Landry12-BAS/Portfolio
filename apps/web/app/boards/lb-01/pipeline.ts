// LB-01's pipeline as the board shows it: the nine steps of the datasheet's signal chain, each
// marked done, running, waiting, skipped or failed from the spans the run has written so far.
// A span is written when its step finishes, and its name is the datasheet's English name for the
// step, so the board can tell which steps are done from the trace alone. A ticket that is handed
// to a person early (an injection, a legal matter) never runs the later steps; once the run is
// over they are shown as skipped, not as stuck.
import type { Span } from '@lb/contracts'

/** How far a step has got. */
export type StepState = 'done' | 'running' | 'waiting' | 'skipped' | 'failed'

/** One step of the chain, in the datasheet's order. */
export interface PipelineStep {
  // The step's English name, which is also its span's name.
  name: string
  state: StepState
}

/** Finds the span a step wrote, among the system's own steps and tools. */
function spanOf(name: string, spans: readonly Span[]): Span | undefined {
  return spans.find(span => span.name === name && (span.kind === 'system.step' || span.kind === 'system.tool'))
}

/** Reads one step's state from its span, if it wrote one. */
function finishedState(span: Span | undefined): StepState | undefined {
  if (span === undefined) return undefined
  if (span.status === 'error') return 'failed'
  if (span.status === 'skipped') return 'skipped'
  return 'done'
}

/**
 * Marks each step of the chain from the trace so far. The steps run in order, so a step with no
 * span that comes before one that has a span was never needed and is skipped. While the run is
 * going, the step right after the last finished one is the one running and the rest wait; once
 * the run is over, every step with no span is skipped.
 */
export function pipelineSteps(chain: readonly string[], spans: readonly Span[], runOver: boolean): PipelineStep[] {
  const finished = chain.map(name => finishedState(spanOf(name, spans)))
  const last = finished.findLastIndex(state => state !== undefined)
  return chain.map((name, index): PipelineStep => {
    const state = finished[index]
    if (state !== undefined) return { name, state }
    if (runOver || index < last) return { name, state: 'skipped' }
    return { name, state: index === last + 1 ? 'running' : 'waiting' }
  })
}
