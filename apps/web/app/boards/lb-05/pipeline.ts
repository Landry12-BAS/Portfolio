// LB-05's chain as the board shows it: the seven steps of the datasheet's signal chain, each marked
// done, running, waiting, skipped or failed from the spans the run has written. A span is written when
// its step ends and carries the step's own name, which is not always the datasheet's: the datasheet
// says "parse + allowlist" where the span says `parse and allowlist`, and "chart + explain" is two
// spans, so each step lists the spans it is made of (services/flask-systems/lb05/pipeline.py).
// The steps run in the datasheet's order except self-correct, which comes after a refusal and so
// happens before the chart though it is listed after the run; it is the one step a question may
// never need, and it is shown as skipped once a later step has run.
import type { Span } from '@lb/contracts'

/** How far a step has got. */
export type StepState = 'done' | 'running' | 'waiting' | 'skipped' | 'failed'

/** The spans one step is made of. */
interface StepSpans {
  // The spans that must all be written for the step to be done. The first is the step's own.
  required: readonly string[]
  // Spans that belong to the step if it ran them, such as the second attempt at the SQL.
  optional: readonly string[]
  // Whether a question may finish without ever needing the step.
  conditional: boolean
}

/** The datasheet's seven steps, each with the spans it is made of, in the datasheet's order. */
export const STEP_SPANS: readonly StepSpans[] = [
  { required: ['resolve metrics'], optional: [], conditional: false },
  { required: ['write SQL'], optional: [], conditional: false },
  { required: ['parse and allowlist'], optional: [], conditional: false },
  { required: ['explain plan'], optional: [], conditional: false },
  { required: ['run read-only'], optional: [], conditional: false },
  { required: ['self-correct'], optional: ['write SQL again'], conditional: true },
  { required: ['build chart', 'explain result'], optional: [], conditional: false },
]

/** One step of the chain, as the board shows it. */
export interface PipelineStep {
  // The position of the step in the datasheet's chain.
  index: number
  state: StepState
  // How many times the step ran: more than once when the model corrected its query.
  runs: number
  // The layer and rule that stopped the query at this step, as its last span names them.
  layer: string | undefined
  rule: string | undefined
}

/** Finds the spans of the system's own steps and tools that carry one of the names, in the order they ended. */
function spansNamed(names: readonly string[], spans: readonly Span[]): Span[] {
  return spans
    .filter(span => (span.kind === 'system.step' || span.kind === 'system.tool') && names.includes(span.name))
    .toSorted((a, b) => a.endMs - b.endMs)
}

/** Reads a text detail off a span, or undefined when it has none of that name. */
function textDetail(span: Span | undefined, name: string): string | undefined {
  const value = span?.attrs[name]
  return typeof value === 'string' ? value : undefined
}

/** Says how a step that has spans stands: failed or skipped as its own last span says, done once every required span is in, else running. */
function stateOf(step: StepSpans, own: Span | undefined, spans: readonly Span[]): StepState {
  if (own?.status === 'error') return 'failed'
  const complete = step.required.every(name => spansNamed([name], spans).length > 0)
  if (!complete) return 'running'
  return own?.status === 'skipped' ? 'skipped' : 'done'
}

/** Works out one step from the spans written so far, or undefined when none of its spans has been written. */
function writtenStep(index: number, step: StepSpans, spans: readonly Span[]): PipelineStep | undefined {
  if (spansNamed([...step.required, ...step.optional], spans).length === 0) return undefined
  const ownSpans = spansNamed(step.required.slice(0, 1), spans)
  const last = ownSpans.at(-1)
  return { index, state: stateOf(step, last, spans), runs: ownSpans.length, layer: textDetail(last, 'layer'), rule: textDetail(last, 'rule') }
}

/**
 * Marks each step of the chain from the trace so far. A step with spans is done, failed or still
 * running by what they say. One without is skipped when the question is over or when a later step
 * has already run; otherwise the first step not reached is running (unless a step has just failed,
 * after which nothing is known to be next) and the rest wait.
 */
export function pipelineSteps(spans: readonly Span[], runOver: boolean): PipelineStep[] {
  const written = STEP_SPANS.map((step, index) => writtenStep(index, step, spans))
  const reached = written.findLastIndex(step => step !== undefined)
  let nothingRunningYet = true
  return STEP_SPANS.map((step, index): PipelineStep => {
    const found = written[index]
    if (found) {
      if (found.state === 'running' || found.state === 'failed') nothingRunningYet = false
      return found
    }
    const unreached = { index, runs: 0, layer: undefined, rule: undefined }
    if (runOver || index < reached) return { ...unreached, state: 'skipped' }
    if (nothingRunningYet && !step.conditional) {
      nothingRunningYet = false
      return { ...unreached, state: 'running' }
    }
    return { ...unreached, state: 'waiting' }
  })
}
