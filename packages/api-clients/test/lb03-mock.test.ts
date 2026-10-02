// Tests for the mock's LB-03 over HTTP, as the site's server and the recorder meet it: a file goes up as a
// multipart form, the document is polled through its states, and it comes back read as the golden set says
// (the samples clean, the planted errors failing their one check, the hostile page stopped, the six-page file
// refused), with its boxes, its checks, its duplicate verdict and its journal entry. A correction runs every
// check again, the exports are the real CSV and JSON shapes, the page is a JPEG, and a visitor's documents,
// day and hour are the real service's rules. Every answer must also fit its OpenAPI document.
import { generateKeyPairSync } from 'node:crypto'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { mintServiceToken } from '@lb/common/tokens'
import { mintVisitorToken } from '@lb/common/visitors'

import { readLb03Seed, startMockBackend } from '../src/testing/index.ts'
import type { MockBackend } from '../src/testing/index.ts'

const site = generateKeyPairSync('ed25519')
const web = generateKeyPairSync('ed25519')
const seed = readLb03Seed()
let clock = Date.UTC(2026, 9, 5, 9, 0, 0)
let mock: MockBackend

beforeAll(async () => {
  mock = await startMockBackend({ siteKey: site.publicKey.export({ format: 'jwk' }).x ?? '', webKey: web.publicKey.export({ format: 'jwk' }).x ?? '', now: () => clock })
})

afterAll(async () => {
  await mock.close()
})

beforeEach(() => {
  mock.reset()
  clock = Date.UTC(2026, 9, 5, 9, 0, 0)
})

/** What a call came back with: the status, the body as JSON when it is, as bytes, and the headers. */
interface Reply {
  status: number
  json: any // eslint-disable-line @typescript-eslint/no-explicit-any
  bytes: Buffer
  headers: Headers
}

/** Signs a visitor token for LB-03 and a visitor, at the test clock. */
function token(visitor: string): string {
  return mintVisitorToken(site.privateKey, { system: 'lb-03', sessionKey: visitor }, clock / 1000)
}

/** Calls the mock as a visitor of LB-03. */
async function call(method: string, path: string, options: { visitor?: string, body?: unknown, raw?: { data: Buffer, type: string } } = {}): Promise<Reply> {
  const headers: Record<string, string> = { authorization: `Bearer ${token(options.visitor ?? 'visitor-aaaaaaaaaaaaaaaa')}` }
  let body: BodyInit | undefined
  if (options.raw !== undefined) {
    headers['content-type'] = options.raw.type
    body = new Uint8Array(options.raw.data)
  }
  else if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const response = await fetch(`${mock.url}${path}`, { method, headers, body })
  const bytes = Buffer.from(await response.arrayBuffer())
  let json: unknown
  try {
    json = JSON.parse(bytes.toString('utf8'))
  }
  catch {
    json = undefined
  }
  return { status: response.status, json, bytes, headers: response.headers }
}

/** Writes a multipart form of one file part, as a browser or the site's server sends it. */
function form(data: Buffer, filename = 'invoice.pdf', name = 'file'): { data: Buffer, type: string } {
  const boundary = '----lb03mock-test-boundary'
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`)
  return { data: Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--\r\n`)]), type: `multipart/form-data; boundary=${boundary}` }
}

/** Reads a seed file of the golden set by the sample name or the case ID. */
function seedFile(name: string): { data: Buffer, filename: string, id: string } {
  const found = seed.cases.find(item => item.sample === name || item.id === name)
  if (found === undefined) throw new Error(`No golden document ${name}.`)
  return { data: seed.file(found.file), filename: found.file.split('/').pop() ?? 'file', id: found.id }
}

/** Uploads a golden document as a visitor. */
function upload(name: string, visitor?: string): Promise<Reply> {
  const { data, filename } = seedFile(name)
  return call('POST', '/api/lb03/documents', { visitor, raw: form(data, filename) })
}

/** Polls a document until it ends, returning every state it showed and the last answer. */
async function pollToEnd(id: string, visitor?: string): Promise<{ states: string[], document: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const states: string[] = []
  for (let poll = 0; poll < 12; poll += 1) {
    const { json } = await call('GET', `/api/lb03/documents/${id}`, { visitor })
    states.push(json.state)
    if (json.state === 'ready' || json.state === 'failed') return { states, document: json }
  }
  throw new Error(`The document did not end: ${states.join(', ')}`)
}

