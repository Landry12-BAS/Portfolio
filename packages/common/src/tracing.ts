// Run spans from the systems' own code: the steps, tool calls and checks of a run.
//
// Spans use the gateway's format (services/gateway/src/spans.ts) and go to the same Redis
// streams, so one run's trace holds the system's steps with the gateway's model calls
// nested under them. They carry metadata only (names, timings, counts, scores), never a
// visitor's text or a model's answer. Telemetry never fails a run: a span that can't be
// written is logged and dropped. This is the twin of python/lb-common's lb_common.tracing.
//
//   await tracer.span('check stock', async (span) => {
//     const result = await lookUp(sku)
//     span.set('found', result.found)
//   })
import { randomBytes } from 'node:crypto'

import type { Redis } from 'ioredis'
import { z } from 'zod'

import { currentRun, currentSpanId, OutsideRunError, spanScope } from './run.ts'
import type { Run } from './run.ts'

/** How a span ended; `skipped` marks a step the run passed over. */
export type SpanStatus = 'ok' | 'error' | 'skipped'
/** What a system's span describes: its whole run, one step of it, or one tool call. */
export type SpanKind = 'system.run' | 'system.step' | 'system.tool'
/** A detail on a span: a label, a count, a score or a flag. */
export type AttrValue = string | number | boolean

// The gateway's stream caps, so both writers keep the streams the same.
const RUN_STREAM_MAXLEN = 1_000
const RUN_STREAM_TTL_SECONDS = 86_400
const ALL_STREAM_MAXLEN = 100_000

// The gateway's rule for LB_REDIS_PREFIX, such as `lb:`.
const REDIS_PREFIX = /^[a-z0-9-]{1,24}:$/
// Span names such as `check stock`, and detail names such as `top_score`.
const SPAN_NAME = /^[\w .:/-]{1,100}$/
const ATTR_NAME = /^[a-z]\w{0,63}$/i
// Details are short labels, such as a category or a model, not content.
const MAX_ATTR_TEXT = 200

/** One finished step of a run, in the gateway's span format (version 1). The same shape is read back from the streams. */
export const spanSchema = z.strictObject({
  v: z.literal(1),
  runId: z.string(),
  system: z.string(),
  spanId: z.string(),
  parentId: z.string().optional(),
  // A system kind such as `system.step`, or a gateway kind such as `gateway.call`.
  kind: z.string(),
  name: z.string(),
  status: z.enum(['ok', 'error', 'skipped']),
  startMs: z.int(),
  endMs: z.int(),
  attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
})

/** One finished span. */
export type Span = z.infer<typeof spanSchema>

/** Makes a random span ID of 16 hex digits, the size the gateway and OpenTelemetry use. */
export function newSpanId(): string {
  return randomBytes(8).toString('hex')
}

/** Somewhere finished spans go. */
export interface SpanWriter {
  /** Stores the spans. Must never reject: telemetry can't be allowed to fail a run. */
  write: (spans: readonly Span[]) => Promise<void>
}

/** The one logging call the writer needs, so it doesn't depend on a logger's type. */
export interface WarnLogger {
  warn: (details: object, message: string) => void
}

/**
 * Appends spans to Redis streams, exactly as the gateway's RedisSpanSink does. Each span
 * goes to its run's stream, which the Scope reads live, and to the stream of every run,
 * which a persister drains into `platform.run_spans`. Both are capped. Give it a Redis
 * client created with `enableOfflineQueue: false`, so an outage fails fast and the span
 * is dropped instead of queueing up.
 */
export class RedisSpanWriter implements SpanWriter {
  readonly #redis: Redis
  readonly #prefix: string
  readonly #log: WarnLogger | undefined

  /** Writes to `redis` under the gateway's key prefix (its LB_REDIS_PREFIX). */
  constructor(redis: Redis, prefix = 'lb:', log?: WarnLogger) {
    if (!REDIS_PREFIX.test(prefix)) throw new RangeError('The prefix is lowercase letters, digits and hyphens, ending in a colon, such as lb:.')
    this.#redis = redis
    this.#prefix = prefix
    this.#log = log
  }

