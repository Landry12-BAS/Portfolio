// The Scope's data: a run's spans, and the pages the gateway's trace route hands out
// (services/gateway/src/routes/runs.ts). A span is metadata only (names, timings, models,
// token counts, scores), and this schema is strict, so a field nobody planned for is refused by the
// browser as it is by the gateway. The gateway keeps its own copy of the span schema, since it
// can't depend on this package; a test in the gateway checks that the two accept the same spans.
import { z } from 'zod'

// Span names such as `check stock` or `groq/gpt-oss-120b`, and detail names such as `top_score`.
const SPAN_NAME = /^[\w .:/-]{1,100}$/
const ATTR_NAME = /^[a-z][\w.]{0,63}$/i
const SPAN_ID = /^[0-9a-f]{16}$/

/** One step of a run, in the gateway's span format (version 1). */
export const spanSchema = z.strictObject({
  v: z.literal(1),
  runId: z.string().regex(/^[\w-]{8,64}$/),
  system: z.string().regex(/^lb-\d{2}$/),
  spanId: z.string().regex(SPAN_ID),
  parentId: z.string().regex(SPAN_ID).optional(),
  // `system.run`, `system.step`, `system.tool`, `gateway.call` or `gateway.attempt`.
  kind: z.string().regex(/^[a-z]{2,16}\.[a-z]{2,16}$/),
  name: z.string().regex(SPAN_NAME),
  status: z.enum(['ok', 'error', 'skipped']),
  startMs: z.int().nonnegative(),
  endMs: z.int().nonnegative(),
  attrs: z.record(z.string().regex(ATTR_NAME), z.union([z.string().max(200), z.number(), z.boolean()]))
    .refine(attrs => Object.keys(attrs).length <= 64, 'at most 64 details'),
})

/** One span of a run. */
export type Span = z.infer<typeof spanSchema>

/** One page of a run's spans, as the trace route answers. */
export const tracePageSchema = z.strictObject({
  runId: z.string().regex(/^[\w-]{8,64}$/),
  // At most one page: the gateway never sends more than 500.
  spans: z.array(spanSchema).max(500),
  // The ID of the last entry looked at: send it back as `after` to get what was written since.
  cursor: z.string().regex(/^\d{1,16}-\d{1,16}$/),
  // More spans were already waiting beyond this page.
  more: z.boolean(),
  // The run's root span has been written: the run is over.
  finished: z.boolean(),
})

/** One page of a run's trace. */
export type TracePage = z.infer<typeof tracePageSchema>

/** What a trace comes to, in numbers a visitor can read: how many steps, how many model calls, how long. */
export interface TraceSummary {
  // Steps and tool calls of the system's own.
  steps: number
  // Model calls the gateway made for the run, one for each call to an alias, however many attempts it took.
  modelCalls: number
  // Wall-clock time of the whole run in milliseconds: the root span's, or the first start to the last end.
  durationMs: number
}

/** Summarises a run's spans. A trace with no spans comes to zeros. */
export function summariseTrace(spans: readonly Span[]): TraceSummary {
  if (spans.length === 0) return { steps: 0, modelCalls: 0, durationMs: 0 }
  const root = spans.find(span => span.kind === 'system.run' && span.parentId === undefined)
  const start = root?.startMs ?? Math.min(...spans.map(span => span.startMs))
  const end = root?.endMs ?? Math.max(...spans.map(span => span.endMs))
  return {
    steps: spans.filter(span => span.kind === 'system.step' || span.kind === 'system.tool').length,
    modelCalls: spans.filter(span => span.kind === 'gateway.call').length,
    durationMs: Math.max(end - start, 0),
  }
}
