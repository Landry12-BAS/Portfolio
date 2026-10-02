// The spans of a mock LB-01 run, in the format the gateway's Scope route returns and the real
// pipeline writes (services/gateway/src/spans.ts): the system's steps, the gateway's calls nested
// under them, and a root span for the whole run, written last. They are fixtures: the
// step names are the pipeline's real ones, and every timing and token count is made up, so no
// test or page may show them as a measurement.
import { createHash } from 'node:crypto'

/** One span, as the Scope route returns it. */
export interface MockSpan {
  v: 1
  runId: string
  system: `lb-${string}`
  spanId: string
  parentId?: string
  kind: 'system.run' | 'system.step' | 'system.tool' | 'gateway.call' | 'gateway.attempt'
  name: string
  status: 'ok' | 'error' | 'skipped'
  startMs: number
  endMs: number
  attrs: Record<string, string | number | boolean>
}

/** A span before it has its run, its place in time and its ID. */
interface Plan {
  key: string
  parent: string | undefined
  kind: MockSpan['kind']
  name: string
  from: number
  to: number
  attrs: Record<string, string | number | boolean>
}

/** Makes a span ID of 16 hex digits that is the same for the same run and key. */
function spanId(runId: string, key: string): string {
  return createHash('sha256').update(`${runId}:${key}`).digest('hex').slice(0, 16)
}

/** Plans a gateway call under a step, with its one attempt under the call. */
function gatewayCall(step: string, alias: string, model: string, from: number, to: number, tokens: number): Plan[] {
  return [
    { key: `${step}.call`, parent: step, kind: 'gateway.call', name: alias, from, to, attrs: { alias, dataClass: 'visitor', stream: false, attempts: 1, provider: model.split('/')[0] ?? '', model, inputTokens: tokens, outputTokens: Math.round(tokens / 8), usage: 'reported' } },
    { key: `${step}.attempt`, parent: `${step}.call`, kind: 'gateway.attempt', name: model, from: from + 2, to: to - 2, attrs: { provider: model.split('/')[0] ?? '', model, inputTokens: tokens, outputTokens: Math.round(tokens / 8) } },
  ]
}

/** Plans the pipeline of a ticket that gets a cited draft. */
function draftPlan(sources: number): Plan[] {
  return [
    { key: 'redact', parent: 'run', kind: 'system.step', name: 'redact PII', from: 0, to: 3, attrs: { redactions: 0 } },
    { key: 'guard', parent: 'run', kind: 'system.step', name: 'screen for injection', from: 3, to: 190, attrs: { flagged: false } },
    ...gatewayCall('guard', 'lb-guard', 'groq/llama-prompt-guard-2-86m', 8, 185, 140),
    { key: 'classify', parent: 'run', kind: 'system.step', name: 'classify', from: 190, to: 720, attrs: { category: 'damaged' } },
    ...gatewayCall('classify', 'lb-fast', 'groq/gpt-oss-20b', 195, 715, 410),
    { key: 'search', parent: 'run', kind: 'system.step', name: 'hybrid search', from: 720, to: 930, attrs: { chunks: 6, mode: 'hybrid' } },
    ...gatewayCall('search', 'lb-embed', 'workers-ai/bge-m3', 725, 840, 24),
    { key: 'rerank', parent: 'run', kind: 'system.step', name: 'rerank', from: 930, to: 1_130, attrs: { candidates: 6 } },
    ...gatewayCall('rerank', 'lb-rerank', 'workers-ai/bge-reranker-base', 935, 1_125, 1_900),
    { key: 'order', parent: 'run', kind: 'system.tool', name: 'look up order', from: 1_130, to: 1_140, attrs: { found: true } },
    { key: 'draft', parent: 'run', kind: 'system.step', name: 'draft with citations', from: 1_140, to: 2_640, attrs: { sources } },
    ...gatewayCall('draft', 'lb-tools', 'groq/gpt-oss-120b', 1_145, 2_635, 2_300),
    { key: 'claims', parent: 'run', kind: 'system.step', name: 'check claims', from: 2_640, to: 2_660, attrs: { sentences: sources + 1, unsupported: 0 } },
    { key: 'route', parent: 'run', kind: 'system.step', name: 'route', from: 2_660, to: 2_670, attrs: { outcome: 'awaiting_approval' } },
    { key: 'run', parent: undefined, kind: 'system.run', name: 'support ticket', from: 0, to: 2_675, attrs: { language: 'en' } },
  ]
}

/** Plans the pipeline of a ticket that is handed to a person before any draft. */
function escalationPlan(reason: string): Plan[] {
  return [
    { key: 'redact', parent: 'run', kind: 'system.step', name: 'redact PII', from: 0, to: 3, attrs: { redactions: 0 } },
    { key: 'guard', parent: 'run', kind: 'system.step', name: 'screen for injection', from: 3, to: 190, attrs: { flagged: reason === 'injection' } },
    ...gatewayCall('guard', 'lb-guard', 'groq/llama-prompt-guard-2-86m', 8, 185, 140),
    { key: 'route', parent: 'run', kind: 'system.step', name: 'route', from: 190, to: 195, attrs: { outcome: 'escalated', reason } },
    { key: 'run', parent: undefined, kind: 'system.run', name: 'support ticket', from: 0, to: 200, attrs: { language: 'en' } },
  ]
}

/**
 * Makes the spans of one run that started at `startedAt` (Unix milliseconds): a draft's, or
 * an escalation's when `escalation` names the reason. They are in the order a stream holds
 * them, which is the order the spans ended, so the root span comes last.
 */
export function mockSpans(runId: string, startedAt: number, escalation: string | undefined, sources: number): MockSpan[] {
  const plans = escalation === undefined ? draftPlan(Math.max(sources, 1)) : escalationPlan(escalation)
  return plans
    .map((plan, index) => ({ plan, index }))
    .sort((a, b) => a.plan.to - b.plan.to || b.index - a.index)
    .map(({ plan }): MockSpan => ({
      v: 1,
      runId,
      system: 'lb-01',
      spanId: spanId(runId, plan.key),
      ...(plan.parent === undefined ? {} : { parentId: spanId(runId, plan.parent) }),
      kind: plan.kind,
      name: plan.name,
      status: 'ok',
      startMs: startedAt + plan.from,
      endMs: startedAt + plan.to,
      attrs: plan.attrs,
    }))
}