/** Uploads a golden document and reads it to its end. */
async function read(name: string, visitor?: string) {
  const created = await upload(name, visitor)
  expect(created.status).toBe(202)
  return pollToEnd(created.json.id, visitor)
}

describe('an upload', () => {
  it('is answered 202 at once with the document waiting, and is polled through the states of the pipeline', async () => {
    const created = await upload('clean-pdf')

    expect(created.status).toBe(202)
    expect(created.json).toMatchObject({ state: 'uploaded', label: 'bohemia-packaging-2026-0412.pdf', kind: 'pdf', failure: null, fields: null, checks: null, run_id: null, can_export: false, queued_ahead: 0 })
    expect(created.json.id).toMatch(/^[\w-]{22}$/)
    const { states } = await pollToEnd(created.json.id)
    expect(states).toEqual(['ocr', 'extract', 'validate', 'ready'])
    expect(mock.violations).toEqual([])
  })

  it('shows more of what the run has done at each state, and a trace only once it has ended', async () => {
    const created = await upload('clean-pdf')
    const seen: [string, string[], string | null][] = []

    for (let poll = 0; poll < 4; poll += 1) {
      const { json } = await call('GET', `/api/lb03/documents/${created.json.id}`)
      seen.push([json.state, json.steps.map((step: { name: string }) => step.name), json.run_id === null ? null : 'run'])
    }

    expect(seen).toEqual([
      ['ocr', ['queue'], null],
      ['extract', ['queue', 'ocr'], null],
      ['validate', ['queue', 'ocr', 'injection check', 'extract'], null],
      ['ready', ['queue', 'ocr', 'injection check', 'extract', 'validate', 'place fields', 'check duplicates', 'journal entry'], 'run'],
    ])
  })

  it('reads a sample as itself: every field with its box, every check passed, a journal entry, and no duplicate', async () => {
    const { document } = await read('clean-pdf')

    expect(document).toMatchObject({ state: 'ready', pages: 1, model_calls: 2, can_export: true, journal_status: 'made', duplicate: null, corrections: [], failure: null })
    expect(document.checks.map((check: { id: string }) => check.id)).toEqual(['required_fields', 'dates_valid', 'currency_known', 'signs_agree', 'line_math', 'line_items_sum', 'vat_math', 'vat_bases', 'total_reconciles', 'fields_on_page', 'not_duplicate'])
    expect(document.checks.every((check: { status: string }) => check.status === 'passed')).toBe(true)
    const total = document.fields.find((field: { path: string }) => field.path === 'total')
    expect(total).toMatchObject({ kind: 'amount', value: '10406.00', edited: false, checks: [] })
    expect(total.box).toMatchObject({ page: 1, band: 'high' })
    expect(total.box.quad).toHaveLength(8)
    expect(document.fields.find((field: { path: string }) => field.path === 'document_type').box).toBeNull()
    expect(document.journal).toMatchObject({ currency: 'CZK', total_debit: '10406.00', total_credit: '10406.00' })
    expect(mock.violations).toEqual([])
  })

  it('reads a photograph with the vision model and a few boxes it is less sure of, and a handwritten receipt with one it did not find', async () => {
    const photo = (await read('crumpled-photo')).document
    const receipt = (await read('handwritten-receipt')).document

    expect(photo.steps.find((step: { name: string }) => step.name === 'extract').detail).toMatchObject({ alias: 'lb-vision', picture: true })
    expect(photo.fields.some((field: { box: { band: string } | null }) => field.box !== null && field.box.band !== 'high')).toBe(true)
    expect(receipt.fields.find((field: { path: string }) => field.path === 'line_items.0.description').box).toBeNull()
    expect(receipt.checks.find((check: { id: string }) => check.id === 'fields_on_page')).toMatchObject({ status: 'failed', severity: 'warning', fields: ['line_items.0.description'] })
    // A warning is a finding, not a stop: the receipt is still exported, and its entry takes the VAT out of the prices.
    expect(receipt).toMatchObject({ can_export: true, journal_status: 'made', prices_include_vat: true })
    expect(receipt.journal.lines.map((line: { account: string, debit: string, credit: string }) => [line.account, line.debit, line.credit])).toEqual([['5070', '116.07', '0.00'], ['1400', '13.93', '0.00'], ['1010', '0.00', '130.00']])
  })

  it('reports a planted error and never fixes it: the one check fails, the model is sent back once, nothing is exported', async () => {
    const { states, document } = await read('planted-total')

    expect(states).toEqual(['ocr', 'extract', 'validate', 'repair', 'ready'])
    expect(document).toMatchObject({ state: 'ready', model_calls: 3, can_export: false, journal: null, journal_status: 'blocked_by_checks' })
    const total = document.checks.find((check: { id: string }) => check.id === 'total_reconciles')
    expect(total).toMatchObject({ status: 'failed', severity: 'error', fields: ['total'], expected: '1193.85', actual: '1293.85' })
    expect(document.fields.find((field: { path: string }) => field.path === 'total')).toMatchObject({ value: '1293.85', checks: ['total_reconciles'] })
    expect(document.steps.find((step: { name: string }) => step.name === 'repair').detail).toMatchObject({ adopted: false })
  })

  it('stops a hostile page at the injection check, with no model asked, and the six-page file at the reader', async () => {
    const hostile = (await read('prompt-injection')).document
    const long = (await read('six-pages-bohemia-2026-0888')).document

    expect(hostile).toMatchObject({ state: 'failed', failure: { code: 'injection_suspected' }, fields: null, can_export: false, model_calls: 1 })
    expect(hostile.steps.map((step: { name: string, status: string }) => [step.name, step.status]).at(-1)).toEqual(['injection check', 'error'])
    expect(long).toMatchObject({ state: 'failed', failure: { code: 'too_many_pages' }, model_calls: 0 })
    expect(long.failure.message).toBe('The file has more than 5 pages.')
    expect(hostile.run_id).toMatch(/^run-/)
  })

  it('reads a file the golden set does not know as the clean sample, under its own name', async () => {
    const data = Buffer.from('%PDF-1.7\n% a PDF of the visitor\'s own\n')
    const created = await call('POST', '/api/lb03/documents', { raw: form(data, 'C:\\fakepath\\My invoice (final).pdf') })

    const { document } = await pollToEnd(created.json.id)

    expect(created.json.label).toBe('My invoice (final).pdf')
    expect(document).toMatchObject({ state: 'ready', can_export: true })
    expect(document.fields.find((field: { path: string }) => field.path === 'vendor').value).toBe('Bohemia Packaging s.r.o.')
  })

  it('refuses what is not a PDF, PNG, JPEG or WebP by its first bytes, and a file over 10 MB, before anything is read or counted', async () => {
    const text = await call('POST', '/api/lb03/documents', { raw: form(Buffer.from('Dear sir, here is my invoice.'), 'invoice.pdf') })
    const big = await call('POST', '/api/lb03/documents', { raw: form(Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1_048_576)]), 'big.pdf') })

    expect(text.status).toBe(415)
    expect(text.json.error.code).toBe('unsupported_file')
    expect(big.status).toBe(413)
    expect(big.json.error.code).toBe('too_large')
    expect((await call('GET', '/api/lb03/quota')).json.used).toBe(0)
  })

  it('needs one file part named file, and nothing else', async () => {
    const pdf = Buffer.from('%PDF-1.7\n')

    for (const raw of [form(pdf, 'a.pdf', 'upload'), { data: Buffer.from('not a form'), type: 'multipart/form-data; boundary=xx' }, { data: Buffer.from('{}'), type: 'application/json' }]) {
      const answer = await call('POST', '/api/lb03/documents', { raw })
      expect(answer.status).toBe(422)
      expect(answer.json.error.code).toBe('invalid_request')
    }
    expect((await call('POST', '/api/lb03/documents')).status).toBe(422)
  })
})

