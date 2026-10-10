// Which safety layer did what to a question's query, read from the back end's own answer fields
// (`attempts[].stopped_by` and `.rule`, `result.truncated`) and from nothing the board assumes. A
// query meets the six layers in order; the one that stops it is named in the answer, the layers before
// it let it through, and the layers after it were never reached. A query that ran passed them all,
// except that the row limit may have cut its result. A question the model declined never produced a
// query, so no layer saw anything, and the board says that and not "passed".
import { SQL_LAYERS } from '#shared/data/sql-safety'
import type { SqlLayer, SqlRule } from '#shared/data/sql-safety'

import type { Answer, Attempt } from './schemas'

/** What one layer did to the query: let it through, stopped it, cut its result, or never saw it. */
export type LayerState = 'passed' | 'stopped' | 'cut' | 'not-reached'

/** One layer and what it did to the last query of a question. */
export interface LayerVerdict {
  layer: SqlLayer
  state: LayerState
  // The rule that stopped the query, when this layer did.
  rule: SqlRule | undefined
}

/** How a question's query fared overall: it ran, it was cut to the row cap, a layer stopped it, or there was no query. */
export type Headline
  = | { kind: 'ran' }
    | { kind: 'cut' }
    | { kind: 'stopped', layer: SqlLayer, rule: SqlRule }
    | { kind: 'none' }

/** The last query a question tried, which is the one whose fate decided its outcome. */
export function lastAttempt(answer: Answer): Attempt | undefined {
  return answer.attempts.at(-1)
}

/** Tells whether the row limit cut the result of the query that ran. */
export function wasCutByRowLimit(answer: Answer): boolean {
  return answer.result?.truncated === true
}

/** Says how the last query fared. */
export function headline(answer: Answer): Headline {
  const last = lastAttempt(answer)
  if (last === undefined) return { kind: 'none' }
  if (last.stopped_by === null || last.rule === null) return wasCutByRowLimit(answer) ? { kind: 'cut' } : { kind: 'ran' }
  if (last.stopped_by === 'row_limit') return { kind: 'cut' }
  return { kind: 'stopped', layer: last.stopped_by, rule: last.rule }
}

/** Works out the state of each of the six layers for the last query of a question, in the order the query meets them. */
export function layerVerdicts(answer: Answer): LayerVerdict[] {
  const how = headline(answer)
  return SQL_LAYERS.map((layer, position): LayerVerdict => {
    if (how.kind === 'none') return { layer, state: 'not-reached', rule: undefined }
    if (how.kind === 'stopped') {
      const stoppedAt = SQL_LAYERS.indexOf(how.layer)
      if (position < stoppedAt) return { layer, state: 'passed', rule: undefined }
      return position === stoppedAt ? { layer, state: 'stopped', rule: how.rule } : { layer, state: 'not-reached', rule: undefined }
    }
    return { layer, state: layer === 'row_limit' && how.kind === 'cut' ? 'cut' : 'passed', rule: undefined }
  })
}

/** Lists the attempts before the last one: the queries a layer stopped that the model then corrected. */
export function earlierAttempts(answer: Answer): Attempt[] {
  return answer.attempts.slice(0, -1)
}
