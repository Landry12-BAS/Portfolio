// How often one run's trace may be read. The route that serves a trace (routes/runs.ts) needs no
// visitor behind it: the site's server asks for any run whose ID it is given, and a read of a full page
// costs the gateway about 10 ms of CPU, which no model call should have to wait for. So each run has a
// bucket of reads that refills at a steady rate: a burst is fine (a permalink pages through a long trace at
// once), a flood of reads of one run is answered 429. The buckets live in this process, not in Redis: the
// gateway is one process, nothing here has to survive a restart, and the check must cost less than the read.
//
// The count is of runs, never of who asked. Only the site's server may read a trace, so there is no
// visitor to count; a run the visitor does not have the ID of cannot be read at all.

/** How a limiter is set. */
export interface ReadLimitOptions {
  // The most reads of one run that can be made at once, and the number a run starts with.
  burst: number
  // How many reads of a run come back each second.
  perSecond: number
  // The most runs kept in memory. When a new one doesn't fit, the one read least recently is forgotten, which
  // gives it a whole burst again; a flood of made-up run IDs can only do that, never grow this without limit.
  maxRuns: number
}

/**
 * What the gateway allows for a trace: 20 reads of one run at once, and 5 more every second. A Scope that
 * follows a run polls about twice a second at its busiest (apps/web/app/board-kit/follow.ts), and a permalink
 * of a long trace pages through it in a handful of reads at once, so none of that comes near the limit; a
 * flood does, and it costs at most 5 reads a second of one run, about 50 ms of CPU, however many ask. Room for
 * 5,000 runs is a few hundred kilobytes.
 */
export const TRACE_READ_LIMIT: ReadLimitOptions = { burst: 20, perSecond: 5, maxRuns: 5_000 }

/** One run's bucket: the reads left, as of a moment. */
interface Bucket {
  reads: number
  atMs: number
}

/** Counts the reads of each run against a bucket that refills at a steady rate. */
export class ReadLimiter {
  readonly #now: () => number
  readonly #options: ReadLimitOptions
  // In the order the runs were last read, oldest first: a Map keeps the order its keys were set in.
  readonly #buckets = new Map<string, Bucket>()

  constructor(now: () => number, options: ReadLimitOptions) {
    if (!Number.isInteger(options.burst) || options.burst < 1) throw new RangeError('A read limit needs a burst of at least one read.')
    if (!(options.perSecond > 0) || !Number.isFinite(options.perSecond)) throw new RangeError('A read limit needs a refill rate above zero.')
    if (!Number.isInteger(options.maxRuns) || options.maxRuns < 1) throw new RangeError('A read limit needs room for at least one run.')
    this.#now = now
    this.#options = options
  }

  /** The number of runs it remembers now. */
  get size(): number {
    return this.#buckets.size
  }

  /**
   * Counts one read of a run. Returns undefined when it may go ahead, or how many milliseconds to wait
   * until a read of this run would be let through. A read that is refused is not counted.
   */
  take(runId: string): number | undefined {
    const nowMs = this.#now()
    const reads = this.#readsLeft(runId, nowMs)
    if (reads < 1) return Math.ceil(((1 - reads) / this.#options.perSecond) * 1_000)
    // Setting the run again at the end of the map keeps the map in the order the runs were last read.
    this.#buckets.delete(runId)
    this.#buckets.set(runId, { reads: reads - 1, atMs: nowMs })
    this.#forgetTheOldest()
    return undefined
  }

  /** Works out how many reads a run has now: what it had, plus what has come back since, up to the burst. */
  #readsLeft(runId: string, nowMs: number): number {
    const bucket = this.#buckets.get(runId)
    if (bucket === undefined) return this.#options.burst
    const refilled = ((nowMs - bucket.atMs) * this.#options.perSecond) / 1_000
    return Math.min(this.#options.burst, bucket.reads + Math.max(0, refilled))
  }

  /** Forgets the runs read longest ago, until the rest fit in the room given. */
  #forgetTheOldest(): void {
    while (this.#buckets.size > this.#options.maxRuns) {
      const oldest = this.#buckets.keys().next().value
      if (oldest === undefined) return
      this.#buckets.delete(oldest)
    }
  }
}
