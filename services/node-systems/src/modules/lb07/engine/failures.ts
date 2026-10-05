// What a failure of a run means for the job: try again, or end the run as failed and say why.
//
// The agent's own endings (the wall clock, a refused plan) are final. A model that answered in no usable
// form twice is final too (`plan_invalid`), and a provider that failed, timed out or could not be reached is
// worth another try after a wait; a spent quota is not. A runner that is busy or could not be reached is
// worth another try (the next attempt starts the browser passes over from the plan), and so is a browser that
// crashed (the runner starts a fresh one); a runner that says the session expired is the wall clock. Messages
// never carry what a model or a page said.
import { gatewayErrorOf } from '@lb/common'
import type { GatewayCode } from '@lb/common'
import type { Lb07FailureCode } from '@lb/contracts'

import { ModelOutputInvalid } from '../agent/ask.ts'
import { RunEnded } from '../agent/machine.ts'
import { RunnerError } from '../runner/client.ts'

/** What to do about a failed attempt. */
export type Reaction
  = | { kind: 'retry', retryAfterSeconds: number | undefined }
    | { kind: 'fail', code: Lb07FailureCode }

/** Asks the queue for another attempt, after at least `retryAfterSeconds` when the gateway asked for a wait. */
export class RunRetry extends Error {
  readonly retryAfterSeconds: number | undefined

  constructor(retryAfterSeconds: number | undefined) {
    super('The run failed and will be tried again.')
    this.name = 'RunRetry'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

// The gateway's codes after which the model may be reachable again soon.
const WORTH_ANOTHER_TRY: ReadonlySet<GatewayCode | 'unreachable' | 'unknown'> = new Set(['upstream_failed', 'upstream_timeout', 'gateway_unavailable', 'internal_error', 'unreachable', 'unknown'])
// The codes that mean today's free quota or a provider's refusal: nothing is retried.
const UNAVAILABLE: ReadonlySet<GatewayCode | 'unreachable' | 'unknown'> = new Set(['quota_exceeded', 'budget_exhausted', 'upstream_rejected'])

/** Says what the failed attempt means: another try, the reason to fail the run, or undefined for an error that is nothing to do with the gateway, the runner or the model's answer. */
export function reactionTo(error: unknown): Reaction | undefined {
  if (error instanceof RunEnded) return { kind: 'fail', code: error.code }
  if (error instanceof ModelOutputInvalid) return { kind: 'fail', code: 'plan_invalid' }
  if (error instanceof RunnerError) {
    if (error.code === 'expired') return { kind: 'fail', code: 'run_timeout' }
    if (error.code === 'refused') return { kind: 'fail', code: 'internal' }
    return { kind: 'retry', retryAfterSeconds: error.code === 'exhausted' ? 5 : undefined }
  }
  const gateway = gatewayErrorOf(error)
  if (!gateway) return undefined
  if (WORTH_ANOTHER_TRY.has(gateway.code)) return { kind: 'retry', retryAfterSeconds: gateway.retryAfterSeconds }
  if (UNAVAILABLE.has(gateway.code)) return { kind: 'fail', code: 'planning_unavailable' }
  return { kind: 'fail', code: 'internal' }
}

/** The failures after which the visitor's place for the day is given back: the system's fault, not the run's. */
export const REFUNDED: ReadonlySet<Lb07FailureCode> = new Set(['planning_unavailable', 'runner_unavailable', 'plan_invalid', 'internal'])
