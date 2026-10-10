// The recording of a curated sample's run: what a visitor sees when a demo replays a real run
// instead of spending quota (docs/PLAYBOOK.md, principle 5 and step 9). A recording holds the
// requests the board made, the answers it got and the spans of the run, as they were, so the
// board can show them again without a back end and say plainly that it is a replay.
//
// A recording is made by `just record-sample <system> <sample>` against a live back end. Only a
// recording whose `origin` is `live` is ever shown to a visitor: a `mock` one, made against the
// test mock, exists only so the tests can drive the player.
import { z } from 'zod'

import { spanSchema, summariseTrace } from '../scope/spans.ts'

// A system's name, such as `lb-01`, and a sample's, such as `torn-bag`.
const systemName = z.string().regex(/^lb-\d{2}$/)
const sampleName = z.string().regex(/^[a-z0-9-]{1,60}$/)

/** One request the board made while it ran the sample, and the answer it got. */
export const exchangeSchema = z.strictObject({
  request: z.strictObject({
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
    // The path as the board called it, such as `/api/lb01/tickets`.
    path: z.string().regex(/^\/api\/lb\d{2}\/[\w/.-]{0,200}$/),
    body: z.json().optional(),
  }),
  response: z.strictObject({
    status: z.int().min(200).max(599),
    body: z.json().optional(),
  }),
})

/** What a recording says about where it came from, and how big the run was, for the replay's label. */
export const recordingStatsSchema = z.strictObject({
  // Model calls the run made, as the trace counts them.
  modelCalls: z.int().nonnegative(),
  // Steps and tool calls of the system's own.
  steps: z.int().nonnegative(),
  // How long the run took, in milliseconds, as its root span measured it.
  durationMs: z.int().nonnegative(),
})

/** The recording of one curated sample. */
export const recordingSchema = z.strictObject({
  v: z.literal(1),
  system: systemName,
  sample: sampleName,
  // `live` for a run on the real back end, `mock` for the test mock's. Visitors only ever see `live`.
  origin: z.enum(['live', 'mock']),
  recordedAt: z.iso.datetime(),
  // The language the sample's ticket, question or description was written in.
  language: z.enum(['en', 'cs']),
  // The requests in the order the board made them: the one that started the run, then the reads that followed it.
  exchanges: z.array(exchangeSchema).min(1).max(20),
  trace: z.strictObject({
    runId: z.string().regex(/^[\w-]{8,64}$/),
    spans: z.array(spanSchema).min(1).max(1_000),
  }),
  stats: recordingStatsSchema,
}).refine(
  recording => recording.trace.spans.every(span => span.system === recording.system && span.runId === recording.trace.runId),
  'every span belongs to the recorded run and system',
).refine(
  (recording) => {
    const summary = summariseTrace(recording.trace.spans)
    return recording.stats.modelCalls === summary.modelCalls && recording.stats.steps === summary.steps && recording.stats.durationMs === summary.durationMs
  },
  'the stats are what the trace comes to',
)

/** One request and its answer. */
export type Exchange = z.infer<typeof exchangeSchema>
/** The recording of one curated sample. */
export type Recording = z.infer<typeof recordingSchema>

/** Tells whether a visitor may be shown a recording: only one made on the live back end. */
export function isShowable(recording: Recording): boolean {
  return recording.origin === 'live'
}
