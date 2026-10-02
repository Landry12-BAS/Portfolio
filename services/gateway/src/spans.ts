// Run spans: the gateway's record of each model call and each attempt behind it, for
// the Scope panel and for the measured numbers on each datasheet. They carry
// metadata only (models, timings, token counts), never prompts or answers.
import { randomBytes } from 'node:crypto'

import type { Redis } from 'ioredis'
import { z } from 'zod'

/**
 * What a span describes. The gateway writes a whole model call or one attempt at one
 * model; the systems write their whole run, a step of it, or a tool call (lb-common's
 * tracers). All of them share one stream per run, and the Scope route reads all of them.
 */
export type SpanKind = 'gateway.call' | 'gateway.attempt' | 'system.run' | 'system.step' | 'system.tool'
/** How a span ended; `skipped` marks a model the call passed over. */
export type SpanStatus = 'ok' | 'error' | 'skipped'

/** One step of a run, as the trace panel shows it. */
export interface Span {
  // Format version, so readers can evolve with it.
  v: 1
  runId: string
  system: string
  spanId: string
  // The call span for attempts; the system's own span (if it sent one) for calls.
  parentId: string | undefined
  kind: SpanKind
  name: string
  status: SpanStatus
  startMs: number
  endMs: number
  attrs: Record<string, string | number | boolean>
}

/** Makes a random 16-hex-digit span ID, the same size as an OpenTelemetry span ID. */
export function newSpanId(): string {
  return randomBytes(8).toString('hex')
}

/** Somewhere spans can be written. */
export interface SpanSink {
  emit(spans: readonly Span[]): Promise<void>
}

/** The one logging call the sink needs, so it doesn't depend on Fastify's logger type. */
interface Logger {
  warn(details: object, message: string): void
}

// Stream caps: enough for any run, and a bounded backlog for the persister.
const RUN_STREAM_MAXLEN = 1_000
const RUN_STREAM_TTL_SECONDS = 86_400
const ALL_STREAM_MAXLEN = 100_000

/**
 * Appends spans to two Redis streams: one per run, which the Scope reads live and the
 * systems' own tracers share, and one for every run, which a persister drains into
 * `platform.run_spans`. Both are capped. Telemetry never fails a call: errors are
 * logged and the spans dropped.
 */
export class RedisSpanSink implements SpanSink {
  readonly #redis: Redis
  readonly #prefix: string
  readonly #log: Logger

  constructor(redis: Redis, prefix: string, log: Logger) {
    this.#redis = redis
    this.#prefix = prefix
    this.#log = log
  }

  /** Returns the Redis key of a run's span stream. */
  runStream(runId: string): string {
    return `${this.#prefix}run:${runId}:spans`
  }

  /** Writes spans to both streams in one round trip; never throws. */
  async emit(spans: readonly Span[]): Promise<void> {
    if (spans.length === 0) return
    const pipeline = this.#redis.pipeline()
    for (const span of spans) {
      const json = JSON.stringify(span)
      const runStream = this.runStream(span.runId)
      pipeline.xadd(runStream, 'MAXLEN', '~', RUN_STREAM_MAXLEN, '*', 'span', json)
      pipeline.expire(runStream, RUN_STREAM_TTL_SECONDS)
      pipeline.xadd(`${this.#prefix}spans`, 'MAXLEN', '~', ALL_STREAM_MAXLEN, '*', 'span', json)
    }
    try {
      const results = await pipeline.exec()
      const failed = results?.find(([error]) => error)
      if (failed?.[0]) throw failed[0]
    }
    catch (error) {
      this.#log.warn({ err: error, spans: spans.length }, 'dropped run spans')
    }
  }
}

// What a span may hold when it is read back. The writers' own rules (short labels, finite
// numbers) are checked again here, so a span some system wrote carelessly can never reach
// the Scope with more than metadata in it.
const MAX_ATTR_TEXT = 200
const MAX_ATTRS = 64
// No honest span comes near this; a bigger stream entry is passed over unread.
const MAX_SPAN_JSON_LENGTH = 8_192
// Span names such as `check stock` or `groq/gpt-oss-120b`, and detail names such as `top_score`.
const SPAN_NAME = /^[\w .:/-]{1,100}$/
const ATTR_NAME = /^[a-z][\w.]{0,63}$/i
const SPAN_ID = /^[0-9a-f]{16}$/

/**
 * A span as the Scope route returns it: the fields of `Span`, checked again. The object
 * is strict, so a field nobody planned for is refused rather than passed along, and
 * detail values are short labels, numbers or flags.
 */
export const spanSchema = z.strictObject({
  v: z.literal(1),
  runId: z.string().regex(/^[\w-]{8,64}$/),
  system: z.string().regex(/^lb-\d{2}$/),
  spanId: z.string().regex(SPAN_ID),
  parentId: z.string().regex(SPAN_ID).optional(),
  kind: z.string().regex(/^[a-z]{2,16}\.[a-z]{2,16}$/),
  name: z.string().regex(SPAN_NAME),
  status: z.enum(['ok', 'error', 'skipped']),
  startMs: z.int().nonnegative(),
  endMs: z.int().nonnegative(),
  attrs: z.record(z.string().regex(ATTR_NAME), z.union([z.string().max(MAX_ATTR_TEXT), z.number(), z.boolean()]))
    .refine(attrs => Object.keys(attrs).length <= MAX_ATTRS, `at most ${MAX_ATTRS} details`),
})

/** One span as read back from a run's stream. */
export type RunSpan = z.infer<typeof spanSchema>

/** Tells whether a span is the root of its run: the system's own whole-run span, with no parent, which it writes last. */
export function isRunRoot(span: RunSpan): boolean {
  return span.kind === 'system.run' && span.parentId === undefined
}

