// The trace of a contract's review: the root span the review ends with, and the ID the step spans nest under.
//
// A review's trace is a tree. Every step of the pipeline is a span, written by the worker that ran it,
// and the review itself is the root, written once and last by the process that brought it to its end.
// The gateway calls a trace finished once it holds the root span, and the Scope stops reading then.
// The steps nest under the root by naming its ID before it exists: the ID is made from the contract's
// ID, which every process knows, so the two agree without a message between them.
//
// A trace is telemetry: it carries counts and labels, never anything a visitor wrote or the contract
// said, and a failure to write it never fails the job that was ending the review.
import { createRun, runScope, spanIdFrom } from '@lb/common'

import type { Lb04Deps } from './deps.ts'

/** The ID of a review's root span, made from the contract's ID so a step can name it as its parent before the root is written. */
export function rootSpanIdOf(contractId: string): string {
  return spanIdFrom(`lb-04:review:${contractId}`)
}

/** What a review's trace needs to know of its end: counts and labels, nothing a visitor wrote. */
export interface ReviewEnd {
  contractId: string
  // The visitor's hashed session key, which a run of the tracer needs (never the raw cookie).
  sessionKey: string
  origin: 'upload' | 'sample'
  // When the contract was made and when its review ended, in Unix milliseconds. The root spans the wait for a worker too.
  startMs: number
  endMs: number
  // `done`, or the failure code.
  outcome: string
  pages: number | null
  modelCalls: number
}

/**
 * Writes the root span of a review that has just ended, after the transaction that ended it has
 * committed. A failure to write it is logged and goes no further: the end of the review is already
 * in the database, and a trace is not worth failing the job over.
 */
export async function recordReviewEnd(deps: Lb04Deps, end: ReviewEnd): Promise<void> {
  try {
    await runScope(createRun({ system: 'lb-04', runId: end.contractId, session: end.sessionKey, dataClass: end.origin === 'sample' ? 'synthetic' : 'visitor' }), () => deps.tracer.record({
      name: 'contract review',
      kind: 'system.run',
      status: end.outcome === 'done' ? 'ok' : 'error',
      spanId: rootSpanIdOf(end.contractId),
      startMs: end.startMs,
      endMs: end.endMs,
      attrs: { outcome: end.outcome, origin: end.origin, pages: end.pages ?? 0, model_calls: end.modelCalls },
    }))
  }
  catch (error) {
    deps.log.warn({ err: error, contractId: end.contractId }, 'could not write the root span of a review')
  }
}
