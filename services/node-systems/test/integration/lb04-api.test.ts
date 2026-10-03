// Tests for LB-04's HTTP API, end to end through the real app: visitor tokens, request checking, every
// route's answers and errors, the visitor's limits, redlines and what another visitor can and can't
// see. The database is real, the queue is driven by hand, and the models are scripts.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { GatewayCallError } from '@lb/common'
import { foldQuote, LB04_LIMITS, lb04ContractViewSchema, lb04FileViewSchema, lb04LimitsViewSchema, lb04PagesViewSchema, lb04PlaybookViewSchema, lb04RedlineSchema, lb04ReportSchema, lb04SampleViewSchema } from '@lb/contracts'
import type { Lb04ContractView, Lb04Report } from '@lb/contracts'
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'

import { seedDirectory } from '../../src/core/data-files.ts'
import { wordsOf } from '../../src/modules/lb04/analysis/redline.ts'
import { SECURITY_HEADERS } from '../../src/core/security-headers.ts'
import { ScriptedModel } from '../support/fake-model.ts'
import { createLb04ApiHarness } from '../support/lb04-api.ts'
import type { Lb04ApiHarness } from '../support/lb04-api.ts'
import { drive, referenceReview } from '../support/lb04-engine.ts'
import { makePdf } from '../support/lb04-pdfs.ts'
import { extractedPages, seedBytes } from '../support/lb04.ts'

let api: Lb04ApiHarness

// What the redline model says next: the test sets it, and the model hands each reply out once. Without a script it answers as the reference model would.
const referenceFast = referenceReview('wholesale-supply').scripts.fast
let fastScript: (ScriptedModel | undefined) = undefined

beforeAll(async () => {
  const { scripts } = referenceReview('wholesale-supply')
  const fast = { ask: async (messages: Parameters<ScriptedModel['ask']>[0]) => (fastScript ?? referenceFast).ask(messages) }
  api = await createLb04ApiHarness(inject('databaseUrl'), { review: { models: { ...scripts.models, fast }, guard: { check: async () => ({ flagged: false, score: 0.01 }) } } })
})

afterAll(async () => {
  await api.close()
})

beforeEach(() => {
  api.engine.clock.set('2026-10-02T09:00:00.000Z')
})

/** Makes a visitor session of its own. */
function newSession(): string {
  return `session-${randomBytes(8).toString('hex')}`
}

/** Starts a review of the wholesale sample through the API, and returns the contract. */
async function startSample(session: string, sampleId = 'wholesale-supply'): Promise<Lb04ContractView> {
  const response = await api.call('POST', '/contracts', session, { from: 'sample', sampleId })
  expect(response.statusCode, response.body).toBe(201)
  return lb04ContractViewSchema.parse(response.json())
}

/** Runs the queued reviews and reads the finished report. */
async function reviewed(session: string): Promise<{ contract: Lb04ContractView, report: Lb04Report }> {
  const contract = await startSample(session)
  await drive(api.engine)
  const report = await api.call('GET', `/contracts/${contract.id}/report`, session)
  expect(report.statusCode, report.body).toBe(200)
  return { contract, report: lb04ReportSchema.parse(report.json()) }
}

