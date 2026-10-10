// The spans of a mock LB-10 run, in the format the Scope route returns and the real pipeline writes
// (services/flask-systems/lb10/pipeline.py): `read cache` first, one `model call` step for each call the
// cache could not answer (a cached result makes no call and writes no span), with the gateway's own call
// nested under it, and the root `eval run` last, which says how the run ended. A run the service failed has
// a root with the `error` status; a run whose worker died has none. They are fixtures: the step names and
// attributes are the pipeline's, and every timing and token count is made up, so no test or page may show
// them as a measurement. No span carries the prompt or an answer, as the real ones never do.
import { createHash } from 'node:crypto'

import type { MockSpan } from './spans.ts'

/** What one call of the run was, for its span. */
export interface MockCallSpan {
  alias: string
  provider: string
  variant: 'production' | 'edited'
  caseId: string
  difficulty: string
  passed: boolean
  latencyMs: number
  inputTokens: number
  outputTokens: number
  model: string
  // The gateway's code when the call got no answer.
  errorCode: string | null
}

/** What the trace of a run says about the run as a whole. */
export interface MockRunFacts {
  pack: string
  packVersion: string
  cases: number
  providers: number
  // The results the run looked for in the cache, and the ones it found.
  wanted: number
  found: number
  calls: readonly MockCallSpan[]
}

/** How a run ended, for its root span: done, failed for a reason, timed out, or not at all (its worker died). */
export type MockRunEnd = { kind: 'done' } | { kind: 'failed', outcome: string } | { kind: 'timed_out' } | { kind: 'no_root' }

/** A run's spans, in the order the trace shows them: the cache read, then each call with its gateway call, then the root. */
export interface MockRunTrace {
  cache: MockSpan
  calls: MockSpan[][]
  root: MockSpan | undefined
}

// The calls in flight at once, as the service's limits say, and the gaps the fixture leaves between spans.
const LANES = 4
const GAP_MS = 20

/** Makes a span ID of 16 hex digits that is the same for the same run and key. */
function spanId(runId: string, key: string): string {
  return createHash('sha256').update(`${runId}:${key}`).digest('hex').slice(0, 16)
}

/** Builds one span of the run. */
function span(runId: string, key: string, parent: string | undefined, kind: MockSpan['kind'], name: string, from: number, to: number, attrs: MockSpan['attrs'], status: MockSpan['status'] = 'ok'): MockSpan {
  const built: MockSpan = { v: 1, runId, system: 'lb-10', spanId: spanId(runId, key), kind, name, status, startMs: from, endMs: to, attrs }
  if (parent !== undefined) built.parentId = spanId(runId, parent)
  return built
}

/** The attributes of one call's step, as the pipeline notes them: numbers and codes, never the prompt or the answer. */
function callAttrs(call: MockCallSpan): MockSpan['attrs'] {
  const attrs: MockSpan['attrs'] = {
    alias: call.alias,
    variant: call.variant,
    case: call.caseId,
    difficulty: call.difficulty,
    passed: call.passed,
    latency_ms: call.latencyMs,
    input_tokens: call.inputTokens,
    output_tokens: call.outputTokens,
  }
  if (call.model !== '') attrs.model = call.model
  if (call.errorCode !== null) attrs.error_code = call.errorCode
  return attrs
}

/** Builds one call's step and the gateway's call under it, from `at` for as long as the call took. */
function callSpans(runId: string, index: number, call: MockCallSpan, at: number): MockSpan[] {
  const key = `call.${index}`
  const to = at + call.latencyMs
  const gateway: MockSpan['attrs'] = { alias: call.alias, dataClass: 'visitor', stream: false, attempts: 1, provider: call.provider }
  if (call.errorCode === null) Object.assign(gateway, { model: call.model, inputTokens: call.inputTokens, outputTokens: call.outputTokens, usage: 'reported' })
  else gateway.error = call.errorCode
  return [
    span(runId, key, 'run', 'system.step', 'model call', at, to, callAttrs(call)),
    span(runId, `${key}.gateway`, key, 'gateway.call', call.alias, at + 4, to - 4, gateway, call.errorCode === null ? 'ok' : 'error'),
  ]
}

/** The attributes of the root span as the pipeline sets them for how the run ended. */
function rootAttrs(facts: MockRunFacts, end: MockRunEnd): MockSpan['attrs'] {
  const attrs: MockSpan['attrs'] = { pack: facts.pack, pack_version: facts.packVersion, cases: facts.cases, providers: facts.providers }
  if (end.kind === 'done') {
    const made = facts.calls.length
    return { ...attrs, outcome: 'done', model_calls: made, cached_calls: facts.found }
  }
  if (end.kind === 'failed') return { ...attrs, outcome: end.outcome, error: 'RunFailedError' }
  return { ...attrs, error: 'CancelledError' }
}

/** Writes the spans of one mock run: the cache read, the calls four at a time, and the root for how it ended. */
export function lb10Trace(runId: string, startedAt: number, facts: MockRunFacts, end: MockRunEnd): MockRunTrace {
  const cache = span(runId, 'cache', 'run', 'system.step', 'read cache', startedAt + 5, startedAt + 40, { wanted: facts.wanted, found: facts.found })
  const lanes = Array.from({ length: LANES }, () => startedAt + 60)
  const calls = facts.calls.map((call, index) => {
    const lane = index % LANES
    const at = lanes[lane] ?? startedAt + 60
    lanes[lane] = at + call.latencyMs + GAP_MS
    return callSpans(runId, index, call, at)
  })
  const lastEnd = Math.max(startedAt + 60, ...calls.map(pair => pair[0]?.endMs ?? 0))
  const root = end.kind === 'no_root'
    ? undefined
    : span(runId, 'run', undefined, 'system.run', 'eval run', startedAt, lastEnd + 10, rootAttrs(facts, end), end.kind === 'done' ? 'ok' : 'error')
  return { cache, calls, root }
}
