// What the end of a meeting means for the visitor, worked out from what the service says: whether a failed
// meeting gave its place for the day back, and the stage it failed in. The service decides the first
// (services/django-systems/lb09/meetings.py, GIVEN_BACK) and the board only words it, so the two lists must
// agree; a test holds them together. The second matters when the board did not see every stage go by (it
// read the meeting every second or two, or opened it again after a reload): the failure's code says where
// the meeting must at least have got to, so no stage it passed is left marked as not yet reached.
import { LB09_SAMPLES } from '#shared/data/samples/lb09'
import type { Lb09SampleId } from '#shared/data/samples/lb09'

import { WORK_STAGES } from './schemas.ts'
import type { Failure, Stage } from './schemas.ts'

/** The failures that are the service's, not the visitor's: a meeting that ends with one of them does not count against the day. */
export const GIVEN_BACK_FAILURES: readonly Failure[] = ['transcriber', 'model', 'stale', 'pipeline_error', 'audio_gone']

/** One of the stages a meeting works through. */
export type WorkStage = (typeof WORK_STAGES)[number]

/**
 * The stage each failure happens in, at the earliest: the decoder refuses in decoding, the transcriber fails in
 * transcribing, a model in labelling or later. A meeting the worker lost or gave up on (`stale`), or a crash, can end at
 * any stage, before any work too, so they say nothing here.
 */
const EARLIEST_STAGE: Readonly<Partial<Record<Failure, WorkStage>>> = {
  undecodable: 'decoding',
  too_long: 'decoding',
  too_short: 'decoding',
  decode_limit: 'decoding',
  audio_gone: 'decoding',
  no_speech: 'transcribing',
  transcriber: 'transcribing',
  model: 'labelling',
}

/** Tells whether a failed meeting gave its place for the day back. */
export function givesPlaceBack(failure: Failure | null): boolean {
  return failure !== null && GIVEN_BACK_FAILURES.includes(failure)
}

/** Tells whether a meeting's sample key is one of the curated samples the board knows. */
export function isLb09SampleId(key: string): key is Lb09SampleId {
  return LB09_SAMPLES.some(sample => sample.id === key)
}

/**
 * The work stage a meeting failed in: the furthest of the stages the board saw it reach and the earliest stage its
 * failure can happen in. `undefined` when neither says: it failed before any work the board saw, for a reason that
 * names no stage.
 */
export function failedStage(seen: readonly Stage[], failure: Failure | null): WorkStage | undefined {
  let furthest = -1
  for (const stage of seen) furthest = Math.max(furthest, WORK_STAGES.indexOf(stage as WorkStage))
  const earliest = failure === null ? undefined : EARLIEST_STAGE[failure]
  if (earliest !== undefined) furthest = Math.max(furthest, WORK_STAGES.indexOf(earliest))
  return furthest >= 0 ? WORK_STAGES[furthest] : undefined
}
