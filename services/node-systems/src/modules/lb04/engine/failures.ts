// What a failure of a review means for the job: try again, or end the contract as failed and say why.
//
// The gateway's error codes decide it. A provider that failed, timed out or can't be reached is worth
// another try after a wait (the gateway's own Retry-After, when it gave one); a spent quota or an
// exhausted daily budget won't be better in a minute; and a code that says the request itself is wrong
// (a refused token, an alias this system may not use, a prompt over the alias's limit) is a fault of
// this deploy, never the visitor's, and is not worth trying again. Messages never carry what a model said.
import { gatewayErrorOf } from '@lb/common'
import type { GatewayCode } from '@lb/common'
import type { Lb04FailureCode } from '@lb/contracts'

import { ModelOutputInvalid } from '../analysis/pipeline.ts'

/** What to do about a failed attempt. */
export type Reaction
  = | { kind: 'retry', retryAfterSeconds: number | undefined }
    | { kind: 'fail', code: Lb04FailureCode }

/** Asks the queue for another attempt, after at least `retryAfterSeconds` when the gateway asked for a wait. */
export class ReviewRetry extends Error {
  readonly retryAfterSeconds: number | undefined

  constructor(retryAfterSeconds: number | undefined) {
    super('The review failed and will be tried again.')
    this.name = 'ReviewRetry'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

// The gateway's codes after which the model may be reachable again soon.
const WORTH_ANOTHER_TRY: ReadonlySet<GatewayCode | 'unreachable' | 'unknown'> = new Set(['upstream_failed', 'upstream_timeout', 'gateway_unavailable', 'internal_error', 'unreachable', 'unknown'])
// The codes that mean today's free quota or a provider's refusal: the visitor is told the model is unavailable, and nothing is retried.
const UNAVAILABLE: ReadonlySet<GatewayCode | 'unreachable' | 'unknown'> = new Set(['quota_exceeded', 'budget_exhausted', 'upstream_rejected'])

/** Says what the failed attempt means: another try, the reason to fail the contract, or undefined for an error that is nothing to do with the gateway or the model's answer. */
export function reactionTo(error: unknown): Reaction | undefined {
  if (error instanceof ModelOutputInvalid) return { kind: 'fail', code: 'analysis_invalid' }
  const gateway = gatewayErrorOf(error)
  if (!gateway) return undefined
  if (WORTH_ANOTHER_TRY.has(gateway.code)) return { kind: 'retry', retryAfterSeconds: gateway.retryAfterSeconds }
  if (UNAVAILABLE.has(gateway.code)) return { kind: 'fail', code: 'analysis_unavailable' }
  return { kind: 'fail', code: 'internal' }
}
