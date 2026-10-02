// Tests of reading a recorded answer the way the board reads the API's own: each exchange of a
// recording is recognised by its request, checked by the schema the live call is checked with, and
// turned into the same kind of fact. An answer that is not a success, or does not fit, is passed
// over, so a recording that has been tampered with shows less and never something the board would
// have refused. The recordings are the committed fixtures, made by the recorder on the mock.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { recordingSchema } from '@lb/contracts'
import type { Exchange, Recording } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { factOf } from '~/boards/lb-08/exchange'

const FIXTURES = join(import.meta.dirname, '../../e2e/fixtures/recordings/lb-08')

/** Reads one of the committed recordings, checked as the site checks it. */
function recording(sample: string): Recording {
  return recordingSchema.parse(JSON.parse(readFileSync(join(FIXTURES, `${sample}.json`), 'utf8')))
}

/** The kinds of fact a recording's exchanges come to, in order. */
function kinds(sample: string): (string | undefined)[] {
  return recording(sample).exchanges.map(exchange => factOf(exchange)?.kind)
}

describe('reading a recording\'s exchanges', () => {
  it('turns every exchange of a recorded run into a fact the board can apply, in the order the board made them', () => {
    expect(kinds('wholesale-order')).toEqual(['workflow', 'run-started', 'events', 'events', 'run-view', 'sent', 'dead-letters'])
    expect(kinds('low-stock-reorder')).toEqual(['workflow', 'run-started', 'events', 'events', 'events', 'run-view', 'sent', 'dead-letters', 'run-started', 'events', 'run-view', 'sent', 'dead-letters'])
  })

  it('reads a decision as the run it answers with, and a replay of a dead letter as a run that joins the chain', () => {
    const answer = kinds('refund-approval')
    expect(answer).toContain('run-view')
    const replayed = recording('low-stock-reorder').exchanges.map(exchange => factOf(exchange)).filter(fact => fact?.kind === 'run-started')
    expect(replayed.map(fact => fact?.kind === 'run-started' && fact.replay)).toEqual([false, true])
  })

  it('names the run an events page belongs to by the path alone, since a recorded path has no query', () => {
    const exchange = recording('wholesale-order').exchanges.find(candidate => candidate.request.path.endsWith('/events'))!
    const fact = factOf(exchange)

    expect(fact?.kind).toBe('events')
    expect(fact?.kind === 'events' && exchange.request.path).toContain(fact.runId)
  })

  it('passes over an answer that is not a success, since the board would not have accepted it either', () => {
    const [opened] = recording('wholesale-order').exchanges as [Exchange]

    expect(factOf({ ...opened, response: { ...opened.response, status: 429 } })).toBeUndefined()
    expect(factOf({ ...opened, response: { ...opened.response, status: 302 } })).toBeUndefined()
    expect(factOf({ ...opened, response: { ...opened.response, status: 200 } })?.kind).toBe('workflow')
  })

  it('passes over an answer that does not fit its schema, and a request it does not know', () => {
    const [opened, started] = recording('wholesale-order').exchanges as [Exchange, Exchange]

    expect(factOf({ ...opened, response: { status: 201, body: { id: 'not a uuid' } } })).toBeUndefined()
    expect(factOf({ ...started, response: { status: 202, body: { status: 'running' } } })).toBeUndefined()
    expect(factOf({ request: { method: 'GET', path: '/api/lb08/something-else' }, response: { status: 200, body: {} } })).toBeUndefined()
    expect(factOf({ request: { method: 'POST', path: '/api/lb08/workflows/x/delete' }, response: { status: 200, body: {} } })).toBeUndefined()
  })

  it('reads the sandbox\'s deliveries and the dead letters as lists', () => {
    const exchanges = recording('low-stock-reorder').exchanges
    const sent = exchanges.map(exchange => factOf(exchange)).filter(fact => fact?.kind === 'sent')
    const letters = exchanges.map(exchange => factOf(exchange)).filter(fact => fact?.kind === 'dead-letters')

    expect(sent.map(fact => fact?.kind === 'sent' && fact.rows.length)).toEqual([1, 2])
    expect(letters.map(fact => fact?.kind === 'dead-letters' && fact.rows.length)).toEqual([1, 1])
  })
})

describe('the committed recordings', () => {
  it('are the mock\'s and say so, which is why only the test build shows them', () => {
    for (const sample of ['wholesale-order', 'low-stock-reorder', 'refund-approval']) {
      expect(recording(sample)).toMatchObject({ system: 'lb-08', sample, origin: 'mock' })
    }
  })

  it('leave the Czech sample without one, so a sample with no recording can be seen', () => {
    expect(() => readFileSync(join(FIXTURES, 'wholesale-order-cs.json'), 'utf8')).toThrow()
  })
})
