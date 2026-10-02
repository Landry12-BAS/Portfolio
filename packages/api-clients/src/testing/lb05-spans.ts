// The spans of a mock LB-05 run, in the format the gateway's Scope route returns and the real pipeline
// writes (services/flask-systems/lb05/pipeline.py): `resolve metrics`, `write SQL`, `parse and
// allowlist`, `explain plan`, `run read-only`, `self-correct` with its `write SQL again` inside it,
// `build chart` and `explain result`, the gateway's calls nested under the steps that made them, and
// the root span `data question` written last. They are fixtures: the names and the nesting are the
// pipeline's, and every timing and token count is made up, so no test or page may show them as a
// measurement.
import { createHash } from 'node:crypto'

import type { MockSpan } from './spans.ts'

/** The layer and rule that stopped a query, and whether the model gets one more try. */
export interface MockRefusal {
  layer: string
  rule: string
  retryable: boolean
}

/** How a mock question went, which decides the spans it leaves. */
export type Lb05Flow
  = | { kind: 'answered', rows: number, chart: string, truncated: boolean, corrected: MockRefusal | undefined }
    | { kind: 'refused', refusals: MockRefusal[] }
    | { kind: 'declined', after: MockRefusal | undefined }
    | { kind: 'unavailable' }

/** A span before it has its run, its place in time and its ID. */
interface Plan {
  key: string
  parent: string | undefined
  kind: MockSpan['kind']
  name: string
  from: number
  to: number
  status: MockSpan['status']
  attrs: Record<string, string | number | boolean>
}

/** What a step may be given besides its name and length. */
interface StepOptions {
  kind?: MockSpan['kind']
  status?: MockSpan['status']
  parent?: string
}

/** Makes a span ID of 16 hex digits that is the same for the same run and key. */
function spanId(runId: string, key: string): string {
  return createHash('sha256').update(`${runId}:${key}`).digest('hex').slice(0, 16)
}

/** Writes the plans of a run, one step at a time along a clock that only moves forward. */
class Planner {
  readonly plans: Plan[] = []
  calls = 0
  #clock = 0