/** One entry of a Redis stream: its ID, and its fields as name, value, name, value. */
type StreamEntry = [id: string, fields: string[]]

/**
 * Reads the span out of one stream entry, or returns undefined when the entry isn't a
 * valid, small, metadata-only span. Systems and the gateway write one `span` field.
 */
export function parseSpanEntry(fields: readonly string[]): RunSpan | undefined {
  const position = fields.indexOf('span')
  const json = position === -1 ? undefined : fields[position + 1]
  if (json === undefined || json.length > MAX_SPAN_JSON_LENGTH) return undefined
  let value: unknown
  try {
    value = JSON.parse(json)
  }
  catch {
    return undefined
  }
  const parsed = spanSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** What a reader asks of a run's stream: where to continue, how much, and which systems it may see. */
export interface SpanQuery {
  // The ID of the last entry the reader already has, from the previous page's `cursor`.
  after: string | undefined
  // Spans per page.
  limit: number
  // Spans of any other system are passed over, as if they were not there.
  systems: ReadonlySet<string>
}

/** One page of a run's spans, in the order they were written. */
export interface RunSpanPage {
  spans: RunSpan[]
  // The ID of the last entry looked at: send it back as `after` to get what was written since.
  cursor: string
  // Whether more spans were already waiting when this page was cut.
  more: boolean
  // Whether the run's root span has been written, so the run is over. Runs that have no root span, such as a conversation, never finish.
  finished: boolean
}

// A page never carries more than this many bytes of spans, so a response stays small.
const MAX_PAGE_JSON_LENGTH = 256 * 1_024
// How far back from the end of the stream to look for the root span, which is written last.
const TAIL_ENTRIES = 32

/** Reads an answer to one command of a pipeline, or fails the read when the command failed. */
function answerOf(result: [Error | null, unknown] | undefined): unknown {
  if (!result || result[0]) throw result?.[0] ?? new Error('Redis did not answer.')
  return result[1]
}

/** Reads the entries a stream range command answered with. */
function entriesOf(result: [Error | null, unknown] | undefined): StreamEntry[] {
  const answer = answerOf(result)
  return Array.isArray(answer) ? answer as StreamEntry[] : []
}

/**
 * Reads a run's spans back from its stream, for the Scope. It uses `XRANGE` and
 * `XREVRANGE` on one `run:<id>:spans` key and nothing else, which the gateway's Redis user
 * may do there (infra/redis/users.acl.tmpl).
 */
export class RedisSpanReader {
  readonly #redis: Redis
  readonly #prefix: string
  readonly #log: Logger

  constructor(redis: Redis, prefix: string, log: Logger) {
    this.#redis = redis
    this.#prefix = prefix
    this.#log = log
  }

  /** Returns the Redis key of a run's span stream. */
  runStream(runId: string): string {
    return `${this.#prefix}run:${runId}:spans`
  }

  /**
   * Reads the next page of a run's spans, or returns undefined when the run is not known
   * to this reader: it has no stream (it never existed, or its day is up), or it belongs to
   * a system the reader may not see, which reads exactly the same. A Redis failure throws,
   * and the route answers 503.
   */
  async read(runId: string, query: SpanQuery): Promise<RunSpanPage | undefined> {
    const key = this.runStream(runId)
    const results = await this.#redis.pipeline()
      .xrange(key, query.after === undefined ? '-' : `(${query.after}`, '+', 'COUNT', query.limit + 1)
      .xrevrange(key, '+', '-', 'COUNT', TAIL_ENTRIES)
      .xrange(key, '-', '+', 'COUNT', 1)
      .exec()
    // The run's first span names its system, and every span of a run shares it.
    const first = entriesOf(results?.[2])[0]
    const origin = first === undefined ? undefined : parseSpanEntry(first[1])
    if (origin === undefined || !query.systems.has(origin.system)) return undefined

    const waiting = entriesOf(results?.[0])
    const page = this.#cut(runId, waiting.slice(0, query.limit), query)
    const tail = entriesOf(results?.[1]).map(([, fields]) => parseSpanEntry(fields))
    const finished = [...page.spans, ...tail].some(span => span !== undefined && query.systems.has(span.system) && isRunRoot(span))
    return {
      spans: page.spans,
      cursor: page.cursor ?? query.after ?? '0-0',
      more: waiting.length > query.limit || page.cutShort,
      finished,
    }
  }

  /**
   * Keeps the valid spans of this run that the reader may see, up to the page's byte budget.
   * Entries that are not valid spans, spans of another run and spans of other systems are
   * passed over, but the cursor still moves past them so a poll never stalls on one.
   */
  #cut(runId: string, entries: readonly StreamEntry[], query: SpanQuery): { spans: RunSpan[], cursor: string | undefined, cutShort: boolean } {
    const spans: RunSpan[] = []
    let cursor: string | undefined
    let length = 0
    let passedOver = 0
    for (const [id, fields] of entries) {
      const span = parseSpanEntry(fields)
      if (span === undefined || span.runId !== runId) {
        passedOver += 1
      }
      else if (query.systems.has(span.system)) {
        const size = JSON.stringify(span).length
        if (length + size > MAX_PAGE_JSON_LENGTH && spans.length > 0) return { spans, cursor, cutShort: true }
        length += size
        spans.push(span)
      }
      cursor = id
    }
    // Counts only: the log never carries a run's ID, which is the key to its trace.
    if (passedOver > 0) this.#log.warn({ passedOver }, 'passed over stream entries that are not valid spans')
    return { spans, cursor, cutShort: false }
  }
}