describe('who may call', () => {
  const contractId = '11111111-1111-4111-8111-111111111111'
  const routes: [method: 'GET' | 'POST' | 'DELETE', url: string][] = [
    ['GET', '/limits'],
    ['GET', '/samples'],
    ['GET', '/playbook'],
    ['POST', '/contracts'],
    ['GET', '/contracts'],
    ['GET', `/contracts/${contractId}`],
    ['GET', `/contracts/${contractId}/pages`],
    ['GET', `/contracts/${contractId}/file`],
    ['GET', `/contracts/${contractId}/report`],
    ['POST', `/contracts/${contractId}/findings/f1/redline`],
    ['DELETE', `/contracts/${contractId}`],
  ]

  it.each(routes)('answers %s %s with 401 and no token', async (method, url) => {
    const response = await api.call(method, url, undefined, method === 'POST' ? {} : undefined)

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: { code: 'unauthorized', message: 'This route needs a valid visitor token for its system.' } })
  })

  it('answers 401 for a token minted for another system, an expired one, one that is not a token and one with the wrong scheme', async () => {
    const send = (authorization: string): Promise<LightMyRequestResponse> => api.app.inject({ url: '/api/lb04/limits', headers: { authorization } })

    expect((await send(`Bearer ${api.tokenFor(newSession(), 'lb-08')}`)).statusCode).toBe(401)
    expect((await send(`Bearer ${api.tokenFor(newSession(), 'lb-04', -3_600)}`)).statusCode).toBe(401)
    expect((await send('Bearer not.a.token')).statusCode).toBe(401)
    expect((await send(`Basic ${api.tokenFor(newSession())}`)).statusCode).toBe(401)
  })

  it('answers every route with the security headers, the errors included', async () => {
    const answered = await api.call('GET', '/limits', newSession())
    const refused = await api.call('GET', '/limits', undefined)

    for (const response of [answered, refused]) {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers[name.toLowerCase()], name).toBe(value)
    }
  })
})

describe('what the system says about itself', () => {
  it('says what is left of the visitor\'s day, with the limits and when the day ends', async () => {
    const response = await api.call('GET', '/limits', newSession())

    expect(response.statusCode).toBe(200)
    const limits = lb04LimitsViewSchema.parse(response.json())
    expect(limits).toMatchObject({ contracts: { limit: LB04_LIMITS.contractsPerVisitorPerDay, used: 0, remaining: LB04_LIMITS.contractsPerVisitorPerDay }, maxPages: LB04_LIMITS.maxPages, maxFileBytes: LB04_LIMITS.maxFileBytes, keptMinutes: 60 })
    expect(limits.resetsAt).toMatch(/T00:00:00\.000Z$/)
  })

  it('lists the six curated samples, with the length of each, the two that will be refused included', async () => {
    const response = await api.call('GET', '/samples', newSession())

    expect(response.statusCode).toBe(200)
    const samples = lb04SampleViewSchema.array().parse(response.json())
    expect(samples.map(sample => [sample.id, sample.pages])).toEqual([
      ['wholesale-supply', 11],
      ['clean-supply', 11],
      ['master-supply-30', 30],
      ['master-supply-31', 31],
      ['scanned-supply', 5],
      ['hostile-supply', 6],
    ])
  })

  it('serves the playbook as data: its rules by topic, with what each accepts and what it flags', async () => {
    const response = await api.call('GET', '/playbook', newSession())

    expect(response.statusCode).toBe(200)
    const playbook = lb04PlaybookViewSchema.parse(response.json())
    expect(playbook.topics.length).toBe(9)
    expect(playbook.topics.flatMap(topic => topic.rules).length).toBe(21)
  })
})

