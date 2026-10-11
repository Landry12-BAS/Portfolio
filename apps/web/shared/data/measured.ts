// What a system's datasheet reports as measured: one row per curated sample, reduced from the sample's
// recording in apps/web/recordings (made against the real providers, see the folder's README). An electronic
// datasheet lists characteristics as measured under stated conditions; this is that table for an AI system,
// so the figures on the page are the recordings' and nothing is typed in by hand. The constants are written
// out so that the page ships with them; test/unit/measured.test.ts reduces every recording the same way and
// fails when a constant drifts from its file.
import type { Recording } from '@lb/contracts'

import type { HeroTrace } from './hero-trace'
import { HERO_TRACE } from './hero-trace'

/** The recorded run each datasheet draws as its first figure, for the systems that have one. */
export const FIGURES: Readonly<Record<string, HeroTrace>> = {
  'lb-01': HERO_TRACE,
}

/** How a recorded run ended: a draft waiting for a person, or handed to a person early, with the reason. */
export type MeasuredOutcome = 'draft' | 'escalated'

/** One curated sample as its recording measured it. */
export interface MeasuredRun {
  sample: string
  language: 'en' | 'cs'
  /** The steps the run took, out of the datasheet's chain. */
  steps: number
  /** The calls made through the gateway, model and embedding calls alike. */
  calls: number
  tokensIn: number
  tokensOut: number
  durationMs: number
  outcome: MeasuredOutcome
  /** Why the run was handed to a person, in the back end's own word, such as `injection`. */
  reason?: string
  /** The day the recording was made, as the page prints it. */
  recordedAt: string
}

/** The last state the back end reported for the run's ticket, as the recording's final exchange holds it. */
interface TicketEnd {
  status: string
  escalation_reason?: string
}

/** Reads the ticket's end from a recorded response body, or nothing when the body is not a ticket. */
function ticketEndOf(body: unknown): TicketEnd | undefined {
  if (typeof body !== 'object' || body === null || !('status' in body)) return undefined
  const status = body.status
  if (typeof status !== 'string') return undefined
  const reason = 'escalation_reason' in body && typeof body.escalation_reason === 'string' ? body.escalation_reason : undefined
  return reason ? { status, escalation_reason: reason } : { status }
}

/** Reduces a recording to the row its datasheet shows: the counts and times of the trace, and how the run ended. */
export function measuredOf(recording: Recording): MeasuredRun {
  const spans = recording.trace.spans
  const run = spans.find(span => span.kind === 'system.run')
  const calls = spans.filter(span => span.kind === 'gateway.call')
  const tokens = (key: 'inputTokens' | 'outputTokens'): number => calls.reduce((sum, call) => {
    const value = (call.attrs as Record<string, unknown>)[key]
    return sum + (typeof value === 'number' ? value : 0)
  }, 0)
  // The last exchange is the ticket read back once the run is over, so its status is the run's end.
  const end = ticketEndOf(recording.exchanges.at(-1)?.response.body)
  const escalated = end?.status === 'escalated'
  return {
    sample: recording.sample,
    language: recording.language,
    steps: spans.filter(span => span.kind === 'system.step' || span.kind === 'system.tool').length,
    calls: calls.length,
    tokensIn: tokens('inputTokens'),
    tokensOut: tokens('outputTokens'),
    durationMs: run ? run.endMs - run.startMs : 0,
    outcome: escalated ? 'escalated' : 'draft',
    ...(escalated && end?.escalation_reason ? { reason: end.escalation_reason } : {}),
    recordedAt: recording.recordedAt.slice(0, 10),
  }
}

/** The measured rows of each system that has them, in the order of its curated samples. */
export const MEASURED: Readonly<Record<string, readonly MeasuredRun[]>> = {
  'lb-01': [
    { sample: 'torn-bag', language: 'en', steps: 9, calls: 5, tokensIn: 1351, tokensOut: 1126, durationMs: 10909, outcome: 'draft', recordedAt: '2026-10-07' },
    { sample: 'late-parcel', language: 'en', steps: 9, calls: 5, tokensIn: 1302, tokensOut: 935, durationMs: 4637, outcome: 'draft', recordedAt: '2026-10-07' },
    { sample: 'wrong-grind', language: 'en', steps: 9, calls: 6, tokensIn: 2482, tokensOut: 1800, durationMs: 6689, outcome: 'draft', recordedAt: '2026-10-07' },
    { sample: 'other-customers-order', language: 'en', steps: 9, calls: 5, tokensIn: 1181, tokensOut: 357, durationMs: 2216, outcome: 'draft', recordedAt: '2026-10-07' },
    { sample: 'injection-admin-mode', language: 'en', steps: 3, calls: 1, tokensIn: 35, tokensOut: 0, durationMs: 457, outcome: 'escalated', reason: 'injection', recordedAt: '2026-10-07' },
    { sample: 'stale-decaf', language: 'cs', steps: 9, calls: 6, tokensIn: 2557, tokensOut: 1637, durationMs: 5225, outcome: 'draft', recordedAt: '2026-10-07' },
    { sample: 'broken-grinder', language: 'cs', steps: 9, calls: 5, tokensIn: 1493, tokensOut: 646, durationMs: 2721, outcome: 'draft', recordedAt: '2026-10-07' },
    { sample: 'cancel-order', language: 'cs', steps: 9, calls: 5, tokensIn: 1312, tokensOut: 544, durationMs: 3196, outcome: 'draft', recordedAt: '2026-10-07' },
  ],
}

/** The day the rows of a system were recorded, when they share one; otherwise nothing, and the table says it row by row. */
export function recordedDayOf(rows: readonly MeasuredRun[]): string | undefined {
  const days = new Set(rows.map(row => row.recordedAt))
  return days.size === 1 ? rows[0]?.recordedAt : undefined
}
