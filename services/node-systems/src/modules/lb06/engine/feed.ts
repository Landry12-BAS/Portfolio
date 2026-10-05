// The feed of an incident: a Redis Stream per incident that the worker appends every event to and
// the API's sockets read, so a dashboard moves the moment the clock ticks. Postgres is the record
// (the log is written there first, in the transaction); the stream is the wire. Each entry carries
// the event's number, so a reader that joins late or reconnects can tell what it has and what it
// has missed, and the stream is capped and expires with the incident.
//
// Keys, for the Redis ACL: `<prefix>lb06:feed:<incident id>`.
import { lb06EventSchema } from '@lb/contracts'
import type { Lb06Event } from '@lb/contracts'
import type { Redis } from 'ioredis'

// The most entries a stream keeps: more than the log may hold.
const MAX_ENTRIES = 1_000
// How long a stream lives after its last entry: as long as the incident is kept.
const EXPIRE_SECONDS = 24 * 3_600

/** The stream key of an incident's feed. */
export function feedKey(prefix: string, incidentId: string): string {
  return `${prefix}lb06:feed:${incidentId}`
}

/** Appends events to a feed. */
export interface FeedWriter {
  // Appends the events, in order. A failure is logged by the caller and never fails the incident: Postgres holds the log.
  publish: (incidentId: string, events: readonly Lb06Event[]) => Promise<void>
}

/** The real writer, on a Redis connection. */
export class RedisFeedWriter implements FeedWriter {
  readonly #redis: Redis
  readonly #prefix: string

  /** Writes under the service's key prefix. */
  constructor(redis: Redis, prefix: string) {
    this.#redis = redis
    this.#prefix = prefix
  }

  /** Appends the events in one pipeline, and renews the stream's expiry. */
  async publish(incidentId: string, events: readonly Lb06Event[]): Promise<void> {
    if (events.length === 0) return
    const key = feedKey(this.#prefix, incidentId)
    const pipeline = this.#redis.pipeline()
    for (const event of events) pipeline.xadd(key, 'MAXLEN', '~', String(MAX_ENTRIES), '*', 'seq', String(event.seq), 'event', JSON.stringify(event))
    pipeline.expire(key, EXPIRE_SECONDS)
    await pipeline.exec()
  }
}

/** A writer that drops everything, for a process that has no feed (the documentation build). */
export const NO_FEED: FeedWriter = { publish: async () => {} }

/** One entry of a stream as read back: the stream id and the event. */
export interface FeedEntry {
  streamId: string
  event: Lb06Event
}

/** Reads a stream's entries after a stream id (`0-0` for all), blocking up to `blockMs` for new ones. An entry that does not fit the schema is dropped. */
export async function readFeed(redis: Redis, key: string, after: string, blockMs: number, count = 200): Promise<FeedEntry[]> {
  const answer = await redis.xread('COUNT', count, 'BLOCK', blockMs, 'STREAMS', key, after)
  if (!answer) return []
  const entries: FeedEntry[] = []
  for (const [, rows] of answer) {
    for (const [streamId, fields] of rows) {
      const index = fields.indexOf('event')
      const text = index === -1 ? undefined : fields[index + 1]
      if (text === undefined) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      }
      catch {
        continue
      }
      const event = lb06EventSchema.safeParse(parsed)
      if (event.success) entries.push({ streamId, event: event.data })
    }
  }
  return entries
}