  /** Adds a step that takes `duration` milliseconds. */
  step(key: string, name: string, duration: number, attrs: Plan['attrs'] = {}, options: StepOptions = {}): void {
    const from = this.#clock
    this.#clock += duration
    this.plans.push({ key, parent: options.parent ?? 'run', kind: options.kind ?? 'system.step', name, from, to: this.#clock, status: options.status ?? 'ok', attrs })
  }

  /** Adds a step that makes a model call through the gateway, with the call and its attempt nested under it. */
  modelStep(key: string, name: string, alias: 'lb-reason' | 'lb-fast', duration: number, attrs: Plan['attrs'], options: StepOptions = {}): void {
    const from = this.#clock
    this.step(key, name, duration, attrs, options)
    const status = options.status ?? 'ok'
    const model = alias === 'lb-reason' ? 'groq/gpt-oss-120b' : 'groq/gpt-oss-20b'
    const provider = model.split('/')[0] ?? ''
    const inputTokens = alias === 'lb-reason' ? 2_900 : 720
    const outputTokens = alias === 'lb-reason' ? 160 : 90
    const call = { alias, dataClass: 'visitor', stream: false, attempts: 1, provider, model, inputTokens, outputTokens, usage: 'reported' }
    this.plans.push({ key: `${key}.call`, parent: key, kind: 'gateway.call', name: alias, from: from + 2, to: from + duration - 2, status, attrs: call })
    this.plans.push({ key: `${key}.attempt`, parent: `${key}.call`, kind: 'gateway.attempt', name: model, from: from + 4, to: from + duration - 4, status, attrs: { provider, model, inputTokens, outputTokens } })
    this.calls += 1
  }

  /** Adds a step that wraps what `inner` adds, and ends a moment after it. */
  wrap(key: string, name: string, attrs: Plan['attrs'], inner: () => void): void {
    const from = this.#clock
    inner()
    this.#clock += 1
    this.plans.push({ key, parent: 'run', kind: 'system.step', name, from, to: this.#clock, status: 'ok', attrs })
  }

  /** Adds the root span, which covers everything and is written last. */
  root(attrs: Plan['attrs']): void {
    this.plans.push({ key: 'run', parent: undefined, kind: 'system.run', name: 'data question', from: 0, to: this.#clock + 5, status: 'ok', attrs: { ...attrs, model_calls: this.calls } })
  }
}

/** The details a refusal leaves on the span of the step that met it. */
function refusalAttrs(refusal: MockRefusal): Plan['attrs'] {
  return { layer: refusal.layer, rule: refusal.rule, retryable: refusal.retryable }
}

/** Adds the checks and the run of one query: parse it, plan it, run it, stopping at the step that refused it. */
function checkAndRun(planner: Planner, suffix: string, refusal: MockRefusal | undefined, result: { rows: number, truncated: boolean } | undefined): void {
  if (refusal?.layer === 'parse' || refusal?.layer === 'allowlist') {
    planner.step(`parse${suffix}`, 'parse and allowlist', 4, refusalAttrs(refusal), { status: 'error' })
    return
  }
  planner.step(`parse${suffix}`, 'parse and allowlist', 3, { tables: 'orders,order_lines', joins: 1, row_limit: 1_000, limit_applied: result?.truncated ?? false })
  if (refusal?.layer === 'explain') {
    planner.step(`plan${suffix}`, 'explain plan', 28, refusalAttrs(refusal), { kind: 'system.tool', status: 'error' })
    return
  }
  planner.step(`plan${suffix}`, 'explain plan', 26, { operators: 6, estimated_rows: 1_200 }, { kind: 'system.tool' })
  planner.step(`run${suffix}`, 'run read-only', 41, { rows: result?.rows ?? 0, columns: 2, elapsed_ms: 38, capped: result?.truncated ?? false }, { kind: 'system.tool' })
}

/** Adds the first attempt at the SQL and its checks. */
function firstAttempt(planner: Planner, refusal: MockRefusal | undefined, result: { rows: number, truncated: boolean } | undefined): void {
  planner.modelStep('write', 'write SQL', 'lb-reason', 1_800, { attempts: 1, answerable: true, sql_chars: 180 })
  checkAndRun(planner, '', refusal, result)
}

/** Adds the correction after a refusal: `self-correct`, with the second attempt at the SQL inside it, and then that attempt's checks. */
function correction(planner: Planner, refusal: MockRefusal, answerable: boolean, then: () => void): void {
  planner.wrap('correct', 'self-correct', refusalAttrs(refusal), () => {
    planner.modelStep('write2', 'write SQL again', 'lb-reason', 1_800, { attempts: 1, answerable, sql_chars: answerable ? 190 : 0 }, { parent: 'correct' })
  })
  then()
}

/** Plans the spans of a run that went the way `flow` says. */
function plan(flow: Lb05Flow): Plan[] {
  const planner = new Planner()
  planner.step('resolve', 'resolve metrics', 3, { metrics: 'revenue', dimensions: '', ranges: 'last_quarter' })
  if (flow.kind === 'unavailable') {
    planner.modelStep('write', 'write SQL', 'lb-reason', 60_000, { attempts: 1 }, { status: 'error' })
    planner.root({ outcome: 'unavailable', queries: 0, reason: 'model_failed' })
  }
  else if (flow.kind === 'declined') {
    if (flow.after === undefined) {
      planner.modelStep('write', 'write SQL', 'lb-reason', 1_600, { attempts: 1, answerable: false, sql_chars: 0 })
    }
    else {
      firstAttempt(planner, flow.after, undefined)
      correction(planner, flow.after, false, () => undefined)
    }
    planner.root({ outcome: 'declined', queries: flow.after === undefined ? 0 : 1 })
  }
  else if (flow.kind === 'refused') {
    const [first, second] = flow.refusals
    firstAttempt(planner, first, undefined)
    if (first && second) correction(planner, first, true, () => checkAndRun(planner, '2', second, undefined))
    planner.root({ outcome: 'refused', queries: flow.refusals.length })
  }
  else {
    const result = { rows: flow.rows, truncated: flow.truncated }
    firstAttempt(planner, flow.corrected, result)
    if (flow.corrected) correction(planner, flow.corrected, true, () => checkAndRun(planner, '2', undefined, result))
    planner.step('chart', 'build chart', 3, { kind: flow.chart, omitted_rows: 0 })
    planner.modelStep('explain', 'explain result', 'lb-fast', 900, { source: 'model' })
    planner.root({ outcome: 'answered', queries: flow.corrected ? 2 : 1, rows: flow.rows })
  }
  return planner.plans
}

/**
 * Makes the spans of one run that started at `startedAt` (Unix milliseconds) and went the way
 * `flow` says. They are in the order a stream holds them, which is the order they ended, so the root
 * span comes last.
 */
export function lb05Spans(runId: string, startedAt: number, flow: Lb05Flow): MockSpan[] {
  return plan(flow)
    .toSorted((a, b) => a.to - b.to)
    .map((item): MockSpan => ({
      v: 1,
      runId,
      system: 'lb-05',
      spanId: spanId(runId, item.key),
      ...(item.parent === undefined ? {} : { parentId: spanId(runId, item.parent) }),
      kind: item.kind,
      name: item.name,
      status: item.status,
      startMs: startedAt + item.from,
      endMs: startedAt + item.to,
      attrs: item.attrs,
    }))
}
