// Tests of how the board reads a recorded exchange (app/boards/lb-06/exchange.ts), on the recordings
// the end-to-end tests replay: each answer is recognised by its request, checked with the schema the
// live call is checked with, and turned into a fact; an answer that fails, does not fit, or is for a
// route the board does not read is passed over, so a replay shows only what the board would have
// accepted.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordingSchema } from '@lb/contracts'
import type { Exchange, Recording } from '@lb/contracts'
import { describe, expect, it } from 'vitest'
import { factOf } from '~/boards/lb-06/exchange'

const FIXTURES = join(import.meta.dirname, '../../e2e/fixtures/recordings/lb-06')

/** Reads a committed recording. */
function recording(file: string): Recording {
  return recordingSchema.parse(JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')))
}

/** Makes an exchange for a request and an answer. */
function exchange(method: 'GET' | 'POST', path: string, status: number, body: Exchange['response']['body']): Exchange {
  return { request: { method, path }, response: { status, body } }
}

describe('the recordings of LB-06', () => {
  const files = readdirSync(FIXTURES).filter(name => name.endsWith('.json'))

  it('exist for the samples the end-to-end tests replay', () => {
    expect(files.sort()).toEqual(['bad-deploy.json', 'slow-payment.json'])
  })

  for (const file of files) {
    it(`${file}: every exchange is an answer the board accepts, in the order a visitor sees them`, () => {
      const facts = recording(file).exchanges.map(item => factOf(item))
      expect(facts.every(fact => fact !== undefined)).toBe(true)
      const kinds = facts.map(fact => fact?.kind)
      expect(kinds[0]).toBe('started')
      expect(kinds.at(-1)).toBe('postmortem')
      expect(kinds.filter(kind => kind === 'events').length).toBeGreaterThan(3)
      expect(kinds).toContain('view')
    })

    it(`${file}: its events follow one another with no number missing or repeated`, () => {
      const numbers = recording(file).exchanges.flatMap((item) => {
        const fact = factOf(item)
        return fact?.kind === 'events' ? fact.page.events.map(event => event.seq) : []
      })
      expect(numbers.length).toBeGreaterThan(40)
      expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => (numbers[0] ?? 0) + index))
    })
  }
})

describe('answers the board passes over', () => {
  const sample = recording('bad-deploy.json').exchanges

  it('ignores an answer that is not a success', () => {
    const [first] = sample
    expect(factOf({ ...first!, response: { status: 429, body: first!.response.body } })).toBeUndefined()
  })

  it('ignores an answer that does not fit its schema, and a body of the wrong kind for its route', () => {
    expect(factOf(exchange('POST', '/api/lb06/incidents', 201, { id: 'nope' }))).toBeUndefined()
    const view = sample[0]!.response.body
    expect(factOf(exchange('GET', '/api/lb06/incidents/abc/events', 200, view))).toBeUndefined()
  })

  it('ignores routes the board does not read', () => {
    expect(factOf(exchange('GET', '/api/lb06/limits', 200, {}))).toBeUndefined()
    expect(factOf(exchange('GET', '/api/lb05/incidents', 200, {}))).toBeUndefined()
    expect(factOf(exchange('POST', '/api/lb06/incidents/abc/proposals/p9/decision', 200, sample[0]!.response.body))).toBeUndefined()
  })

  it('reads a decision and an abort as the view they answer with', () => {
    const view = sample[0]!.response.body
    expect(factOf(exchange('POST', '/api/lb06/incidents/abc/proposals/p1/decision', 200, view))?.kind).toBe('view')
    expect(factOf(exchange('POST', '/api/lb06/incidents/abc/abort', 200, view))?.kind).toBe('view')
  })
})