describe('starting a review', () => {
  it('queues a sample and answers 201 with the contract, which belongs to the visitor and says when it will be deleted', async () => {
    const session = newSession()

    const contract = await startSample(session)

    expect(contract).toMatchObject({ state: 'queued', origin: 'sample', sampleId: 'wholesale-supply', pages: null, failure: null, redlinesLeft: 3, notLegalAdvice: 'Not legal advice' })
    expect(contract.runId).toBe(contract.id)
    expect(Date.parse(contract.expiresAt) - Date.parse(contract.createdAt)).toBe(60 * 60_000)
    const listed = await api.call('GET', '/contracts', session)
    expect(lb04ContractViewSchema.array().parse(listed.json()).map(entry => entry.id)).toEqual([contract.id])
  })

  it('queues an upload, labelled with the cleaned file name and never with a path', async () => {
    const bytes = await makePdf(1)

    const response = await api.call('POST', '/contracts', newSession(), { from: 'upload', filename: String.raw`C:\Users\someone\..\..\etc\Supply terms.pdf`, contentBase64: Buffer.from(bytes).toString('base64') })

    expect(response.statusCode, response.body).toBe(201)
    expect(response.json()).toMatchObject({ origin: 'upload', sampleId: null, title: 'Supply terms.pdf' })
  })

  it('answers 404 for a sample that does not exist, and 422 for a body that has other fields, or none of its own', async () => {
    const session = newSession()

    expect((await api.call('POST', '/contracts', session, { from: 'sample', sampleId: 'no-such-sample' })).json().error.code).toBe('unknown_sample')
    for (const body of [{}, { from: 'sample' }, { from: 'sample', sampleId: 'wholesale-supply', extra: 1 }, { from: 'sample', sampleId: '../../etc/passwd' }, { from: 'upload', filename: 'a.pdf' }, { from: 'url', url: 'http://example.com/a.pdf' }]) {
      const response = await api.call('POST', '/contracts', session, body)
      expect(response.statusCode, JSON.stringify(body)).toBe(422)
      expect(response.json().error.code).toBe('invalid_request')
    }
  })

  it('answers 415 for a file that is not a PDF, however it is dressed, and 413 for one over the size limit', async () => {
    const session = newSession()
    const send = (bytes: Buffer): Promise<LightMyRequestResponse> => api.call('POST', '/contracts', session, { from: 'upload', filename: 'a.pdf', contentBase64: bytes.toString('base64') })

    for (const content of [Buffer.from('<html><script>alert(1)</script></html>'), Buffer.from('PK\u0003\u0004 not a pdf, a zip'), Buffer.from('%PDF'), Buffer.from('MZ\u0090\u0000 an executable'), Buffer.from('plain text that mentions %PDF- later')]) {
      const response = await send(content)
      expect(response.statusCode, content.toString('latin1')).toBe(415)
      expect(response.json().error.code).toBe('not_a_pdf')
    }
    const notBase64 = await api.call('POST', '/contracts', session, { from: 'upload', filename: 'a.pdf', contentBase64: '%PDF-1.7 this is not base64!!' })
    expect(notBase64.statusCode).toBe(415)
    const header = Buffer.from('%PDF-1.7\n')
    const tooLarge = await send(Buffer.concat([header, Buffer.alloc(LB04_LIMITS.maxFileBytes - header.length + 1)]))
    expect(tooLarge.statusCode).toBe(413)
    expect(tooLarge.json().error.code).toBe('file_too_large')
    // Exactly at the limit is let in (it is the extraction that finds out it is not a real document), and the queue is not left holding it.
    const atTheLimit = await send(Buffer.concat([header, Buffer.alloc(LB04_LIMITS.maxFileBytes - header.length)]))
    expect(atTheLimit.statusCode, atTheLimit.body).toBe(201)
    api.engine.scheduler.jobs.length = 0
  })

  it('answers 413 for a request body larger than any file could make, before reading it, and 415 for one that is not JSON', async () => {
    const huge = await api.app.inject({ method: 'POST', url: '/api/lb04/contracts', headers: { 'authorization': `Bearer ${api.tokenFor(newSession())}`, 'content-type': 'application/json' }, payload: JSON.stringify({ from: 'upload', filename: 'a.pdf', contentBase64: 'A'.repeat(3_500_000) }) })
    expect(huge.statusCode).toBe(413)
    expect(huge.json().error.code).toBe('payload_too_large')

    const xml = await api.app.inject({ method: 'POST', url: '/api/lb04/contracts', headers: { 'authorization': `Bearer ${api.tokenFor(newSession())}`, 'content-type': 'application/xml' }, payload: '<contract/>' })
    expect(xml.statusCode).toBe(415)
    expect(xml.json().error.code).toBe('unsupported_media_type')
  })

  it('refuses a file name with a control character or a bidirectional override, at the door', async () => {
    const bytes = await makePdf(1)
    const send = (filename: string): Promise<LightMyRequestResponse> => api.call('POST', '/contracts', newSession(), { from: 'upload', filename, contentBase64: Buffer.from(bytes).toString('base64') })

    expect((await send('a\u0000.pdf')).statusCode).toBe(422)
    expect((await send('a\u202Efdp.exe')).statusCode).toBe(422)
    expect((await send('a\u001B[31m.pdf')).statusCode).toBe(422)
  })

  it('answers 429 with when the day ends, as a time and as a wait, after three contracts, and nothing more is queued', async () => {
    const session = newSession()
    for (let started = 0; started < 3; started += 1) await startSample(session)

    const refused = await api.call('POST', '/contracts', session, { from: 'sample', sampleId: 'wholesale-supply' })

    expect(refused.statusCode).toBe(429)
    expect(refused.json().error).toMatchObject({ code: 'daily_limit', resets_at: expect.stringMatching(/T00:00:00\.000Z$/) })
    const secondsLeft = (Date.parse(refused.json().error.resets_at as string) - api.engine.clock.now().getTime()) / 1_000
    expect(Math.abs(Number(refused.headers['retry-after']) - secondsLeft)).toBeLessThan(2)
    expect((await api.call('GET', '/limits', session)).json().contracts).toEqual({ limit: 3, used: 3, remaining: 0 })
    // Another visitor's day is their own.
    expect((await api.call('POST', '/contracts', newSession(), { from: 'sample', sampleId: 'wholesale-supply' })).statusCode).toBe(201)
  })

  it('answers 503 and takes nothing when the review can\'t be queued', async () => {
    const session = newSession()
    api.engine.scheduler.failNextEnqueue(new Error('redis is down'))

    const refused = await api.call('POST', '/contracts', session, { from: 'sample', sampleId: 'wholesale-supply' })

    expect(refused.statusCode).toBe(503)
    expect(refused.json().error.code).toBe('queue_unavailable')
    expect((await api.call('GET', '/limits', session)).json().contracts.used).toBe(0)
  })
})

