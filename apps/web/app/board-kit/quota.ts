// A visitor's daily allowance for one demo, worked out from what the back end already tells the
// board. The back ends count a day from midnight UTC and the session turns over at the same moment
// (docs/SECURITY.md, section 2), so the tickets, questions or runs a session has made are exactly
// what it has used today. The back end stays the authority: a refusal ("too many requests") sets
// the allowance to nothing left whatever this count says.

/** How much of a daily allowance has been used. */
export interface Quota {
  limit: number
  used: number
  remaining: number
  // When the allowance starts again: the next midnight UTC.
  resetsAt: string
}

// One day, in milliseconds.
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Counts the things a session made since the day began (the `resetsAt` of the day before) and
 * subtracts them from the limit. `madeAt` holds the time each one was made, as ISO 8601 text.
 */
export function quotaFromRuns(madeAt: readonly string[], limit: number, resetsAt: string): Quota {
  const dayStart = Date.parse(resetsAt) - DAY_MS
  const used = madeAt.filter(time => Date.parse(time) >= dayStart).length
  return { limit, used, remaining: Math.max(limit - used, 0), resetsAt }
}

/** The allowance after a refusal for being over it: nothing left, whatever the count said. */
export function exhausted(quota: Quota): Quota {
  return { ...quota, used: Math.max(quota.used, quota.limit), remaining: 0 }
}

/** Makes an allowance that is all still to use, for a board that has not counted yet. */
export function untouched(limit: number, resetsAt: string): Quota {
  return { limit, used: 0, remaining: limit, resetsAt }
}

/** Says how many whole hours and minutes are left until a moment, for "resets in 5 h 20 min". */
export function timeUntil(resetsAt: string, now: number): { hours: number, minutes: number } {
  const left = Math.max(Date.parse(resetsAt) - now, 0)
  return { hours: Math.floor(left / 3_600_000), minutes: Math.floor((left % 3_600_000) / 60_000) }
}
