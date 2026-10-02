// Errors the Node systems answer on purpose, and the one body every error response uses.
//
// The platform's error shape is `{"error": {"code", "message"}}`, the same as the Django
// systems (services/django-systems/core/views.py). A code is stable, for callers to branch
// on; a message is a sentence for people. Neither ever repeats what a visitor sent.
import type { ErrorBody, WorkflowIssue } from '@lb/contracts'

/** What an error response may carry besides its code and message. */
export interface ErrorDetails {
  // For a malformed request: the fields at fault, by name.
  fields?: string
  // For a graph that failed validation: every problem found.
  problems?: WorkflowIssue[]
  // For a limit: how long until it frees up, in seconds, sent as Retry-After.
  retryAfterSeconds?: number
  // For a daily limit: when the day's allowance starts again, as an ISO 8601 time in UTC, sent as `resets_at`.
  resetsAt?: string
}

/**
 * An error the service answers on purpose, with its HTTP status and stable code. Route
 * handlers throw it; the app's error handler turns it into the response.
 */
export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly details: ErrorDetails

  constructor(status: number, code: string, message: string, details: ErrorDetails = {}) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/** Builds an error body in the platform's shape. */
export function errorBody(code: string, message: string, details: ErrorDetails = {}): ErrorBody {
  return {
    error: {
      code,
      message,
      ...(details.fields === undefined ? {} : { fields: details.fields }),
      ...(details.resetsAt === undefined ? {} : { resets_at: details.resetsAt }),
      ...(details.problems === undefined ? {} : { problems: details.problems }),
    },
  }
}

/**
 * Reduces an error to what may be logged: its type and code, and the top of its stack. The
 * message is left out on purpose: a JSON parser quotes the text it choked on, a database
 * driver can quote a value, and either could be a visitor's own words.
 */
export function describeError(error: unknown): { type: string, code?: string, frames?: string[] } {
  if (!(error instanceof Error)) return { type: typeof error }
  const code = (error as { code?: unknown }).code
  const frames = (error.stack ?? '').split('\n').filter(line => line.trimStart().startsWith('at ')).slice(0, 6).map(line => line.trim())
  return { type: error.name, ...(typeof code === 'string' ? { code } : {}), frames }
}
