// A short memory of the pages of traces the gateway has just sent. The route that serves a trace
// (handlers/spans.ts) needs no session, and each read of a full page costs the gateway about 10 ms of
// CPU, so the site does not ask twice for what it was told a moment ago: a page is kept for a second,
// and readers who ask while one is being fetched wait for that fetch instead of starting their own.
// A Scope polls about twice a second, so it still sees spans a second after they were written at
// worst; a trace shared by many viewers costs the gateway one read a second, not one per viewer.
//
// A trace is the same for everyone who has the run's ID, so nothing in a page depends on who asked.
// Only a page the gateway answered (200) is kept: an error, a run that is not there yet and a refusal
// are asked about again, so a run's first span is never hidden behind an old "not found". The memory
// is bounded in entries and in bytes, so a flood of different reads cannot grow it without limit; the
// gateway counts the reads of each run itself (services/gateway/src/read-limit.ts) for those that get
// past it. Each instance of the site keeps its own.

/** What is kept of an answer: the status and body, and the headers worth passing on. */
export interface TraceAnswer {
  status: number
  body: string | undefined
  headers: Record<string, string>
}

/** How the memory is bounded. */
export interface TraceCacheOptions {
  // How long a page is kept, in milliseconds.
  ttlMs: number
  // The most pages kept at once.
  maxEntries: number
  // The most characters of page bodies kept at once.
  maxBytes: number
}

/** What the site keeps: a page for a second, 200 of them, 4 MB in all (a page of 200 spans is about 60 KB). */
export const TRACE_CACHE: TraceCacheOptions = { ttlMs: 1_000, maxEntries: 200, maxBytes: 4 * 1_024 * 1_024 }

/** One page kept, and when it stops being fresh. */
interface Kept {
  answer: TraceAnswer
  freshUntilMs: number
  size: number
}

/** Remembers the gateway's pages of traces for a moment, and shares one fetch among those who ask at once. */
export class TraceCache {
  readonly #now: () => number
  readonly #options: TraceCacheOptions
  // In the order the pages were kept, oldest first: a Map keeps the order its keys were set in.
  readonly #kept = new Map<string, Kept>()
  // The fetches in progress, by what they fetch.
  readonly #fetching = new Map<string, Promise<TraceAnswer>>()
  #bytes = 0

  constructor(now: () => number, options: TraceCacheOptions = TRACE_CACHE) {
    this.#now = now
    this.#options = options
  }

  /** The number of pages kept now, fresh or not yet cleared away. */
  get size(): number {
    return this.#kept.size
  }

  /**
   * Gives the page for a key: the one kept if it is still fresh, the fetch already in progress if there is
   * one, or else what `fetchPage` returns, which is kept when it is a 200. A fetch that fails fails for every
   * reader waiting on it, and leaves nothing behind, so the next read asks again.
   */
  async read(key: string, fetchPage: () => Promise<TraceAnswer>): Promise<TraceAnswer> {
    const kept = this.#kept.get(key)
    if (kept !== undefined && kept.freshUntilMs > this.#now()) return kept.answer
    const inProgress = this.#fetching.get(key)
    if (inProgress !== undefined) return inProgress
    const fetching = this.#fetchAndKeep(key, fetchPage)
    this.#fetching.set(key, fetching)
    try {
      return await fetching
    }
    finally {
      this.#fetching.delete(key)
    }
  }

  /** Forgets every page, and lets go of every fetch in progress. */
  clear(): void {
    this.#kept.clear()
    this.#fetching.clear()
    this.#bytes = 0
  }

  /** Fetches a page and keeps it when it is a 200. */
  async #fetchAndKeep(key: string, fetchPage: () => Promise<TraceAnswer>): Promise<TraceAnswer> {
    const answer = await fetchPage()
    if (answer.status === 200 && answer.body !== undefined) this.#keep(key, answer, answer.body.length)
    return answer
  }

  /** Keeps a page, and clears away pages that are stale or that no longer fit. */
  #keep(key: string, answer: TraceAnswer, size: number): void {
    const nowMs = this.#now()
    this.#drop(key)
    this.#kept.set(key, { answer, freshUntilMs: nowMs + this.#options.ttlMs, size })
    this.#bytes += size
    for (const [name, page] of [...this.#kept]) {
      if (page.freshUntilMs <= nowMs) this.#drop(name)
    }
    // Over the limits, the page kept longest ago goes first; the new one goes last, and only if it alone is too big.
    for (const name of [...this.#kept.keys()]) {
      if (this.#kept.size <= this.#options.maxEntries && this.#bytes <= this.#options.maxBytes) break
      this.#drop(name)
    }
  }

  /** Forgets one page, if it is kept. */
  #drop(key: string): void {
    const page = this.#kept.get(key)
    if (page === undefined) return
    this.#bytes -= page.size
    this.#kept.delete(key)
  }
}
