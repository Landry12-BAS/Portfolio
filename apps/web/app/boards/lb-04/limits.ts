// How the board paces its work on a review and what it asks of the visitor: how often it asks the service
// where a review stands, how long it waits before it says the review is taking too long, and how a
// contract's allowance for the day becomes the counter the limits panel draws. The numbers the service
// enforces (pages, size, contracts a day, redlines, how long a contract is kept) are the contracts
// package's, so the board never states a limit the service does not.
import { LB04_LIMITS } from '@lb/contracts'
import type { Lb04LimitsView } from '@lb/contracts'

import type { Quota } from '~/board-kit/quota'

/** How long the board waits before it first asks where a review stands: the review has only just been queued. */
export const FIRST_POLL_MS = 400
/** How often it asks while the review works. */
export const POLL_MS = 900
/** How often it asks once a review has taken more than a minute, so a slow one costs the site little. */
export const SLOW_POLL_MS = 2_000
/** How many questions are asked at the quick pace before the slow one. */
export const QUICK_POLLS = 60
/**
 * How long the board waits for a review to end before it says so. The slowest honest review makes three
 * attempts, each of which may wait for the long-document model for up to three minutes, so this is the
 * time after which a visitor is better told that the review is still going than left watching a spinner.
 */
export const REVIEW_PATIENCE_MS = 240_000
/** A review's trace appears a moment after the review is queued, so "no trace yet" is not an error for this long. */
export const SCOPE_GRACE_MS = 8_000
/** Reads of a review's state that fail for another reason are tried again this many times in a row before the board gives up. */
export const READ_FAILURES_ALLOWED = 3

/** The limits the board states before the service has answered, which are the ones the service enforces. */
export const DEFAULT_LIMITS = {
  contracts: LB04_LIMITS.contractsPerVisitorPerDay,
  maxPages: LB04_LIMITS.maxPages,
  maxFileBytes: LB04_LIMITS.maxFileBytes,
  keptMinutes: LB04_LIMITS.keptMinutes,
  redlines: LB04_LIMITS.redlinesPerContract,
} as const

/** Waits for the next question about a review: quick at first, slow once the review has run for a while. */
export function pollDelay(polls: number): number {
  if (polls === 0) return FIRST_POLL_MS
  return polls < QUICK_POLLS ? POLL_MS : SLOW_POLL_MS
}

/** Builds the counter the limits panel draws from the service's account of the visitor's day. */
export function quotaFrom(limits: Lb04LimitsView | undefined): Quota | undefined {
  return limits ? { ...limits.contracts, resetsAt: limits.resetsAt } : undefined
}

/** The account of a visitor's day after a contract was taken, until the service's own count is read: one more used. */
export function afterTaking(limits: Lb04LimitsView | undefined): Lb04LimitsView | undefined {
  if (!limits) return limits
  const used = Math.min(limits.contracts.used + 1, limits.contracts.limit)
  return { ...limits, contracts: { ...limits.contracts, used, remaining: Math.max(limits.contracts.limit - used, 0) } }
}

/** The account of a visitor's day after the service refused for a spent day: nothing left, whatever the count said. */
export function afterRefusal(limits: Lb04LimitsView | undefined): Lb04LimitsView | undefined {
  if (!limits) return limits
  return { ...limits, contracts: { limit: limits.contracts.limit, used: limits.contracts.limit, remaining: 0 } }
}