describe('following a review', () => {
  it('answers 409 for the pages, the file and the report while the review has not finished, and then serves each as the review made it', async () => {
    const session = newSession()
    const contract = await startSample(session)
    const early = await api.call('GET', `/contracts/${contract.id}/report`, session)
    expect(early.statusCode).toBe(409)
    expect(early.json().error.code).toBe('not_ready')

    await drive(api.engine)

    const view = lb04ContractViewSchema.parse((await api.call('GET', `/contracts/${contract.id}`, session)).json())
    expect(view).toMatchObject({ state: 'done', pages: 11 })
    const pages = lb04PagesViewSchema.parse((await api.call('GET', `/contracts/${contract.id}/pages`, session)).json())
    expect(pages.pages).toEqual(await extractedPages('wholesale-supply'))
    const file = lb04FileViewSchema.parse((await api.call('GET', `/contracts/${contract.id}/file`, session)).json())
    expect(Buffer.from(file.base64, 'base64').equals(Buffer.from(seedBytes('wholesale-supply')))).toBe(true)
    const report = lb04ReportSchema.parse((await api.call('GET', `/contracts/${contract.id}/report`, session)).json())
    expect(report).toMatchObject({ contractId: contract.id, notLegalAdvice: 'Not legal advice', redlines: [] })
    expect(report.findings.length).toBeGreaterThan(3)
  })

  it('serves a report whose every risk finding quotes the contract at the page and characters it cites: the same words, which the quote shows with the line breaks joined', async () => {
    const { report } = await reviewed(newSession())
    const pages = await extractedPages('wholesale-supply')

    const risks = report.findings.filter(finding => finding.kind === 'risk')
    expect(risks.length).toBeGreaterThan(0)
    for (const finding of risks) {
      const page = pages.find(candidate => candidate.page === finding.citation.page)
      const cited = page?.text.slice(finding.citation.start, finding.citation.end) ?? ''
      expect(foldQuote(cited), finding.id).toBe(foldQuote(finding.quote))
      expect(finding.quote, finding.id).not.toMatch(/[\n\r]/)
    }
  })

  it('says why a failed review failed, and answers 409 review_failed for what it will never have', async () => {
    const session = newSession()
    const contract = await startSample(session, 'scanned-supply')
    await drive(api.engine)

    const view = lb04ContractViewSchema.parse((await api.call('GET', `/contracts/${contract.id}`, session)).json())
    expect(view.state).toBe('failed')
    expect(view.failure).toEqual({ code: 'no_text_layer', message: expect.stringContaining('no text layer') })
    for (const path of ['pages', 'file', 'report']) {
      const response = await api.call('GET', `/contracts/${contract.id}/${path}`, session)
      expect(response.statusCode, path).toBe(409)
      expect(response.json().error.code, path).toBe('review_failed')
    }
    // The visitor's place for the day came back with the failure.
    expect((await api.call('GET', '/limits', session)).json().contracts.used).toBe(0)
  })

  it('shows another visitor nothing: their contract is not found by any route, and cannot be deleted or redlined by them', async () => {
    const owner = newSession()
    const { contract, report } = await reviewed(owner)
    const stranger = newSession()
    const finding = report.findings[0]?.id ?? 'f1'

    const calls: [method: 'GET' | 'POST' | 'DELETE', url: string][] = [
      ['GET', `/contracts/${contract.id}`],
      ['GET', `/contracts/${contract.id}/pages`],
      ['GET', `/contracts/${contract.id}/file`],
      ['GET', `/contracts/${contract.id}/report`],
      ['POST', `/contracts/${contract.id}/findings/${finding}/redline`],
      ['DELETE', `/contracts/${contract.id}`],
    ]
    for (const [method, url] of calls) {
      const response = await api.call(method, url, stranger)
      expect(response.statusCode, `${method} ${url}`).toBe(404)
      expect(response.json().error.code).toBe('contract_not_found')
    }
    expect((await api.call('GET', '/contracts', stranger)).json()).toEqual([])
    // The owner still has it.
    expect((await api.call('GET', `/contracts/${contract.id}`, owner)).statusCode).toBe(200)
  })

  it('answers 404 for an id that is not a UUID the same way it does for one that is nobody\'s: 422 for the form, 404 for the rest', async () => {
    const session = newSession()

    expect((await api.call('GET', '/contracts/not-a-uuid', session)).statusCode).toBe(422)
    expect((await api.call('GET', '/contracts/22222222-2222-4222-8222-222222222222', session)).statusCode).toBe(404)
  })

  it('deletes a contract at once on request, answers 204, and does not give the visitor\'s place back', async () => {
    const session = newSession()
    const contract = await startSample(session)
    await drive(api.engine)

    const deleted = await api.call('DELETE', `/contracts/${contract.id}`, session)

    expect(deleted.statusCode).toBe(204)
    expect(deleted.body).toBe('')
    expect((await api.call('GET', `/contracts/${contract.id}`, session)).statusCode).toBe(404)
    expect((await api.call('DELETE', `/contracts/${contract.id}`, session)).statusCode).toBe(404)
    expect((await api.call('GET', '/limits', session)).json().contracts.used).toBe(1)
    const kept = await api.engine.query('SELECT (SELECT count(*) FROM lb04.contract_files WHERE contract_id = $1)::int AS files, (SELECT count(*) FROM lb04.reports WHERE contract_id = $1)::int AS reports', [contract.id])
    expect(kept[0]).toEqual({ files: 0, reports: 0 })
  })

  it('does not find a contract once its hour is up, even before the sweep has deleted it', async () => {
    const session = newSession()
    const contract = await startSample(session)
    await drive(api.engine)
    api.engine.clock.advance(61 * 60_000)

    expect((await api.call('GET', `/contracts/${contract.id}`, session)).statusCode).toBe(404)
    expect((await api.call('GET', `/contracts/${contract.id}/report`, session)).statusCode).toBe(404)
  })
})