describe('the duplicate check', () => {
  it('names the visitor\'s own first reading for a second upload of a sample, and another visitor never meets it', async () => {
    const first = await read('clean-pdf')
    const second = await read('clean-pdf')
    const other = await read('clean-pdf', 'visitor-bbbbbbbbbbbbbbbb')

    expect(second.document.duplicate).toEqual({ of: first.document.id, source: 'document', same_content: true })
    expect(second.document).toMatchObject({ can_export: false, journal: null })
    expect(second.document.checks.find((check: { id: string }) => check.id === 'not_duplicate')).toMatchObject({ status: 'failed', severity: 'error', fields: ['vendor', 'invoice_number'] })
    expect(other.document.duplicate).toBeNull()
  })

  it('names the sample for the same invoice in another file, and says whether its content is the same', async () => {
    const reissue = await read('dup-bohemia-0412-reissue')

    expect(reissue.document.duplicate).toEqual({ of: 'clean-pdf', source: 'sample', same_content: true })
    expect(reissue.document.can_export).toBe(false)
  })
})

describe('a visitor\'s day', () => {
  it('has ten documents, and the eleventh is a 429 that says when the count starts again', async () => {
    for (let count = 0; count < 10; count += 1) {
      const created = await upload('clean-pdf')
      expect(created.status, `document ${count + 1}`).toBe(202)
      await pollToEnd(created.json.id)
    }

    const refused = await upload('clean-pdf')

    expect(refused.status).toBe(429)
    expect(refused.json.error).toMatchObject({ code: 'daily_limit', resets_at: '2026-10-06T00:00:00+00:00' })
    expect((await call('GET', '/api/lb03/quota')).json).toMatchObject({ used: 10, remaining: 0, active: 0 })
    clock = Date.UTC(2026, 9, 6, 0, 0, 1)
    expect((await upload('clean-pdf')).status).toBe(202)
  })

  it('lets two documents be read at once and answers the third with a 429 that is not the day\'s', async () => {
    await upload('clean-pdf')
    await upload('crumpled-photo')

    const third = await upload('euro-vat')

    expect(third.status).toBe(429)
    expect(third.json.error.code).toBe('document_running')
    expect((await call('GET', '/api/lb03/quota')).json).toMatchObject({ used: 2, remaining: 8, active: 2, can_read: true })
  })

  it('reports the limits the datasheet promises', async () => {
    const { json } = await call('GET', '/api/lb03/quota')

    expect(json.limits).toEqual({ documents_per_day: 10, concurrent_documents: 2, max_upload_bytes: 10_485_760, max_pages: 5, file_lifetime_seconds: 3_600, max_model_calls_per_document: 5, document_deadline_seconds: 150 })
  })

  it('keeps a document for an hour, and a visitor sees only their own', async () => {
    const created = await upload('clean-pdf')
    await pollToEnd(created.json.id)
    const path = `/api/lb03/documents/${created.json.id}`

    for (const [method, url] of [['GET', path], ['GET', `${path}/pages/1`], ['GET', `${path}/export?format=json`], ['DELETE', path]]) {
      const stranger = await call(method!, url!, { visitor: 'visitor-bbbbbbbbbbbbbbbb' })
      expect(stranger.status, `${method} ${url}`).toBe(404)
      expect(stranger.json.error.code).toBe('not_found')
    }
    expect((await call('GET', '/api/lb03/documents', { visitor: 'visitor-bbbbbbbbbbbbbbbb' })).json).toEqual({ documents: [] })
    clock += 3_600_001
    expect((await call('GET', path)).status).toBe(404)
  })

  it('lists the documents newest first, with how each stands', async () => {
    const first = await upload('clean-pdf')
    await pollToEnd(first.json.id)
    clock += 1_000
    const second = await upload('planted-total')
    await pollToEnd(second.json.id)

    const { json } = await call('GET', '/api/lb03/documents')

    expect(json.documents.map((item: { id: string }) => item.id)).toEqual([second.json.id, first.json.id])
    expect(json.documents.map((item: { checks_failed: number, can_export: boolean }) => [item.checks_failed, item.can_export])).toEqual([[1, false], [0, true]])
    expect(mock.violations).toEqual([])
  })
})

