// Tests of what LB-03's board accepts from the API: every state of every sample as the mock reads it
// (shaped as the real service's answers are), the answers a stranger's file must never be able to
// smuggle in, and the board's vocabulary (the states, the checks and the failure codes) against the
// service's own source, so a code the service adds without the board has words for it fails here.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Lb03Mock, readLb03Seed } from '@lb/api-clients/testing'
import { describe, expect, it } from 'vitest'

import { LB03_SAMPLES } from '#shared/data/samples/lb03'

import { REFUNDS_PER_DAY, SERVICE_FAILURES } from '~/boards/lb-03/failures'
import { CHECK_IDS, FAILURE_CODES, STATES, boxSchema, checkSchema, documentListSchema, documentSchema, fieldSchema, quotaSchema } from '~/boards/lb-03/schemas'

import { makeDocument } from '../support/lb03'

const NOW = Date.parse('2026-10-02T09:30:00.000Z')
const seed = readLb03Seed()

/** Reads a file of the service's source, from the repository. */
function service(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../services/flask-systems/lb03/${path}`, import.meta.url)), 'utf8')
}

/** Reads the members of a Python `StrEnum`: the names and the strings they stand for, in the order they are written. */
function members(source: string, className: string, endsAt: string): [string, string][] {
  const body = source.split(`class ${className}(StrEnum):`)[1]?.split(endsAt)[0] ?? ''
  return [...body.matchAll(/^\s+([A-Z_]+) = "([a-z_]+)"$/gm)].map(match => [match[1] ?? '', match[2] ?? ''])
}

describe('what the board accepts of a document', () => {
  it('takes every answer the mock gives for every sample, from the upload to the end of the reading', () => {
    for (const sample of LB03_SAMPLES) {
      const mock = new Lb03Mock(seed, () => NOW)
      const taken = mock.upload('schemas', { filename: sample.file, data: seed.file(`documents/${sample.file}`) })
      expect(taken.status).toBe(202)
      const states: string[] = [documentSchema.parse(taken.body).state]
      for (let reads = 0; reads < 12 && !['ready', 'failed'].includes(states.at(-1) ?? ''); reads += 1) {
        const answer = mock.get('schemas', (taken.body as { id: string }).id)
        states.push(documentSchema.parse(answer.body).state)
      }
      expect(states[0], sample.id).toBe('uploaded')
      expect(states.at(-1), sample.id).toBe(sample.outcome === 'held' ? 'failed' : 'ready')
    }
  })

  it('takes the list of documents and the day\'s quota as the mock gives them', () => {
    const mock = new Lb03Mock(seed, () => NOW)
    const sample = LB03_SAMPLES[0]
    mock.upload('lists', { filename: sample.file, data: seed.file(`documents/${sample.file}`) })
    const list = documentListSchema.parse(mock.list('lists').body)
    expect(list.documents).toHaveLength(1)
    const quota = quotaSchema.parse(mock.quota('lists').body)
    expect(quota.used).toBe(1)
    expect(quota.remaining).toBe(9)
    expect(quota.limits.max_pages).toBe(5)
  })

  it('keeps the lit fields of a ready document: boxes with four corners, a band and a number', () => {
    const document = makeDocument({ sample: 'clean-pdf' })
    const found = document.fields?.filter(field => field.box !== null) ?? []
    expect(found.length).toBeGreaterThan(10)
    for (const field of found) {
      expect(field.box?.quad).toHaveLength(8)
      expect(['high', 'medium', 'low']).toContain(field.box?.band)
    }
  })

  it('refuses what is not a field, a box or a check the service could have written', () => {
    const field = { path: 'total', kind: 'amount', value: '1.00', box: null, edited: false, checks: [] }
    expect(fieldSchema.safeParse(field).success).toBe(true)
    expect(fieldSchema.safeParse({ ...field, path: 'total; drop table' }).success).toBe(false)
    expect(fieldSchema.safeParse({ ...field, path: 'line_items.1234.total' }).success).toBe(false)
    expect(fieldSchema.safeParse({ ...field, kind: 'script' }).success).toBe(false)
    expect(fieldSchema.safeParse({ ...field, value: 'x'.repeat(201) }).success).toBe(false)
    expect(fieldSchema.safeParse({ ...field, checks: ['made_up'] }).success).toBe(false)

    const box = { page: 1, quad: [0, 0, 1, 0, 1, 1, 0, 1], confidence: 0.9, match: 1, band: 'high' }
    expect(boxSchema.safeParse(box).success).toBe(true)
    expect(boxSchema.safeParse({ ...box, quad: [0, 0, 1, 0, 1, 1, 0] }).success).toBe(false)
    expect(boxSchema.safeParse({ ...box, quad: [0, 0, 1, 0, 1, 1, 0, 99] }).success).toBe(false)
    expect(boxSchema.safeParse({ ...box, confidence: 1.5 }).success).toBe(false)
    expect(boxSchema.safeParse({ ...box, band: 'certain' }).success).toBe(false)
    expect(boxSchema.safeParse({ ...box, page: 6 }).success).toBe(false)

    const check = { id: 'total_reconciles', status: 'failed', severity: 'error', message: 'x', fields: ['total'], expected: '1.00', actual: '2.00' }
    expect(checkSchema.safeParse(check).success).toBe(true)
    expect(checkSchema.safeParse({ ...check, id: 'trust_me' }).success).toBe(false)
    expect(checkSchema.safeParse({ ...check, status: 'maybe' }).success).toBe(false)
  })

  it('refuses a document in a state the board has no words for, with a run name that is not one, or with too much in it', () => {
    const document = makeDocument({ sample: 'planted-total' })
    expect(documentSchema.safeParse(document).success).toBe(true)
    expect(documentSchema.safeParse({ ...document, state: 'thinking' }).success).toBe(false)
    expect(documentSchema.safeParse({ ...document, run_id: 'not a run id' }).success).toBe(false)
    expect(documentSchema.safeParse({ ...document, id: '../../etc/passwd' }).success).toBe(false)
    expect(documentSchema.safeParse({ ...document, pages: 99 }).success).toBe(false)
    const crowd = Array.from({ length: 301 }, () => document.fields?.[0])
    expect(documentSchema.safeParse({ ...document, fields: crowd }).success).toBe(false)
    const facts = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`fact${index}`, 1]))
    expect(documentSchema.safeParse({ ...document, steps: [{ name: 'ocr', status: 'ok', ms: 1, detail: facts }] }).success).toBe(false)
  })
})

describe('the board\'s vocabulary against the service\'s', () => {
  it('has a word for every failure code the service can write, and no other', () => {
    const codes = members(service('states.py'), 'FailureCode', 'SERVICE_FAILURES').map(([, value]) => value)
    expect([...FAILURE_CODES].sort()).toEqual([...codes].sort())
  })

  it('knows every state a document can be in, in the order of its pipeline', () => {
    const states = members(service('states.py'), 'DocumentState', 'FINAL_STATES').map(([, value]) => value)
    expect([...STATES]).toEqual(states)
  })

  it('lists the eleven checks in the order the service runs them', () => {
    const ids = members(service('checks.py'), 'CheckId', 'class Severity').map(([, value]) => value)
    expect([...CHECK_IDS]).toEqual(ids)
  })

  it('says a failure is the service\'s own exactly when the service gives the document back', () => {
    const source = service('states.py')
    const names = new Map(members(source, 'FailureCode', 'SERVICE_FAILURES'))
    const block = source.split('SERVICE_FAILURES = frozenset(')[1]?.split(')\n')[0] ?? ''
    const given = [...block.matchAll(/FailureCode\.([A-Z_]+)/g)].map(match => names.get(match[1] ?? '') ?? '')
    expect([...SERVICE_FAILURES].sort()).toEqual(given.sort())
  })

  it('says as many refunds a day as the service gives', () => {
    expect(REFUNDS_PER_DAY).toBe(Number(/MAX_REFUNDS_PER_DAY = (\d+)/.exec(service('limits.py'))?.[1]))
  })
})
