// Tests of the mock back end's LB-04: reviewing a sample contract or a file sent, the states a review
// moves through as the site polls it, the pages, the file and the report with its citations, the
// refusals and the place a failed review gives back, the daily limits and their Retry-After, the
// redlines, a visitor's privacy and the contract's hour, and the Scope's trace. Every answer is
// checked against the committed OpenAPI document by the mock itself (`violations`), and the answers
// are read with the contracts' own schemas, so a change to either shows up here. The mock reviews
// with the service's own pipeline, so what is asserted of a sample is what the golden set plants.
import { generateKeyPairSync } from 'node:crypto'

import { mintServiceToken } from '@lb/common/tokens'
import { mintVisitorToken } from '@lb/common/visitors'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { foldQuote, lb04ContractViewSchema, lb04LimitsViewSchema, lb04PagesViewSchema, lb04PlaybookViewSchema, lb04RedlineSchema, lb04ReportSchema, LB04_LIMITS } from '../../contracts/src/index.ts'
import type { Lb04ContractView, Lb04Report } from '../../contracts/src/index.ts'
import { readLb04Seed, startMockBackend } from '../src/testing/index.ts'
import type { MockBackend } from '../src/testing/index.ts'

const site = generateKeyPairSync('ed25519')
const web = generateKeyPairSync('ed25519')
const seed = readLb04Seed()
let clock = Date.UTC(2026, 9, 5, 9, 0, 0)
let mock: MockBackend

beforeAll(async () => {
  mock = await startMockBackend({
    siteKey: site.publicKey.export({ format: 'jwk' }).x ?? '',
    webKey: web.publicKey.export({ format: 'jwk' }).x ?? '',
    now: () => clock,
  })
})

afterAll(async () => {
  await mock.close()
})

beforeEach(() => {
  mock.reset()
  clock = Date.UTC(2026, 9, 5, 9, 0, 0)
})

/** What a call to the mock answered. */
interface Reply {
  status: number
  json: any // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Headers
}

