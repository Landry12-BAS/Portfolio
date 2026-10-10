// Unit tests for which safety layer did what: read from the answer's own fields, a stopped query names
// its layer and the layers before it passed; a query that ran passed them all, and the row limit may
// have cut its result; a question with no query shows no layer a thing.
import { describe, expect, it } from 'vitest'

import { earlierAttempts, headline, layerVerdicts } from '~/boards/lb-05/verdict'
import type { LayerVerdict } from '~/boards/lb-05/verdict'

import { answered, declined, refused, stopped, unavailable } from '../support/lb05'

/** Lists the states of the six layers as `layer:state` pairs. */
function states(verdicts: readonly LayerVerdict[]): string[] {
  return verdicts.map(verdict => `${verdict.layer}:${verdict.state}`)
}

describe('the headline of a question\'s query', () => {
  it('says which layer and rule stopped it', () => {
    expect(headline(refused(stopped('DROP TABLE orders', 'parse', 'not_select')))).toEqual({ kind: 'stopped', layer: 'parse', rule: 'not_select' })
  })

  it('says a query ran when nothing stopped the last one', () => {
    expect(headline(answered())).toEqual({ kind: 'ran' })
  })

  it('says the row limit cut the result of a query that ran', () => {
    const answer = answered()
    if (answer.result) answer.result.truncated = true
    expect(headline(answer)).toEqual({ kind: 'cut' })
  })

  it('says there was no query when the model declined or the service was not available', () => {
    expect(headline(declined())).toEqual({ kind: 'none' })
    expect(headline(unavailable())).toEqual({ kind: 'none' })
  })

  it('judges by the last query: one that was stopped and then corrected ran', () => {
    const answer = answered()
    answer.attempts.unshift(stopped('SELECT email FROM customers', 'allowlist', 'unknown_column'))
    expect(headline(answer)).toEqual({ kind: 'ran' })
    expect(earlierAttempts(answer)).toHaveLength(1)
  })
})

describe('the six layers for a question', () => {
  it('lets the layers before the one that stopped the query pass, stops it there, and never reaches the rest', () => {
    const verdicts = layerVerdicts(refused(stopped('SELECT * FROM x', 'allowlist', 'unknown_table')))
    expect(states(verdicts)).toEqual(['parse:passed', 'allowlist:stopped', 'explain:not-reached', 'connection:not-reached', 'row_limit:not-reached', 'timeout:not-reached'])
    expect(verdicts[1]?.rule).toBe('unknown_table')
  })

  it('stops the plan check\'s query at the third layer', () => {
    const verdicts = layerVerdicts(refused(stopped('x', 'explain', 'cross_product')))
    expect(states(verdicts).slice(0, 3)).toEqual(['parse:passed', 'allowlist:passed', 'explain:stopped'])
  })

  it('passes every layer for a query that ran', () => {
    expect(states(layerVerdicts(answered())).every(state => state.endsWith(':passed'))).toBe(true)
  })

  it('shows the row limit cutting the result of a query that ran, and every other layer passing', () => {
    const answer = answered()
    if (answer.result) answer.result.truncated = true
    expect(states(layerVerdicts(answer))).toEqual(['parse:passed', 'allowlist:passed', 'explain:passed', 'connection:passed', 'row_limit:cut', 'timeout:passed'])
  })

  it('shows the row limit as cutting when the back end reports it as the layer of the last attempt', () => {
    const answer = answered()
    answer.attempts = [stopped('SELECT * FROM orders', 'row_limit', 'row_cap', 'Cut at 1,000 rows.')]
    expect(headline(answer)).toEqual({ kind: 'cut' })
  })

  it('reaches no layer when there was no query', () => {
    expect(states(layerVerdicts(declined())).every(state => state.endsWith(':not-reached'))).toBe(true)
  })
})
