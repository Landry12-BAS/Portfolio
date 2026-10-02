// What went wrong when a board called the site's API, in the few kinds a visitor can act on.
// The server answers every failure in the platform's one error shape and never repeats what the
// visitor sent, so its message is safe to show; this file reads that shape, adds the failures that
// have no answer (the network is down, the answer is not what the site expected) and names the
// kind, so a board shows the right state and the right words from its locale file.
import { platformErrorSchema } from '@lb/contracts'

/** The kinds of failure a board tells apart. */
export type ProblemKind
  = | 'unavailable' // this deployment has no back end, or the back end is down
    | 'verification' // the visitor must pass the Turnstile check first
    | 'cookie' // the check passed but the browser did not keep its result, so every call still asks for it
    | 'quota' // the day's limit is used up
    | 'rejected' // the back end refused what was sent: too long, empty, or not valid
    | 'notFound' // there is no such ticket, run or sample (or it has expired)
    | 'conflict' // the thing is no longer in a state that allows this
    | 'upstream' // the system behind the demo failed or answered nonsense
    | 'timeout' // the system took too long
    | 'network' // the browser could not reach the site
    | 'unknown'

/** A failed call to the API, with what the visitor may be told about it. */
export class ApiProblem extends Error {
  readonly status: number
  readonly code: string
  readonly kind: ProblemKind
  // When the daily limit starts again, if the answer said so (ISO 8601).
  readonly resetsAt: string | undefined

  /** Builds a problem from the status and the platform error's code and message. */
  constructor(status: number, code: string, message: string, resetsAt?: string) {
    super(message)
    this.name = 'ApiProblem'
    this.status = status
    this.code = code
    this.kind = kindOfStatus(status, code)
    this.resetsAt = resetsAt
  }
}

/** Picks the kind of failure from the status and code of an answer. Status 0 means no answer came. */
export function kindOfStatus(status: number, code: string): ProblemKind {
  if (status === 0) return 'network'
  if (code === 'cookie_not_kept') return 'cookie'
  if (code === 'verification_required' || code === 'verification_failed') return 'verification'
  if (status === 429) return 'quota'
  if (status === 503) return 'unavailable'
  if (status === 504) return 'timeout'
  if (status === 502) return 'upstream'
  if (status === 404) return 'notFound'
  if (status === 409) return 'conflict'
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'rejected'
  return 'unknown'
}

/** Builds the problem for a call that got no answer at all. */
export function networkProblem(): ApiProblem {
  return new ApiProblem(0, 'network', 'The site could not be reached.')
}

/** Builds the problem for an answer that is not the shape the board expected, whatever its status. */
export function badAnswerProblem(): ApiProblem {
  return new ApiProblem(502, 'bad_answer', 'The answer was not what the demo expected.')
}

/** Builds the problem for a deployment with no back end, so a board can show the same notice the server's own 503 gets. */
export function unavailableProblem(): ApiProblem {
  return new ApiProblem(503, 'unavailable', 'This part of the site is not available right now.')
}

/** Builds the problem for a visitor who did not pass the Turnstile check. */
export function verificationProblem(): ApiProblem {
  return new ApiProblem(403, 'verification_failed', 'The check could not tell that you are a person. Try again.')
}

/**
 * Builds the problem for a visitor whose check passed but whose next call still asked for it: the
 * result of the check lives in the site's one session cookie, so the browser is not keeping that cookie.
 */
export function cookieProblem(): ApiProblem {
  return new ApiProblem(403, 'cookie_not_kept', 'The browser did not keep the session cookie that holds the result of the check.')
}

/** Reads a failed answer's body as a platform error. A body of any other shape is just its status. */
export function problemFromAnswer(status: number, body: unknown): ApiProblem {
  const parsed = platformErrorSchema.safeParse(body)
  if (!parsed.success) return new ApiProblem(status, 'error', 'The request did not work.')
  const { code, message, resets_at: resetsAt } = parsed.data.error
  return new ApiProblem(status, code, message, resetsAt ?? undefined)
}

/** Tells whether a thrown value is an `ApiProblem`, so a handler can tell it from a bug. */
export function isApiProblem(value: unknown): value is ApiProblem {
  return value instanceof ApiProblem
}
