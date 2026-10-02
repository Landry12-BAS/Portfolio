// How the Scope follows a live run: how long to wait between reads of its trace, and how to add
// each page that comes back to what is already known. The trace route is read by polling, not
// streamed (docs/STACK.md leaves streaming to the systems that need tokens as they are made), so
// the waiting is arithmetic worth testing apart from the store that does the reading.
import type { Span } from '@lb/contracts'

/** How long to wait before the first read of a run that has only just started. */
export const FIRST_READ_DELAY_MS = 300
/** How long to wait after a read that brought new spans: the run is moving, so look again soon. */
export const BUSY_READ_DELAY_MS = 600
/** The longest wait between reads, reached after several reads that brought nothing. */
export const QUIET_READ_DELAY_MS = 2_500
/** How long the Scope follows a run before it says the trace has stopped arriving. */
export const GIVE_UP_AFTER_MS = 120_000
/** How long the Scope keeps looking for the end of a run that the board already knows is over. */
export const SETTLE_AFTER_MS = 10_000

/** What the last read found, which decides how long to wait for the next. */
export interface ReadOutcome {
  // The page said more spans were already waiting: read again at once.
  more: boolean
  // How many spans were new.
  added: number
  // How many reads in a row brought nothing new, this one included.
  quietReads: number
}

/** Decides how many milliseconds to wait before the next read of a run's trace. */
export function readDelay(outcome: ReadOutcome): number {
  if (outcome.more) return 0
  if (outcome.added > 0) return BUSY_READ_DELAY_MS
  // Quiet reads back off from a second to the cap, so an idle run costs the gateway little.
  return Math.min(1_000 + (outcome.quietReads - 1) * 500, QUIET_READ_DELAY_MS)
}

/** Adds a page's spans to the known ones, in the order they arrived and without repeating any. */
export function mergeSpans(known: readonly Span[], page: readonly Span[]): { spans: Span[], added: number } {
  const seen = new Set(known.map(span => span.spanId))
  const fresh = page.filter((span) => {
    if (seen.has(span.spanId)) return false
    seen.add(span.spanId)
    return true
  })
  return { spans: [...known, ...fresh], added: fresh.length }
}