  /** Returns the Redis key of a run's span stream. */
  runStream(runId: string): string {
    return `${this.#prefix}run:${runId}:spans`
  }

  /** Writes the spans to both streams in one round trip. Never rejects. */
  async write(spans: readonly Span[]): Promise<void> {
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
      this.#log?.warn({ errorName: error instanceof Error ? error.name : 'unknown', spans: spans.length }, 'dropped run spans')
    }
  }
}

/** A span being recorded: where it sits in its run, and the details its step adds. */
export class OpenSpan {
  readonly spanId = newSpanId()
  readonly run: Run
  readonly parentId: string | undefined
  readonly name: string
  readonly kind: SpanKind
  readonly startMs: number
  status: SpanStatus = 'ok'
  readonly attrs: Record<string, AttrValue> = {}

  /** Opens a span of `run` called `name`, nested under `parentId`, started at `startMs`. */
  constructor(run: Run, name: string, kind: SpanKind, parentId: string | undefined, startMs: number) {
    if (!SPAN_NAME.test(name)) throw new RangeError(`${JSON.stringify(name.slice(0, 40))} is not a span name: 1 to 100 letters, digits, spaces or . : / - _.`)
    this.run = run
    this.name = name
    this.kind = kind
    this.parentId = parentId
    this.startMs = startMs
  }

  /**
   * Adds a detail to the span, such as a count, a score or a label. Details are metadata:
   * text is capped at 200 characters, and a visitor's own words must never be recorded here.
   */
  set(name: string, value: AttrValue): void {
    if (!ATTR_NAME.test(name)) throw new RangeError(`${JSON.stringify(name.slice(0, 40))} is not a detail name: letters, digits and underscores.`)
    if (typeof value === 'string' && value.length > MAX_ATTR_TEXT) throw new RangeError(`Span details are short labels of at most ${MAX_ATTR_TEXT} characters.`)
    if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError(`The detail ${name} is not a finite number.`)
    this.attrs[name] = value
  }

  /** Marks the step as passed over, for example because a cached result made it unnecessary. */
  skip(reason: string): void {
    this.status = 'skipped'
    this.set('outcome', reason)
  }

  /** Closes the span and returns it in the gateway's format. */
  finish(endMs: number): Span {
    return {
      v: 1,
      runId: this.run.runId,
      system: this.run.system,
      spanId: this.spanId,
      parentId: this.parentId,
      kind: this.kind,
      name: this.name,
      status: this.status,
      startMs: this.startMs,
      endMs,
      attrs: this.attrs,
    }
  }
}

/** Options for one span: its kind, and details known up front. */
export interface SpanOptions {
  kind?: SpanKind
  attrs?: Readonly<Record<string, AttrValue>>
}

/** Records the spans of the current run. */
export class Tracer {
  readonly #writer: SpanWriter
  readonly #clock: () => number

  /** Sends finished spans to `writer`. `clock` returns Unix time in milliseconds. */
  constructor(writer: SpanWriter, clock: () => number = Date.now) {
    this.#writer = writer
    this.#clock = clock
  }

  /**
   * Records `work` as a span of the current run, under the innermost open span. Model
   * calls made inside it nest under this span in the trace. If the work throws, the span
   * ends with status `error` and the error's name (never its message, which could quote
   * content), and the error carries on.
   */
  async span<Result>(name: string, work: (span: OpenSpan) => Promise<Result> | Result, options: SpanOptions = {}): Promise<Result> {
    const run = currentRun()
    if (!run) throw new OutsideRunError('Spans belong to a run: open one with runScope() first.')
    const span = new OpenSpan(run, name, options.kind ?? 'system.step', currentSpanId(), this.#clock())
    for (const [key, value] of Object.entries(options.attrs ?? {})) span.set(key, value)
    try {
      return await spanScope(span.spanId, () => work(span))
    }
    catch (error) {
      span.status = 'error'
      span.attrs.error = error instanceof Error ? error.name : 'Error'
      throw error
    }
    finally {
      try {
        await this.#writer.write([span.finish(this.#clock())])
      }
      catch {
        // A writer must not reject, but if one does, telemetry still can't fail the run.
      }
    }
  }
}
