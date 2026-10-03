// Tests of the small, pure parts of LB-04's board: how a recorded answer becomes a fact the board applies
// (and which answers are passed over), which of the board's own notices a failure gets, how the board
// paces its polling and counts the visitor's day, and what the generated list of samples says against the
// files it comes from. Each is a function of its arguments, so none needs a page or a store.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { LB04_LIMITS } from '@lb/contracts'
import type { Exchange } from '@lb/contracts'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

import { LB04_SAMPLES } from '#shared/data/samples/lb04'

import { factOf } from '~/boards/lb-04/exchange'
import { afterRefusal, afterTaking, DEFAULT_LIMITS, FIRST_POLL_MS, pollDelay, POLL_MS, quotaFrom, QUICK_POLLS, SLOW_POLL_MS } from '~/boards/lb-04/limits'
import { ownNoticeOf } from '~/boards/lb-04/problems'
import { ApiProblem } from '~/board-kit/problem'

import { recordLb04Sample } from '../support/lb04-recording'

const ROOT = join(import.meta.dirname, '../../../..')

describe('a recorded answer', () => {
  it('becomes the fact the live answer would have been, for every route a review reads', async () => {
    const recording = await recordLb04Sample()
    const kinds = recording.exchanges.map(exchange => factOf(exchange)?.kind)

    expect(kinds[0]).toBe('started')
    expect(kinds.filter(kind => kind === 'view').length).toBeGreaterThanOrEqual(3)
    expect(kinds).toEqual(expect.arrayContaining(['pages', 'file', 'report', 'redline']))
    expect(kinds.every(kind => kind !== undefined)).toBe(true)
  })

  it('is passed over when it was not a success, or does not fit the schema the live call is checked with', async () => {
    const recording = await recordLb04Sample()
    const report = recording.exchanges.find(exchange => exchange.request.path.endsWith('/report')) as Exchange

    expect(factOf({ ...report, response: { status: 404, body: { error: { code: 'x', message: 'y' } } } })).toBeUndefined()
    expect(factOf({ ...report, response: { status: 200, body: { findings: 'not a list' } } })).toBeUndefined()
    expect(factOf({ request: { method: 'GET', path: '/api/lb04/limits' }, response: { status: 200, body: {} } })).toBeUndefined()
    expect(factOf({ request: { method: 'DELETE', path: '/api/lb04/contracts/abc12345' }, response: { status: 204 } })).toBeUndefined()
  })

  it('names the contract it is about, by the path it was asked at', async () => {
    const recording = await recordLb04Sample()
    const pages = recording.exchanges.find(exchange => exchange.request.path.endsWith('/pages')) as Exchange
    const fact = factOf(pages)

    expect(fact?.kind === 'pages' && fact.contractId).toMatch(/^[0-9a-f-]{36}$/)
    expect(fact?.kind === 'pages' && fact.pages).toHaveLength(11)
  })
})

describe('the board\'s own notices', () => {
  it('are chosen by the failure\'s code, never by its status alone', () => {
    const cases: [number, string, string | undefined][] = [
      [429, 'upload_limit', 'uploadLimit'],
      [429, 'redline_limit', 'redlineLimit'],
      [503, 'analysis_unavailable', 'model'],
      [503, 'queue_unavailable', 'queue'],
      [415, 'not_a_pdf', 'notPdf'],
      [413, 'file_too_large', 'tooLarge'],
      [404, 'contract_not_found', 'gone'],
      [429, 'daily_limit', undefined],
      [503, 'unavailable', undefined],
      [404, 'finding_not_found', undefined],
    ]
    for (const [status, code, notice] of cases) expect(ownNoticeOf(new ApiProblem(status, code, 'x')), `${status} ${code}`).toBe(notice)
  })
})

