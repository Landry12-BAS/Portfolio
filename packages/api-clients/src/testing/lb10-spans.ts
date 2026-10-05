// The spans of a mock LB-10 run, in the format the Scope route returns and the real pipeline
// writes (services/flask-systems/lb10/pipeline.py): the cache read, one `model call` step per
// call with the gateway's call nested under it, and the root span for the whole run, written
// last. They are fixtures: the step names are the pipeline's real ones, and every timing and
// token count is made up, so no test or page may show them as a measurement. No span carries
// the prompt or an answer, as the real ones never do.
import { createHash } from 'node:crypto'

import type { MockSpan } from './spans.ts'

/** What one call of the run was, for its span. */
export interface MockCallSpan {
  alias: string
  variant: 'production' | 'edited'
  caseId: string
  difficulty: string
  passed: boolean
  cached: boolean
}

// How long the fixture gives each call, and the gap between them, in milliseconds.
const CALL_MS = 900
const GAP_MS = 60

/** Makes a span ID of 16 hex digits that is the same for the same run and key. */
function spanId(runId: string, key: string): string {
  return createHash('sha256').update(`${runId}:${key}`).digest('hex').slice(0, 16)
}

/** Builds one span of the run. */
function span(runId: string, key: string, parent: string | undefined, kind: MockSpan['kind'], name: string, from: number, to: number, attrs: MockSpan['attrs']): MockSpan {
  const built: MockSpan = { v: 1, runId, system: 'lb-10', spanId: spanId(runId, key), kind, name, status: 'ok', startMs: from, endMs: to, attrs }
  if (parent !== undefined) built.parentId = spanId(runId, parent)
  return built
}

/** Writes the spans of one finished mock run: the cache read, the calls (cached ones are skipped steps), the root. */
export function lb10Spans(runId: string, startedAt: number, pack: string, calls: readonly MockCallSpan[]): MockSpan[] {
  const spans: MockSpan[] = [
    span(runId, 'cache', 'run', 'system.step', 'read cache', startedAt + 5, startedAt + 40, { wanted: calls.length, found: calls.filter(call => call.cached).length }),
  ]
  let at = startedAt + 60
  calls.forEach((call, index) => {
    const key = `call.${index}`
    const live = !call.cached
    const to = live ? at + CALL_MS : at + 2
    spans.push(span(runId, key, 'run', 'system.step', 'model call', at, to, {
      alias: call.alias,
      variant: call.variant,
      case: call.caseId,
      difficulty: call.difficulty,
      passed: call.passed,
      latency_ms: live ? CALL_MS : 0,
      input_tokens: live ? 410 : 0,
      output_tokens: live ? 52 : 0,
    }))
    if (live) {
      spans.push(span(runId, `${key}.gateway`, key, 'gateway.call', call.alias, at + 4, to - 4, { alias: call.alias, dataClass: 'visitor', stream: false, attempts: 1, provider: call.alias.includes('-cf-') ? 'workers-ai' : 'groq', model: call.alias.includes('-cf-') ? 'workers-ai/gpt-oss-20b' : 'groq/gpt-oss-20b', inputTokens: 410, outputTokens: 52, usage: 'reported' }))
    }
    at = to + GAP_MS
  })
  spans.push(span(runId, 'run', undefined, 'system.run', 'eval run', startedAt, at, { pack, cases: calls.length / 2, providers: 1, outcome: 'done', model_calls: calls.filter(call => !call.cached).length, cached_calls: calls.filter(call => call.cached).length }))
  return spans
}