/** Calls LB-04 as a visitor. */
async function call(method: string, path: string, body?: unknown, visitor = 'visitor-aaaaaaaaaaaaaaaa'): Promise<Reply> {
  const token = mintVisitorToken(site.privateKey, { system: 'lb-04', sessionKey: visitor }, clock / 1000)
  const response = await fetch(`${mock.url}/api/lb04${path}`, {
    method,
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, json: text === '' ? undefined : JSON.parse(text), headers: response.headers }
}

/** Starts the review of a sample and returns the contract as it was answered. */
async function reviewSample(id: string, visitor?: string): Promise<Reply> {
  return call('POST', '/contracts', { from: 'sample', sampleId: id }, visitor)
}

/** Sends a file as a visitor does: as base64 in JSON. */
async function sendFile(bytes: Uint8Array, filename = 'agreement.pdf', visitor?: string): Promise<Reply> {
  return call('POST', '/contracts', { from: 'upload', filename, contentBase64: Buffer.from(bytes).toString('base64') }, visitor)
}

/** The bytes of a sample's file. */
function bytesOf(id: string): Uint8Array {
  const sample = seed.samples.find(candidate => candidate.entry.id === id)
  if (!sample) throw new Error(`There is no sample ${id}.`)
  return sample.bytes
}

/** Polls a contract as the site does, until it is done or has failed, and returns the state of every poll. */
async function follow(id: string, visitor?: string): Promise<{ states: string[], contract: Lb04ContractView }> {
  const states: string[] = []
  for (let poll = 0; poll < 10; poll += 1) {
    const answer = await call('GET', `/contracts/${id}`, undefined, visitor)
    expect(answer.status).toBe(200)
    const contract = lb04ContractViewSchema.parse(answer.json)
    states.push(contract.state)
    if (contract.state === 'done' || contract.state === 'failed') return { states, contract }
  }
  throw new Error('The review did not end.')
}

/** Reviews a sample to its end and returns its report. */
async function finished(id: string): Promise<{ contract: Lb04ContractView, report: Lb04Report, pages: { page: number, text: string }[] }> {
  const started = await reviewSample(id)
  const { contract } = await follow(started.json.id)
  const report = await call('GET', `/contracts/${contract.id}/report`)
  const pages = await call('GET', `/contracts/${contract.id}/pages`)
  return { contract, report: lb04ReportSchema.parse(report.json), pages: lb04PagesViewSchema.parse(pages.json).pages }
}

/** Reads a contract's spans from the mock's Scope route as the `web` service. */
async function scope(runId: string): Promise<Reply> {
  const authorization = `Bearer ${mintServiceToken('web', web.privateKey, clock / 1000)}`
  const response = await fetch(`${mock.url}/v1/runs/${runId}/spans`, { headers: { authorization } })
  return { status: response.status, json: await response.json(), headers: response.headers }
}

/** The golden case of a sample, which must be one that is read. */
function planted(id: string) {
  const golden = seed.samples.find(candidate => candidate.entry.id === id)?.golden
  if (golden?.kind !== 'report') throw new Error(`${id} is not a report case.`)
  return golden
}

describe('what LB-04 offers before anything is reviewed', () => {
  it('lists the six samples with their page counts, one of them over the limit', async () => {
    const answer = await call('GET', '/samples')

    expect(answer.status).toBe(200)
    expect(answer.json.map((sample: { id: string }) => sample.id)).toEqual(seed.samples.map(sample => sample.entry.id))
    expect(answer.json.find((sample: { id: string }) => sample.id === 'master-supply-31')).toMatchObject({ pages: 31 })
  })

  it('serves the playbook with its nine topics, and a visitor\'s full day', async () => {
    const playbook = lb04PlaybookViewSchema.parse((await call('GET', '/playbook')).json)
    const limits = lb04LimitsViewSchema.parse((await call('GET', '/limits')).json)

    expect(playbook.topics.map(topic => topic.id)).toHaveLength(9)
    expect(playbook.topics.flatMap(topic => topic.rules)).toHaveLength(21)
    expect(limits).toEqual({ contracts: { limit: 3, used: 0, remaining: 3 }, maxPages: 30, maxFileBytes: 2_097_152, keptMinutes: 60, redlinesPerContract: 3, resetsAt: '2026-10-06T00:00:00.000Z' })
  })

  it('wants a visitor token for this system', async () => {
    const response = await fetch(`${mock.url}/api/lb04/limits`)

    expect(response.status).toBe(401)
  })
})

describe('a review of a sample contract', () => {
  it('is queued at once and moves one state for each poll: extracting, analysing, verifying, done', async () => {
    const started = await reviewSample('wholesale-supply')
    const { states } = await follow(started.json.id)

    expect(started.status).toBe(201)
    expect(started.json).toMatchObject({ state: 'queued', origin: 'sample', sampleId: 'wholesale-supply', title: 'Wholesale supply agreement', pages: null, failure: null, redlinesLeft: 3, notLegalAdvice: 'Not legal advice' })
    expect(started.json.runId).toBe(started.json.id)
    expect(states).toEqual(['extracting', 'analysing', 'verifying', 'done'])
  })

  it('shows the pages from the moment the file has been read, and the report only once it is done', async () => {
    const started = await reviewSample('wholesale-supply')
    const id = started.json.id

    expect((await call('GET', `/contracts/${id}/pages`)).json.error.code).toBe('not_ready')
    expect((await call('GET', `/contracts/${id}/report`)).json.error.code).toBe('not_ready')
    await call('GET', `/contracts/${id}`)
    expect((await call('GET', `/contracts/${id}/pages`)).status).toBe(409)
    const analysing = await call('GET', `/contracts/${id}`)
    const pages = await call('GET', `/contracts/${id}/pages`)

    expect(analysing.json).toMatchObject({ state: 'analysing', pages: 11 })
    expect(pages.status).toBe(200)
    expect(lb04PagesViewSchema.parse(pages.json).pages).toHaveLength(11)
    expect((await call('GET', `/contracts/${id}/report`)).status).toBe(409)
  })

  it('serves the PDF itself from the start, as base64, and it is the sample\'s own file', async () => {
    const started = await reviewSample('wholesale-supply')
    const file = await call('GET', `/contracts/${started.json.id}/file`)

    expect(file.status).toBe(200)
    expect(file.json).toMatchObject({ contentType: 'application/pdf', size: bytesOf('wholesale-supply').byteLength })
    expect(Buffer.from(file.json.base64, 'base64').equals(Buffer.from(bytesOf('wholesale-supply')))).toBe(true)
  })

  it('finds exactly what the golden set plants, each risk with a citation that points at its own words', async () => {
    const { report, pages } = await finished('wholesale-supply')
    const expected = planted('wholesale-supply')
    const risks = report.findings.filter(finding => finding.kind === 'risk')

    expect(risks.map(finding => finding.rule).sort()).toEqual(expected.planted.map(item => item.rule).sort())
    for (const finding of risks) {
      const text = pages.find(page => page.page === finding.citation.page)?.text ?? ''
      expect(foldQuote(text.slice(finding.citation.start, finding.citation.end)), finding.rule).toBe(foldQuote(finding.quote))
    }
    expect(report.calls).toBe(3)
    expect(report.calibrated).toBe(true)
    expect(report.screen.verdict).toBe('clean')
    expect(report.radar).toHaveLength(9)
    expect(report.notLegalAdvice).toBe('Not legal advice')
  })

  it('finds nothing in the fair contract, and the radar is empty', async () => {
    const { report } = await finished('clean-supply')

    expect(report.findings).toEqual([])
    expect(report.radar.every(score => score.score === 0 && score.findings === 0)).toBe(true)
    expect(report.calls).toBe(2)
  })

  it('reads the 30-page contract, which is exactly the limit', async () => {
    const { contract, pages } = await finished('master-supply-30')

    expect(contract.pages).toBe(30)
    expect(pages).toHaveLength(30)
  })

  it('flags the contract that talks to its reviewer, and no finding rests on what it says', async () => {
    const { report, pages } = await finished('hostile-supply')

    expect(report.screen.verdict).toBe('flagged')
    expect(report.screen.passageCount).toBeGreaterThan(0)
    for (const finding of report.findings) {
      if (finding.kind !== 'risk') continue
      for (const passage of report.screen.passages) {
        if (passage.page !== finding.citation.page) continue
        const overlaps = finding.citation.start < passage.end && passage.start < finding.citation.end
        expect(overlaps, `${finding.rule} rests on an instruction`).toBe(false)
      }
    }
    expect(pages.length).toBeGreaterThan(0)
  })

  it('keeps the visitor\'s contracts in a list, newest first, and takes one of the day\'s three for each', async () => {
    const first = await reviewSample('clean-supply')
    clock += 1_000
    const second = await reviewSample('wholesale-supply')
    const list = await call('GET', '/contracts')
    const limits = await call('GET', '/limits')

    expect(list.json.map((contract: { id: string }) => contract.id)).toEqual([second.json.id, first.json.id])
    expect(limits.json.contracts).toEqual({ limit: 3, used: 2, remaining: 1 })
  })

  it('does not know a sample it was not given', async () => {
    const answer = await reviewSample('not-a-sample')

    expect(answer.status).toBe(404)
    expect(answer.json.error.code).toBe('unknown_sample')
  })
})

describe('a file that is refused', () => {
  it('is the scan: no text layer, found when the file is opened, and the place of the day is given back', async () => {
    const started = await reviewSample('scanned-supply')
    const { states, contract } = await follow(started.json.id)
    const limits = await call('GET', '/limits')

    expect(states).toEqual(['extracting', 'failed'])
    expect(contract.failure).toEqual({ code: 'no_text_layer', message: 'The PDF has no text layer, as a scan has, and no OCR is done.' })
    expect(limits.json.contracts.used).toBe(0)
  })

  it('is the 31-page contract: too many pages, with nothing left to show of it', async () => {
    const started = await reviewSample('master-supply-31')
    const { contract } = await follow(started.json.id)

    expect(contract).toMatchObject({ state: 'failed', pages: null, failure: { code: 'too_many_pages' } })
    for (const part of ['pages', 'file', 'report']) {
      const answer = await call('GET', `/contracts/${started.json.id}/${part}`)
      expect(answer.status, part).toBe(409)
      expect(answer.json.error.code, part).toBe('review_failed')
    }
  })

  it('ends as failed with the reason a test chooses: the model out of quota, after the file was read', async () => {
    mock.lb04.failNext('analysis_unavailable')
    const started = await reviewSample('wholesale-supply')
    const { states, contract } = await follow(started.json.id)

    expect(states).toEqual(['extracting', 'analysing', 'failed'])
    expect(contract.failure?.code).toBe('analysis_unavailable')
    expect((await call('GET', '/limits')).json.contracts.used).toBe(0)
    expect(contract.pages).toBe(11)
  })

  it('ends as failed with a file failure a test chooses, as the extraction would', async () => {
    mock.lb04.failNext('pdf_encrypted')
    const started = await reviewSample('clean-supply')
    const { states, contract } = await follow(started.json.id)

    expect(states).toEqual(['extracting', 'failed'])
    expect(contract.failure?.code).toBe('pdf_encrypted')
  })
})

describe('a file sent by the visitor', () => {
  it('that is identical to a sample is reviewed as that sample is, and counts as one of the day\'s ten files', async () => {
    const started = await sendFile(bytesOf('wholesale-supply'), 'C:\\fakepath\\supply.pdf')
    const { contract } = await follow(started.json.id)
    const report = lb04ReportSchema.parse((await call('GET', `/contracts/${contract.id}/report`)).json)

    expect(started.json).toMatchObject({ origin: 'upload', sampleId: null, title: 'supply.pdf' })
    expect(report.findings.filter(finding => finding.kind === 'risk')).toHaveLength(planted('wholesale-supply').planted.length)
    expect((await call('GET', '/limits')).json.contracts.used).toBe(1)
  })

  it('that is any other PDF is opened by the real extraction and reviewed with no risky passage found, only the clauses it really lacks', async () => {
    const other = Buffer.concat([Buffer.from(bytesOf('wholesale-supply')), Buffer.from('\n% a trailing comment, so the bytes are another file\n')])
    const started = await sendFile(other)
    const { contract } = await follow(started.json.id)
    const report = lb04ReportSchema.parse((await call('GET', `/contracts/${contract.id}/report`)).json)

    expect(contract.pages).toBe(11)
    expect(report.findings.map(finding => `${finding.kind}:${finding.rule}`)).toEqual(['absent:liability-cap-present', 'absent:indemnity-present'])
    expect(report.screen.verdict).toBe('clean')
  })

  it('that is not a PDF is refused before anything is taken from the day', async () => {
    const answer = await sendFile(new TextEncoder().encode('This is not a PDF, only a letter.'))

    expect(answer.status).toBe(415)
    expect(answer.json.error.code).toBe('not_a_pdf')
    expect((await call('GET', '/limits')).json.contracts.used).toBe(0)
  })

  it('that is a PDF too large is refused with 413, and one of exactly 2 MiB is taken (the body is 2.8 MB: the upload route is the one that may be that big)', async () => {
    const limit = LB04_LIMITS.maxFileBytes
    const over = Buffer.alloc(limit + 1)
    over.write('%PDF-1.7\n')
    const exactly = Buffer.alloc(limit)
    exactly.write('%PDF-1.7\n')

    expect((await sendFile(over)).status).toBe(413)
    const taken = await sendFile(exactly)
    expect(taken.status).toBe(201)
    const { contract } = await follow(taken.json.id)
    expect(contract.state).toBe('failed')
  })

  it('has a name that is only ever a label: a path is cut to its last part', async () => {
    const answer = await sendFile(bytesOf('clean-supply'), '../../etc/passwd')

    expect(answer.json.title).toBe('passwd')
  })
})

describe('the visitor\'s day', () => {
  it('allows three contracts, then answers 429 with when the day starts again, as a time and as a wait', async () => {
    for (let count = 0; count < 3; count += 1) expect((await reviewSample('clean-supply')).status).toBe(201)
    clock += 3_600_000
    const answer = await reviewSample('clean-supply')

    expect(answer.status).toBe(429)
    expect(answer.json.error).toMatchObject({ code: 'daily_limit', resets_at: '2026-10-06T00:00:00.000Z' })
    expect(answer.headers.get('retry-after')).toBe(String(14 * 3_600))
    expect((await call('GET', '/limits')).json.contracts).toEqual({ limit: 3, used: 3, remaining: 0 })
  })

  it('starts again at midnight UTC', async () => {
    for (let count = 0; count < 3; count += 1) await reviewSample('clean-supply')
    clock = Date.UTC(2026, 9, 6, 0, 0, 1)

    expect((await reviewSample('clean-supply')).status).toBe(201)
  })

  it('counts ten files a day even when each one failed and gave its contract place back', async () => {
    for (let count = 0; count < 10; count += 1) {
      const started = await sendFile(bytesOf('scanned-supply'))
      expect(started.status).toBe(201)
      await follow(started.json.id)
    }
    const answer = await sendFile(bytesOf('scanned-supply'))

    expect(answer.status).toBe(429)
    expect(answer.json.error.code).toBe('upload_limit')
    expect((await call('GET', '/limits')).json.contracts.used).toBe(0)
    expect((await reviewSample('clean-supply')).status).toBe(201)
  })
})

describe('a redline', () => {
  it('is made by the real proposal and shown with the difference the server computed, and asking again costs nothing', async () => {
    const { contract, report } = await finished('wholesale-supply')
    const finding = report.findings.find(candidate => candidate.kind === 'risk')
    if (!finding) throw new Error('The report has no risk finding.')

    const made = await call('POST', `/contracts/${contract.id}/findings/${finding.id}/redline`)
    const again = await call('POST', `/contracts/${contract.id}/findings/${finding.id}/redline`)
    const redline = lb04RedlineSchema.parse(made.json)
    const reread = lb04ReportSchema.parse((await call('GET', `/contracts/${contract.id}/report`)).json)

    expect(made.status).toBe(201)
    expect(again.status).toBe(200)
    expect(again.json).toEqual(made.json)
    expect(redline).toMatchObject({ findingId: finding.id, source: 'model', notLegalAdvice: 'Not legal advice' })
    expect(redline.diff.some(part => part.op === 'insert')).toBe(true)
    expect(redline.diff.some(part => part.op === 'delete')).toBe(true)
    expect(redline.original).toBe(finding.kind === 'risk' ? finding.quote : '')
    expect(reread.redlines).toHaveLength(1)
    expect((await call('GET', `/contracts/${contract.id}`)).json.redlinesLeft).toBe(2)
  })

  it('has only new text for a clause that is missing', async () => {
    const other = Buffer.concat([Buffer.from(bytesOf('wholesale-supply')), Buffer.from('\n% another file\n')])
    const { json } = await sendFile(other)
    const { contract } = await follow(json.id)
    const report = lb04ReportSchema.parse((await call('GET', `/contracts/${contract.id}/report`)).json)
    const missing = report.findings.find(finding => finding.kind === 'absent')
    if (!missing) throw new Error('The report has no missing clause.')

    const redline = lb04RedlineSchema.parse((await call('POST', `/contracts/${contract.id}/findings/${missing.id}/redline`)).json)

    expect(redline.original).toBe('')
    expect(redline.diff.every(part => part.op === 'insert')).toBe(true)
  })

  it('may be made three times for a contract, and the fourth finding is refused', async () => {
    const { contract, report } = await finished('wholesale-supply')
    const ids = report.findings.map(finding => finding.id)
    expect(ids.length).toBeGreaterThanOrEqual(4)

    for (const id of ids.slice(0, 3)) expect((await call('POST', `/contracts/${contract.id}/findings/${id}/redline`)).status).toBe(201)
    const fourth = await call('POST', `/contracts/${contract.id}/findings/${ids[3]}/redline`)

    expect(fourth.status).toBe(429)
    expect(fourth.json.error.code).toBe('redline_limit')
    expect((await call('GET', `/contracts/${contract.id}`)).json.redlinesLeft).toBe(0)
  })

  it('has no finding that is not in the report, and waits for the review to be done', async () => {
    const started = await reviewSample('wholesale-supply')
    const early = await call('POST', `/contracts/${started.json.id}/findings/f1/redline`)
    const { contract } = await follow(started.json.id)
    const missing = await call('POST', `/contracts/${contract.id}/findings/f99/redline`)

    expect(early.status).toBe(409)
    expect(early.json.error.code).toBe('not_ready')
    expect(missing.status).toBe(404)
    expect(missing.json.error.code).toBe('finding_not_found')
  })
})

describe('whose contract it is, and for how long', () => {
  it('is the visitor\'s alone: another visitor finds it exactly as missing as one that was never made', async () => {
    const started = await reviewSample('clean-supply')
    const other = 'visitor-bbbbbbbbbbbbbbbb'

    for (const part of ['', '/pages', '/file', '/report']) {
      const answer = await call('GET', `/contracts/${started.json.id}${part}`, undefined, other)
      expect(answer.status, part).toBe(404)
      expect(answer.json.error.code, part).toBe('contract_not_found')
    }
    expect((await call('GET', '/contracts', undefined, other)).json).toEqual([])
    expect((await call('DELETE', `/contracts/${started.json.id}`, undefined, other)).status).toBe(404)
  })

  it('is gone an hour after it was made', async () => {
    const started = await reviewSample('clean-supply')
    clock += 59 * 60_000

    expect((await call('GET', `/contracts/${started.json.id}`)).status).toBe(200)
    clock += 2 * 60_000
    expect((await call('GET', `/contracts/${started.json.id}`)).status).toBe(404)
    expect((await call('GET', '/contracts')).json).toEqual([])
  })

  it('is deleted at once on request, and the place for the day is not given back', async () => {
    const started = await reviewSample('clean-supply')
    const gone = await call('DELETE', `/contracts/${started.json.id}`)

    expect(gone.status).toBe(204)
    expect((await call('GET', `/contracts/${started.json.id}`)).status).toBe(404)
    expect((await call('GET', '/limits')).json.contracts.used).toBe(1)
  })
})

describe('the Scope\'s trace of a review', () => {
  it('grows as the review does, has the pipeline\'s own steps and the gateway\'s calls under them, and ends with the root span', async () => {
    const started = await reviewSample('wholesale-supply')
    const id = started.json.id
    expect((await scope(id)).status).toBe(404)

    await call('GET', `/contracts/${id}`)
    await call('GET', `/contracts/${id}`)
    const during = await scope(id)
    await call('GET', `/contracts/${id}`)
    await call('GET', `/contracts/${id}`)
    const after = await scope(id)

    expect(during.status).toBe(200)
    expect(during.json.finished).toBe(false)
    expect(after.json.finished).toBe(true)
    expect(after.json.spans.length).toBeGreaterThan(during.json.spans.length)
    const spans = after.json.spans as { spanId: string, parentId?: string, kind: string, name: string, attrs: Record<string, unknown> }[]
    const names = spans.filter(span => span.kind === 'system.step').map(span => span.name)
    expect(names).toEqual(expect.arrayContaining(['extract text', 'split clauses', 'screen for injection', 'cited analysis', 'verify quotes', 'structured report', 'assemble report']))
    expect(spans.filter(span => span.kind === 'gateway.call').map(span => span.name).sort()).toEqual(['lb-guard', 'lb-long', 'lb-reason'])
    const ids = new Set(spans.map(span => span.spanId))
    for (const span of spans) if (span.parentId !== undefined) expect(ids.has(span.parentId), span.name).toBe(true)
    const root = spans.at(-1)
    expect(root).toMatchObject({ kind: 'system.run', name: 'contract review', attrs: { outcome: 'done', origin: 'sample', pages: 11, model_calls: 3 } })
    expect(root?.parentId).toBeUndefined()
  })

  it('has the failure of a review as its root span\'s outcome, and nothing a visitor wrote', async () => {
    const started = await reviewSample('scanned-supply')
    await follow(started.json.id)
    const trace = await scope(started.json.id)

    const root = trace.json.spans.at(-1)
    expect(root).toMatchObject({ kind: 'system.run', status: 'error', attrs: { outcome: 'no_text_layer' } })
    expect(JSON.stringify(trace.json)).not.toMatch(/wholesale|agreement|liability/i)
  })
})

describe('the answers the mock gives', () => {
  it('all fit the committed OpenAPI document, which the mock checks of every answer it gives', async () => {
    const { contract, report } = await finished('wholesale-supply')
    const finding = report.findings[0]
    if (finding) await call('POST', `/contracts/${contract.id}/findings/${finding.id}/redline`)
    await reviewSample('scanned-supply')
    await sendFile(new TextEncoder().encode('not a pdf'))
    await call('DELETE', `/contracts/${contract.id}`)

    expect(mock.violations).toEqual([])
  })
})
