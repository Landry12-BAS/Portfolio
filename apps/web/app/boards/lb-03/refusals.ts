// What a refusal of LB-03's API means for a visitor, where the platform's few kinds of failure are too
// few to say it. The kit's notice reads "429" as "today's allowance is used up", which is right for the
// day's ten documents and wrong for "two of your documents are still being read"; it reads "503" as "this
// demo is not connected", which is wrong for "every reader is busy right now". The refusals the board
// can say more about are named here, by the status and the code the service answers with; the words are
// in the locale file and never the service's.
import type { ApiProblem } from '~/board-kit/problem'

/** The refusals of an upload that have words of their own. */
export type UploadRefusal = 'too_large' | 'unsupported' | 'running' | 'busy'

/** The refusals of a correction that have words of their own. */
export type CorrectionRefusal = 'invalid' | 'too_many' | 'conflict' | 'gone' | 'not_ready'

/** Names the refusal of an upload when the board has words for it, or undefined for any other failure (the kit's notices say those). */
export function uploadRefusal(problem: ApiProblem): UploadRefusal | undefined {
  if (problem.status === 413) return 'too_large'
  if (problem.status === 415) return 'unsupported'
  if (problem.status === 429 && problem.code === 'document_running') return 'running'
  if (problem.status === 503 && problem.code === 'readers_busy') return 'busy'
  return undefined
}

/** Names the refusal of a correction. Every failure of one has words: the visitor is in the middle of editing a field. */
export function correctionRefusal(problem: ApiProblem): CorrectionRefusal | undefined {
  if (problem.status === 422) return 'invalid'
  if (problem.status === 404) return 'gone'
  if (problem.status === 409 && problem.code === 'too_many_corrections') return 'too_many'
  if (problem.status === 409 && problem.code === 'edit_conflict') return 'conflict'
  if (problem.status === 409) return 'not_ready'
  return undefined
}
