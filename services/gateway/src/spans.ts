// Run spans: the gateway's record of each model call and each attempt behind it, for
// the Scope panel and for the measured numbers on each datasheet. They carry
// metadata only (models, timings, token counts), never prompts or answers.
import { randomBytes } from 'node:crypto'

import type { Redis } from 'ioredis'

/** What a span describes: a whole model call, or one attempt at one model. */
export type SpanKind = 'gateway.call' | 'gateway.attempt'
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
