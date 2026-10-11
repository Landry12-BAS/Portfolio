// The run the landing page's Scope plays: LB-01's torn-bag sample, recorded on 2026-10-07 against the real
// providers (apps/web/recordings/lb-01/torn-bag.json). The hero draws what this file holds, reduced from the
// recording to the nine steps and the model call under each, so the first paint needs no request. The
// constant is written out by hand so that it ships with the page; test/unit/hero-trace.test.ts reduces the
// recording the same way and fails when the two drift apart, so the numbers on the landing page are always
// the recording's.
import type { Recording } from '@lb/contracts'

/** How a step is drawn: the Scope's four channels, plus a plain step with no model behind it. */
export type HeroStepKind = 'step' | 'tool' | 'guard' | 'retrieval' | 'model'

/** One model call a step made through the gateway. */
export interface HeroCall {
  alias: string
  provider: string
  model: string
  tokens?: { in: number, out: number }
}

/** One step of the run, timed from the run's first instant. */
export interface HeroStep {
  name: string
  kind: HeroStepKind
  startMs: number
  endMs: number
  call?: HeroCall
}

/** The whole run, as the hero needs it. */
export interface HeroTrace {
  system: string
  sample: string
  recordedAt: string
  totalMs: number
  steps: HeroStep[]
}

/** Tells how a step is drawn from the call under it: the guard, the two retrieval aliases, any other model, or none. */
function kindOf(spanKind: string, call: HeroCall | undefined): HeroStepKind {
  if (spanKind === 'system.tool') return 'tool'
  if (!call) return 'step'
  if (call.alias === 'lb-guard') return 'guard'
  if (call.alias === 'lb-embed' || call.alias === 'lb-rerank') return 'retrieval'
  return 'model'
}

/** Reduces a recording to the trace the hero draws: the steps in order, each with the model call made under it. */
export function heroTraceOf(recording: Recording): HeroTrace {
  const spans = [...recording.trace.spans].sort((a, b) => a.startMs - b.startMs)
  const run = spans.find(span => span.kind === 'system.run')
  const first = run?.startMs ?? spans[0]?.startMs ?? 0
  const last = run?.endMs ?? Math.max(...spans.map(span => span.endMs))
  const steps = spans
    .filter(span => span.kind === 'system.step' || span.kind === 'system.tool')
    .map((span) => {
      const callSpan = spans.find(other => other.kind === 'gateway.call' && other.parentId === span.spanId)
      const attrs = (callSpan?.attrs ?? {}) as Record<string, unknown>
      const tokens = typeof attrs.inputTokens === 'number' && typeof attrs.outputTokens === 'number'
        ? { in: attrs.inputTokens, out: attrs.outputTokens }
        : undefined
      const call: HeroCall | undefined = callSpan
        ? { alias: String(attrs.alias ?? callSpan.name), provider: String(attrs.provider ?? ''), model: String(attrs.model ?? '').replace(/^[a-z-]+\//, ''), ...(tokens ? { tokens } : {}) }
        : undefined
      return { name: span.name, kind: kindOf(span.kind, call), startMs: span.startMs - first, endMs: span.endMs - first, ...(call ? { call } : {}) }
    })
  return { system: recording.system, sample: recording.sample, recordedAt: recording.recordedAt.slice(0, 10), totalMs: last - first, steps }
}

/** The recorded run the landing page plays. */
export const HERO_TRACE: HeroTrace = {
  system: 'lb-01',
  sample: 'torn-bag',
  recordedAt: '2026-10-07',
  totalMs: 10909,
  steps: [
    { name: 'redact PII', kind: 'step', startMs: 0, endMs: 0 },
    { name: 'screen for injection', kind: 'guard', startMs: 12, endMs: 874, call: { alias: 'lb-guard', provider: 'groq', model: 'llama-prompt-guard-2-86m', tokens: { in: 43, out: 0 } } },
    { name: 'classify', kind: 'model', startMs: 875, endMs: 1659, call: { alias: 'lb-fast', provider: 'groq', model: 'gpt-oss-20b', tokens: { in: 442, out: 169 } } },
    { name: 'hybrid search', kind: 'retrieval', startMs: 1660, endMs: 2263, call: { alias: 'lb-embed', provider: 'workers-ai', model: 'bge-m3' } },
    { name: 'rerank', kind: 'retrieval', startMs: 2263, endMs: 8385, call: { alias: 'lb-rerank', provider: 'workers-ai', model: 'bge-reranker-base' } },
    { name: 'look up order', kind: 'tool', startMs: 8386, endMs: 8390 },
    { name: 'draft with citations', kind: 'model', startMs: 8398, endMs: 10907, call: { alias: 'lb-tools', provider: 'groq', model: 'gpt-oss-120b', tokens: { in: 866, out: 957 } } },
    { name: 'check claims', kind: 'step', startMs: 10908, endMs: 10908 },
    { name: 'route', kind: 'step', startMs: 10909, endMs: 10909 },
  ],
}
