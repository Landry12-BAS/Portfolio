// Unit tests for the vocabulary LB-05's board shares with its back end, and for the samples generated
// from the evals: the layers, rules and outcomes are the OpenAPI document's, every attack names a layer
// and rule the vocabulary has, and the limits the board starts from are the datasheet's.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { LB05_ATTACKS, LB05_SAMPLES } from '#shared/data/samples/lb05'
import { findSystemIn } from '#shared/data/datasheets'
import { COLUMN_KINDS, QUESTION_OUTCOMES, SQL_LAYERS, SQL_RULES } from '#shared/data/sql-safety'

import { DEFAULT_LIMITS } from '~/boards/lb-05/limits'

/** The enum a schema of the back end's OpenAPI document lists. */
function documentedEnum(name: string): string[] {
  const path = fileURLToPath(new URL('../../../../services/flask-systems/openapi.json', import.meta.url))
  const document = JSON.parse(readFileSync(path, 'utf8')) as { components: { schemas: Record<string, { enum: string[] }> } }
  return document.components.schemas[name]?.enum ?? []
}

describe('the safety vocabulary', () => {
  it('lists the layers, rules, outcomes and column kinds the back end\'s OpenAPI document does, in its order', () => {
    expect([...SQL_LAYERS]).toEqual(documentedEnum('Layer'))
    expect([...SQL_RULES]).toEqual(documentedEnum('Rule'))
    expect([...QUESTION_OUTCOMES]).toEqual(documentedEnum('Outcome'))
    expect([...COLUMN_KINDS]).toEqual(documentedEnum('ColumnKind'))
  })
})

describe('LB-05\'s generated samples', () => {
  it('open on the seven questions the golden set marks as samples', () => {
    expect(LB05_SAMPLES.map(sample => sample.id)).toEqual([
      'revenue-last-quarter',
      'revenue-by-product-last-quarter',
      'active-subscriptions-by-frequency',
      'monthly-revenue-last-year',
      'top-5-products-last-year',
      'cancellation-rate-last-quarter',
      'lost-repeat-buyers-last-quarter',
    ])
  })

  it('include the question the datasheet suggests asking first', () => {
    const datasheet = findSystemIn('lb-05', 'en')?.tryIt ?? ''
    expect(datasheet).toContain('which coffees lost the most repeat buyers last quarter')
    expect(LB05_SAMPLES.map(sample => sample.question.toLowerCase())).toContain('which coffees lost the most repeat buyers last quarter?')
  })

  it('give every question and attack its own ID, because a recording is named by it', () => {
    const ids = [...LB05_SAMPLES.map(sample => sample.id), ...LB05_ATTACKS.map(attack => attack.id)]
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every(id => /^[a-z0-9-]{1,60}$/.test(id))).toBe(true)
  })

  it('send questions the back end accepts: five to 300 characters', () => {
    for (const { question } of [...LB05_SAMPLES, ...LB05_ATTACKS]) {
      expect(question.length).toBeGreaterThanOrEqual(5)
      expect(question.length).toBeLessThanOrEqual(300)
    }
  })

  it('name for every attack a layer and rule of the vocabulary, and show the ways of being stopped a visitor can see', () => {
    for (const attack of LB05_ATTACKS) {
      expect(SQL_LAYERS).toContain(attack.stoppedBy)
      expect(SQL_RULES).toContain(attack.rule)
    }
    const layers = new Set(LB05_ATTACKS.map(attack => attack.stoppedBy))
    expect([...layers].toSorted()).toEqual(['allowlist', 'explain', 'parse', 'row_limit'])
  })

  it('mark the one attack that is held by being answered and cut, not refused', () => {
    expect(LB05_ATTACKS.filter(attack => !attack.mustRefuse).map(attack => attack.id)).toEqual(['dump-all-orders'])
  })
})

describe('the limits the board starts from', () => {
  it('are the datasheet\'s', () => {
    const limits = findSystemIn('lb-05', 'en')?.limits ?? []
    const value = (label: string) => limits.find(limit => limit.label.startsWith(label))?.value
    expect(value('Questions per visitor per day')).toBe(String(DEFAULT_LIMITS.questions_per_day))
    expect(value('Query timeout')).toBe(`${DEFAULT_LIMITS.query_timeout_seconds} s`)
    expect(value('Row cap')).toBe(DEFAULT_LIMITS.row_cap.toLocaleString('en'))
  })
})