describe('a correction', () => {
  /** Reads the clean sample and corrects one of its fields. */
  async function correct(path: string, value: string, id?: string) {
    const document = id === undefined ? (await read('clean-pdf')).document : { id }
    return { id: document.id as string, reply: await call('POST', `/api/lb03/documents/${document.id}/corrections`, { body: { path, value } }) }
  }

  it('runs every check again: the arithmetic fails, the export is blocked, the field loses its box and the correction is recorded', async () => {
    const { id, reply } = await correct('total', '999999.99')

    expect(reply.status).toBe(200)
    const fields = Object.fromEntries(reply.json.fields.map((field: { path: string }) => [field.path, field]))
    expect(fields.total).toMatchObject({ value: '999999.99', edited: true, box: null, checks: ['total_reconciles'] })
    expect(reply.json).toMatchObject({ can_export: false, journal: null, journal_status: 'blocked_by_checks' })
    expect(reply.json.corrections).toEqual([{ path: 'total', was: '10406.00', now: '999999.99', at: '2026-10-05T09:00:00.000Z' }])
    expect((await call('GET', `/api/lb03/documents/${id}/export?format=csv`)).status).toBe(409)
    expect((await call('GET', `/api/lb03/documents/${id}/export?format=json`)).status).toBe(200)
  })

  it('puts the checks and the journal entry back when the right value is typed again, with both corrections on record', async () => {
    const { id } = await correct('total', '999999.99')

    const { json } = (await correct('total', '10406.00', id)).reply

    expect(json).toMatchObject({ can_export: true, journal_status: 'made' })
    expect(json.corrections.map((item: { now: string }) => item.now)).toEqual(['999999.99', '10406.00'])
    expect(json.checks.find((check: { id: string }) => check.id === 'total_reconciles').status).toBe('passed')
    expect(json.checks.find((check: { id: string }) => check.id === 'fields_on_page').status).toBe('passed')
  })

  it('lets a visitor settle a planted error by correcting it, and then exports', async () => {
    const planted = (await read('planted-total')).document

    const { json } = (await correct('total', '1193.85', planted.id)).reply

    expect(json).toMatchObject({ can_export: true, journal_status: 'made' })
    expect((await call('GET', `/api/lb03/documents/${planted.id}/export?format=journal`)).status).toBe(200)
  })

  it('refuses a value that does not fit the field and a field the document has, and changes nothing', async () => {
    const { id } = await correct('vendor', 'Bohemia Packaging s.r.o.')

    for (const [path, value] of [['total', 'lots'], ['issue_date', '31.02.2026'], ['line_items.99.total', '1.00'], ['nothing', '1']]) {
      const refused = (await correct(path!, value!, id)).reply
      expect(refused.status, `${path} = ${value}`).toBe(422)
      expect(refused.json.error.code).toBe('invalid_field')
    }
    expect((await call('GET', `/api/lb03/documents/${id}`)).json.corrections).toEqual([])
  })

  it('refuses a document that has not been read, and a body the schema refuses', async () => {
    const created = await upload('clean-pdf')

    expect((await correct('total', '1.00', created.json.id)).reply.status).toBe(409)
    expect((await call('POST', `/api/lb03/documents/${created.json.id}/corrections`, { body: { path: 'total' } })).status).toBe(422)
  })
})

