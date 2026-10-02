// What the board knows about the ways a document can end with no result. The service names each one with
// a code (services/flask-systems/lb03/states.py); the board has words for every code in the locale files.
// The codes split in two: a file that cannot be read (the visitor's to change) and a failure that is the
// service's own (the models are busy, the reader stopped, the time ran out). The service gives the second
// kind back to the visitor's day, a few a day, because trying again later may work; the board says so.
import type { FailureCode } from './schemas'

/** The failures that are the service's, not the file's: the document is given back to the day's count, up to three a day. */
export const SERVICE_FAILURES: ReadonlySet<FailureCode> = new Set<FailureCode>([
  'ocr_failed',
  'unchecked',
  'model_failed',
  'model_budget',
  'model_output',
  'time_limit',
  'call_limit',
  'interrupted',
])

/** How many such documents the service gives back in a day (services/flask-systems/lb03/limits.py: MAX_REFUNDS_PER_DAY). */
export const REFUNDS_PER_DAY = 3

/** Tells whether a failure is the service's own and so is given back to the visitor's day. */
export function isServiceFailure(code: FailureCode): boolean {
  return SERVICE_FAILURES.has(code)
}