describe('redlines', () => {
  it('proposes wording, computes the difference by code, and shows the redline in the report', async () => {
    const session = newSession()
    const { contract, report } = await reviewed(session)
    const risk = report.findings.find(finding => finding.kind === 'risk')
    if (risk?.kind !== 'risk') throw new Error('The report has no risk finding.')

    const response = await api.call('POST', `/contracts/${contract.id}/findings/${risk.id}/redline`, session)

    expect(response.statusCode, response.body).toBe(201)
    const redline = lb04RedlineSchema.parse(response.json())
    expect(redline).toMatchObject({ findingId: risk.id, original: risk.quote, source: 'model', notLegalAdvice: 'Not legal advice' })
    // The diff is the server's: the equal and deleted parts put back together make the contract's own words, the equal and inserted parts the proposal.
    expect(redline.diff.filter(part => part.op !== 'insert').map(part => part.text).join(' ')).toBe(wordsOf(risk.quote).join(' '))
    expect(redline.diff.filter(part => part.op !== 'delete').map(part => part.text).join(' ')).toBe(wordsOf(redline.proposal).join(' '))
    const after = lb04ReportSchema.parse((await api.call('GET', `/contracts/${contract.id}/report`, session)).json())
    expect(after.redlines).toEqual([redline])
    expect(lb04ContractViewSchema.parse((await api.call('GET', `/contracts/${contract.id}`, session)).json()).redlinesLeft).toBe(2)
  })

  it('shows a redline already made without a second call: 200, the same redline, and the model is not asked again', async () => {
    const session = newSession()
    const { contract, report } = await reviewed(session)
    const finding = report.findings[0]?.id ?? 'f1'
    const asked = referenceFast.conversations.length

    const first = await api.call('POST', `/contracts/${contract.id}/findings/${finding}/redline`, session)
    const again = await api.call('POST', `/contracts/${contract.id}/findings/${finding}/redline`, session)

    expect(first.statusCode).toBe(201)
    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual(first.json())
    expect(referenceFast.conversations.length).toBe(asked + 1)
    expect(lb04ContractViewSchema.parse((await api.call('GET', `/contracts/${contract.id}`, session)).json()).redlinesLeft).toBe(2)
  })

  it('gives three redlines a contract and answers 429 for a fourth, and the three made are in the report', async () => {
    const session = newSession()
    const { contract, report } = await reviewed(session)
    expect(report.findings.length).toBeGreaterThanOrEqual(4)

    for (const finding of report.findings.slice(0, 3)) {
      expect((await api.call('POST', `/contracts/${contract.id}/findings/${finding.id}/redline`, session)).statusCode).toBe(201)
    }
    const fourth = await api.call('POST', `/contracts/${contract.id}/findings/${report.findings[3]?.id ?? 'f4'}/redline`, session)

    expect(fourth.statusCode).toBe(429)
    expect(fourth.json().error.code).toBe('redline_limit')
    const after = lb04ReportSchema.parse((await api.call('GET', `/contracts/${contract.id}/report`, session)).json())
    expect(after.redlines).toHaveLength(3)
  })

  it('takes exactly three places when five requests for five findings arrive at once', async () => {
    const session = newSession()
    const { contract, report } = await reviewed(session)

    const responses = await Promise.all(report.findings.slice(0, 5).map(finding => api.call('POST', `/contracts/${contract.id}/findings/${finding.id}/redline`, session)))

    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 201, 201, 429, 429])
    const after = lb04ReportSchema.parse((await api.call('GET', `/contracts/${contract.id}/report`, session)).json())
    expect(after.redlines).toHaveLength(3)
  })

  it('keeps one redline when two requests for the same finding arrive at once, and spends one place', async () => {
    const session = newSession()
    const { contract, report } = await reviewed(session)
    const finding = report.findings[0]?.id ?? 'f1'

    const responses = await Promise.all([1, 2].map(() => api.call('POST', `/contracts/${contract.id}/findings/${finding}/redline`, session)))

    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 201])
    expect(responses[0]?.json()).toEqual(responses[1]?.json())
    expect(lb04ContractViewSchema.parse((await api.call('GET', `/contracts/${contract.id}`, session)).json()).redlinesLeft).toBe(2)
  })

  it('writes the playbook\'s own wording when the model answers in no usable form, and still spends the place and the call', async () => {
    const session = newSession()
    const { contract, report } = await reviewed(session)
    fastScript = new ScriptedModel(() => ({ kind: 'text', text: 'Sorry, I cannot do that.' }))
    try {
      const response = await api.call('POST', `/contracts/${contract.id}/findings/${report.findings[0]?.id ?? 'f1'}/redline`, session)

      expect(response.statusCode).toBe(201)
      expect(response.json().source).toBe('playbook')
    }
    finally {
      fastScript = undefined
    }
  })

  it('answers 503 when the model cannot be reached, with the wait the gateway asked for, and gives the place back', async () => {
    const session = newSession()
    const { contract, report } = await reviewed(session)
    fastScript = new ScriptedModel(() => {
      throw new GatewayCallError('upstream_failed', 502, 9)
    })
    try {
      const response = await api.call('POST', `/contracts/${contract.id}/findings/${report.findings[0]?.id ?? 'f1'}/redline`, session)

      expect(response.statusCode).toBe(503)
      expect(response.json().error.code).toBe('analysis_unavailable')
      expect(response.headers['retry-after']).toBe('9')
    }
    finally {
      fastScript = undefined
    }
    expect(lb04ContractViewSchema.parse((await api.call('GET', `/contracts/${contract.id}`, session)).json()).redlinesLeft).toBe(3)
  })

  it('answers 404 for a finding the contract does not have, 422 for one that is not an id, and 409 before the review is done', async () => {
    const session = newSession()
    const { contract } = await reviewed(session)

    expect((await api.call('POST', `/contracts/${contract.id}/findings/f99/redline`, session)).json().error.code).toBe('finding_not_found')
    expect((await api.call('POST', `/contracts/${contract.id}/findings/x1/redline`, session)).statusCode).toBe(422)
    const waiting = await startSample(session, 'clean-supply')
    expect((await api.call('POST', `/contracts/${waiting.id}/findings/f1/redline`, session)).statusCode).toBe(409)
  })

  it('does nothing for a service with no gateway: 503, and no place is taken', async () => {
    const session = newSession()
    const { contract, report } = await reviewed(session)
    const saved = api.engine.deps.review
    api.engine.deps.review = undefined
    try {
      const response = await api.call('POST', `/contracts/${contract.id}/findings/${report.findings[0]?.id ?? 'f1'}/redline`, session)

      expect(response.statusCode).toBe(503)
    }
    finally {
      api.engine.deps.review = saved
    }
    expect(lb04ContractViewSchema.parse((await api.call('GET', `/contracts/${contract.id}`, session)).json()).redlinesLeft).toBe(3)
  })
})

