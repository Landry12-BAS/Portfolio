// LB-05's operating limits as the board states them, and how long it waits for an answer. The limits
// are the datasheet's (shared/data/systems.ts) and the numbers the back end enforces in code
// (services/flask-systems/lb05/safety.py), which it also reports at GET /api/lb05/quota: the board
// starts from these and takes the back end's own as soon as it has them, so what it says is what is
// enforced. A test compares them with the datasheet, so they cannot drift apart unseen.
import type { Quota } from '~/board-kit/quota'

import type { Limits, QuotaAnswer } from './schemas'

/** The limits as the datasheet states them, used until the back end has reported its own. */
export const DEFAULT_LIMITS: Limits = {
  questions_per_day: 25,
  query_timeout_seconds: 5,
  row_cap: 1_000,
  max_model_calls_per_question: 5,
  question_deadline_seconds: 90,
}

/**
 * How long the board waits for a question's answer. The back end gives a question 90 seconds in all
 * and the site's server waits 95 for it (apps/web/server/lib/policy.ts), so this is a little more:
 * the board hears the site's own timeout first, and only gives up itself when the site went quiet.
 */
export const ASK_PATIENCE_MS = 100_000

/** The shortest and the longest question the back end takes (lb05/api.py: MIN_QUESTION_CHARS, lb05/prompts.py: MAX_QUESTION_CHARS). */
export const MIN_QUESTION_CHARS = 5
export const MAX_QUESTION_CHARS = 300

/** Tells whether a question is one the back end would take, so the board never sends one it would refuse. */
export function isAcceptableQuestion(question: string): boolean {
  const text = question.trim()
  return text.length >= MIN_QUESTION_CHARS && text.length <= MAX_QUESTION_CHARS
}

/** Turns the back end's account of the visitor's day into the allowance the kit's panel shows. */
export function quotaFrom(answer: QuotaAnswer): Quota {
  return { limit: answer.limits.questions_per_day, used: answer.used, remaining: answer.remaining, resetsAt: answer.resets_at }
}

/** Says how many whole seconds have passed since a moment, never less than nothing. */
export function secondsSince(startedAt: number, now: number): number {
  return Math.max(Math.floor((now - startedAt) / 1_000), 0)
}