describe('the files', () => {
  it('serve the page as a JPEG, and nothing for a page the document has not', async () => {
    const { document } = await read('clean-pdf')

    const picture = await call('GET', `/api/lb03/documents/${document.id}/pages/1`)
    const missing = await call('GET', `/api/lb03/documents/${document.id}/pages/2`)

    expect(picture.status).toBe(200)
    expect(picture.headers.get('content-type')).toBe('image/jpeg')
    expect(picture.headers.get('content-disposition')).toBe('inline; filename="page-1.jpg"')
    expect(picture.bytes.subarray(0, 3)).toEqual(Buffer.from([0xFF, 0xD8, 0xFF]))
    expect(missing.status).toBe(404)
  })

  it('export the lines and the journal entry as CSV with a byte order mark, and everything as JSON, under fixed names', async () => {
    const { document } = await read('handwritten-receipt')
    const base = `/api/lb03/documents/${document.id}/export`

    const lines = await call('GET', `${base}?format=csv`)
    const journal = await call('GET', `${base}?format=journal`)
    const everything = await call('GET', `${base}?format=json`)

    expect(lines.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(lines.headers.get('content-disposition')).toBe('attachment; filename="invoice-lines.csv"')
    expect(lines.bytes.toString('utf8').startsWith('\uFEFFvendor,invoice_number,')).toBe(true)
    expect(journal.headers.get('content-disposition')).toBe('attachment; filename="journal-entry.csv"')
    expect(journal.bytes.toString('utf8')).toContain('1010,Cash and card payments,,130.00,CZK')
    expect(everything.headers.get('content-type')).toBe('application/json')
    expect(everything.headers.get('content-disposition')).toBe('attachment; filename="invoice.json"')
    expect(everything.json.invoice.total).toBe('130.00')
    expect(everything.json.journal.lines).toHaveLength(3)
    expect(everything.json.checks.length).toBeGreaterThan(8)
  })

  it('turn a vendor that is a spreadsheet formula into text, and refuse a format that is not one of the three', async () => {
    const { document } = await read('clean-pdf')
    await call('POST', `/api/lb03/documents/${document.id}/corrections`, { body: { path: 'vendor', value: '=HYPERLINK("http://evil.example","x")' } })

    const csv = await call('GET', `/api/lb03/documents/${document.id}/export?format=csv`)

    expect(csv.bytes.toString('utf8')).toContain('"\'=HYPERLINK(""http://evil.example"",""x"")"')
    expect((await call('GET', `/api/lb03/documents/${document.id}/export?format=xlsx`)).status).toBe(422)
  })

  it('are never offered for a document that has not been read', async () => {
    const created = await upload('clean-pdf')

    expect((await call('GET', `/api/lb03/documents/${created.json.id}/export?format=json`)).status).toBe(409)
    expect((await call('GET', `/api/lb03/documents/${created.json.id}/pages/1`)).status).toBe(404)
  })

  it('delete a document that has ended, and refuse one that is still being read', async () => {
    const created = await upload('clean-pdf')

    expect((await call('DELETE', `/api/lb03/documents/${created.json.id}`)).status).toBe(409)
    await pollToEnd(created.json.id)
    const deleted = await call('DELETE', `/api/lb03/documents/${created.json.id}`)

    expect(deleted.status).toBe(204)
    expect(deleted.bytes.length).toBe(0)
    expect((await call('GET', `/api/lb03/documents/${created.json.id}`)).status).toBe(404)
  })
})

describe('the Scope', () => {
  /** Reads a run's spans from the mock's Scope route as the `web` service. */
  async function scope(runId: string): Promise<{ status: number, json: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const authorization = `Bearer ${mintServiceToken('web', web.privateKey, clock / 1000)}`
    const response = await fetch(`${mock.url}/v1/runs/${runId}/spans`, { headers: { authorization } })
    return { status: response.status, json: await response.json() }
  }

  it('shows the steps of a reading, the models\' calls under them and a root span written last, with metadata only', async () => {
    const { document } = await read('planted-total')

    const { status, json } = await scope(document.run_id)

    expect(status).toBe(200)
    const spans = json.spans as { name: string, kind: string, attrs: Record<string, unknown> }[]
    expect(spans.map(span => span.name)).toContain('read pages')
    expect(spans.filter(span => span.kind === 'gateway.call').map(span => span.name)).toEqual(['lb-guard', 'lb-fast', 'lb-fast'])
    expect(spans.at(-1)).toMatchObject({ name: 'invoice reading', kind: 'system.run', attrs: { outcome: 'ready', model_calls: 3 } })
    expect(JSON.stringify(spans)).not.toMatch(/Hanseatic|1293|RE-2026/)
  })

  it('shows a hostile page\'s run too, ended in error at the injection check', async () => {
    const { document } = await read('prompt-injection')

    const spans = (await scope(document.run_id)).json.spans as { name: string, status: string, attrs: Record<string, unknown> }[]

    expect(spans.find(span => span.name === 'injection check')).toMatchObject({ status: 'error', attrs: { flagged: true } })
    expect(spans.at(-1)?.attrs).toMatchObject({ outcome: 'failed', failure: 'injection_suspected' })
  })
})

describe('who may call', () => {
  it('needs a visitor token for LB-03: none, and one for another system, get the platform\'s 401', async () => {
    const none = await fetch(`${mock.url}/api/lb03/quota`)
    const wrong = await fetch(`${mock.url}/api/lb03/quota`, { headers: { authorization: `Bearer ${mintVisitorToken(site.privateKey, { system: 'lb-05', sessionKey: 'visitor-aaaaaaaaaaaaaaaa' }, clock / 1000)}` } })

    expect(none.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect((await call('GET', '/api/lb03/quota')).status).toBe(200)
  })
})