describe('what the answers hold', () => {
  it('never carries a path of the server, a stack or a provider\'s name in an error', async () => {
    const session = newSession()
    const answers = [
      await api.call('GET', '/contracts/22222222-2222-4222-8222-222222222222', session),
      await api.call('POST', '/contracts', session, { from: 'sample', sampleId: 'nope' }),
      await api.call('POST', '/contracts', session, {}),
      await api.call('GET', '/nowhere', session),
    ]

    for (const answer of answers) {
      expect(answer.body).not.toMatch(/node_modules|\/home\/|at \w+ \(|groq|openrouter|workers-ai|postgres/i)
      expect(Object.keys(answer.json())).toEqual(['error'])
    }
  })

  it('keeps the sample files outside what a visitor can name: the sample route takes an id from the list and nothing else', async () => {
    const list = readFileSync(`${seedDirectory()}/lb04/samples.yaml`, 'utf8')
    expect(list).toContain('wholesale-supply')

    for (const sampleId of ['../contracts/wholesale-supply', 'wholesale-supply.pdf', 'WHOLESALE-SUPPLY', 'wholesale-supply/../clean-supply']) {
      const response = await api.call('POST', '/contracts', newSession(), { from: 'sample', sampleId })
      expect([404, 422], sampleId).toContain(response.statusCode)
    }
  })
})
