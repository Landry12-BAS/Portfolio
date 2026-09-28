import { randomBytes } from 'node:crypto'

import type { Redis } from 'ioredis'

// Run spans: the gateway's record of each model call and each attempt behind it, for
// the Scope panel and for the measured numbers on each datasheet. They carry
// metadata only (models, timings, token counts), never prompts or answers.

export type SpanKind = 'gateway.call' | 'gateway.attempt'
export type SpanStatus = 'ok' | 'error' | 'skipped'

export interface Span {
  v: 1
  runId: string
  system: string
  spanId: string
  parentId: string | undefined
  kind: SpanKind
  name: string
  status: SpanStatus
  startMs: number
  endMs: number
  attrs: Record<string, string | number | boolean>
}

export function newSpanId(): string {
  return randomBytes(8).toString('hex')
}

export interface SpanSink {
  emit(spans: readonly Span[]): Promise<void>
}

interface Logger {
  warn(details: object, message: string): void
}

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

  runStream(runId: string): string {
    return `${this.#prefix}run:${runId}:spans`
  }

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