describe('the pace of a review\'s polling', () => {
  it('is quick for the first minute, slow after, and starts with a short wait', () => {
    expect(pollDelay(0)).toBe(FIRST_POLL_MS)
    expect(pollDelay(1)).toBe(POLL_MS)
    expect(pollDelay(QUICK_POLLS - 1)).toBe(POLL_MS)
    expect(pollDelay(QUICK_POLLS)).toBe(SLOW_POLL_MS)
    expect(FIRST_POLL_MS).toBeLessThan(POLL_MS)
  })

  it('states the limits the service enforces, from the contracts package', () => {
    expect(DEFAULT_LIMITS).toEqual({ contracts: 3, maxPages: 30, maxFileBytes: 2_097_152, keptMinutes: 60, redlines: 3 })
    expect(DEFAULT_LIMITS.contracts).toBe(LB04_LIMITS.contractsPerVisitorPerDay)
  })
})

describe('the visitor\'s day', () => {
  const day = { contracts: { limit: 3, used: 1, remaining: 2 }, maxPages: 30, maxFileBytes: 2_097_152, keptMinutes: 60, redlinesPerContract: 3, resetsAt: '2026-10-03T00:00:00.000Z' }

  it('becomes the counter the limits panel draws, with when it starts again', () => {
    expect(quotaFrom(day)).toEqual({ limit: 3, used: 1, remaining: 2, resetsAt: '2026-10-03T00:00:00.000Z' })
    expect(quotaFrom(undefined)).toBeUndefined()
  })

  it('counts one more used when a contract is taken, never past the limit', () => {
    expect(afterTaking(day)?.contracts).toEqual({ limit: 3, used: 2, remaining: 1 })
    expect(afterTaking(afterTaking(afterTaking(day)))?.contracts).toEqual({ limit: 3, used: 3, remaining: 0 })
    expect(afterTaking(undefined)).toBeUndefined()
  })

  it('has nothing left after the service refused for a spent day, whatever the count said', () => {
    expect(afterRefusal(day)?.contracts).toEqual({ limit: 3, used: 3, remaining: 0 })
    expect(afterRefusal(undefined)).toBeUndefined()
  })
})

describe('the generated samples', () => {
  it('are the six files of the sample list, with the pages that list gives and what the golden set expects of each', () => {
    const list = parse(readFileSync(join(ROOT, 'data/seed/lb04/samples.yaml'), 'utf8')) as { contracts: { id: string, title: string, pages: number }[] }
    const golden = parse(readFileSync(join(ROOT, 'evals/lb04/golden.yaml'), 'utf8')) as { cases: { contract: string, outcome: string, planted?: unknown[], absent?: unknown[], refusal?: string }[] }

    expect(LB04_SAMPLES.map(sample => sample.id)).toEqual(list.contracts.map(entry => entry.id).sort((a, b) => LB04_SAMPLES.findIndex(s => s.id === a) - LB04_SAMPLES.findIndex(s => s.id === b)))
    for (const sample of LB04_SAMPLES) {
      const entry = list.contracts.find(candidate => candidate.id === sample.id)
      const expected = golden.cases.find(candidate => candidate.contract === sample.id)
      expect(sample.pages, sample.id).toBe(entry?.pages)
      expect(sample.title, sample.id).toBe(entry?.title)
      expect(sample.outcome, sample.id).toBe(expected?.outcome)
      if (sample.outcome === 'report') expect([sample.planted, sample.absent], sample.id).toEqual([expected?.planted?.length, expected?.absent?.length])
      else expect(sample.refusal, sample.id).toBe(expected?.refusal)
    }
  })

  it('include the two files the system must refuse, one over the page limit and one with no text', () => {
    const refused = LB04_SAMPLES.filter(sample => sample.outcome === 'refused')

    expect(refused.map(sample => sample.refusal).sort()).toEqual(['no_text_layer', 'too_many_pages'])
    expect(LB04_SAMPLES.find(sample => sample.id === 'master-supply-31')?.pages).toBe(LB04_LIMITS.maxPages + 1)
  })
})
