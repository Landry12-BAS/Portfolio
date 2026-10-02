// Integration tests for what LB-03 asks of the proxy that no other system does: a route that takes a
// file (a multipart upload, passed on as the bytes it is after its envelope is checked and its size
// counted) and two that answer with files (a page's picture and an export). The documents describe
// both, and the proxy treats them as the documented exceptions to "JSON in, JSON out" and as nothing
// more: the media types of an answer are those the document lists for that route, the name a file is
// offered under is a plain one or none, and a request that is not the form it says it is never gets
// to the back end.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { startMockBackend } from '@lb/api-clients/testing'
import type { MockBackend } from '@lb/api-clients/testing'
import { loadPublicKey, verifyVisitorToken } from '@lb/common/visitors'

import { LB03_SITE_FILE_BYTES, LB03_SITE_UPLOAD_BYTES } from '../../shared/lb03-limits.ts'
import { Browser } from '../support/browser.ts'
import { samplePicture, seedUpload } from '../support/lb03-files.ts'
import { rawRequest } from '../support/raw.ts'
import { makeTestKeys, startTestSite } from '../support/site-app.ts'
import type { TestSite } from '../support/site-app.ts'

const keys = makeTestKeys()
const clock = { now: Date.UTC(2026, 9, 5, 9, 0, 0) }
const UPLOAD = '/api/lb03/documents'
const DOCUMENT = '/api/lb03/documents/abc12345'
let mock: MockBackend
let site: TestSite

beforeAll(async () => {
  mock = await startMockBackend({ siteKey: keys.sitePublic, webKey: keys.webPublic, now: () => clock.now })
  site = await startTestSite({ keys, backendUrl: mock.url, clock })
})

afterAll(async () => {
  await site.close()
  await mock.close()
})

beforeEach(() => {
  mock.reset()
  site.clock.now = Date.UTC(2026, 9, 5, 9, 0, 0)
})

/** A browser that has passed the Turnstile check. */
async function verified(): Promise<Browser> {
  const browser = new Browser(site)
  expect((await browser.verify()).status).toBe(200)
  return browser
}

/** A multipart body written by hand: one file part holding `content`, between the boundary lines, closed or left open. */
function form(boundary: string, content: string, closed = true): string {
  const part = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="invoice.pdf"\r\nContent-Type: application/pdf\r\n\r\n${content}\r\n`
  return closed ? `${part}--${boundary}--\r\n` : part
}

/** Reads the boundary out of a multipart Content-Type. */
function boundaryOf(contentType: string | undefined): string {
  return /boundary=([^;]+)$/.exec(contentType ?? '')?.[1] ?? ''
}

/** The bytes of the JPEG the mock draws for the clean sample's page, which a page answer must carry unchanged. */
const PAGE_PICTURE = samplePicture('clean-pdf')

/** Tells whether two byte arrays hold the same bytes. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b))
}

describe('an upload, which is LB-03\'s one route that takes a file', () => {
  it('is passed on as the bytes it is, in the visitor\'s own form, with the length it has and a token for LB-03 alone', async () => {
    const browser = await verified()
    const file = seedUpload('clean-pdf')

    const reply = await browser.request('POST', UPLOAD, { upload: file })

    expect(reply.status).toBe(202)
    expect(reply.json.state).toBe('uploaded')
    const sent = mock.requests.at(-1)!
    expect([sent.method, sent.path]).toEqual(['POST', UPLOAD])
    expect(sent.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    const boundary = boundaryOf(sent.headers['content-type'])
    const received = Buffer.from(sent.body, 'latin1')
    expect(received.subarray(0, boundary.length + 2).toString('latin1')).toBe(`--${boundary}`)
    expect(received.includes(Buffer.from(file.bytes))).toBe(true)
    expect(sent.headers['content-length']).toBe(String(received.length))
    const token = (sent.headers.authorization ?? '').replace('Bearer ', '')
    const visitor = verifyVisitorToken(token, 'lb-03', loadPublicKey(keys.sitePublic), () => site.clock.now / 1_000)
    expect(visitor.system).toBe('lb-03')
    expect(() => verifyVisitorToken(token, 'lb-01', loadPublicKey(keys.sitePublic), () => site.clock.now / 1_000)).toThrow()
  })

  it('carries nothing else of the browser\'s request: no cookie, no origin, no address, and the site\'s own accept header', async () => {
    const browser = await verified()

    await browser.request('POST', UPLOAD, { upload: seedUpload('clean-pdf'), headers: { 'x-forwarded-for': '203.0.113.9', 'referer': 'https://site.example/secret', 'x-custom': 'hello' } })

    const names = Object.keys(mock.requests.at(-1)?.headers ?? {})
    for (const forbidden of ['cookie', 'origin', 'referer', 'x-forwarded-for', 'x-custom', 'sec-fetch-site']) expect(names, forbidden).not.toContain(forbidden)
    expect(JSON.stringify(mock.requests)).not.toContain('203.0.113.9')
    expect(mock.requests.at(-1)?.headers.accept).toBe('application/json')
  })

  it('takes a file of the size the site names, and refuses one that makes the form bigger than that, before the back end hears of it', async () => {
    const browser = await verified()
    // A file that opens as a PDF does, so the back end takes it as one; what follows is filler.
    const noise = (size: number): Uint8Array => {
      const bytes = new Uint8Array(size).fill(0x41)
      bytes.set(new TextEncoder().encode('%PDF-1.7\n'))
      return bytes
    }

    const atTheLimit = await browser.request('POST', UPLOAD, { upload: { filename: 'big.pdf', bytes: noise(LB03_SITE_FILE_BYTES), type: 'application/pdf' } })
    const accepted = mock.requests.length
    const overTheLimit = await browser.request('POST', UPLOAD, { upload: { filename: 'bigger.pdf', bytes: noise(LB03_SITE_UPLOAD_BYTES), type: 'application/pdf' } })

    expect(atTheLimit.status).toBe(202)
    expect(accepted).toBe(1)
    expect(overTheLimit.status).toBe(413)
    expect(overTheLimit.json.error.code).toBe('payload_too_large')
    expect(overTheLimit.headers.get('connection')).toBe('close')
    expect(mock.requests).toHaveLength(accepted)
  })

  it('is refused at once when its declared length is over the limit, and counted as it arrives when it declares none', async () => {
    const browser = await verified()
    const headers = { 'content-type': 'multipart/form-data; boundary=zz', 'origin': site.origin, 'cookie': `__Host-lb_session=${browser.session}` }

    const declared = await rawRequest(site.url, UPLOAD, { method: 'POST', headers: { ...headers, 'content-length': String(LB03_SITE_UPLOAD_BYTES + 1) }, chunks: ['--zz'] })
      .catch(() => ({ status: 413, text: '', headers: {} }))
    const chunk = 'x'.repeat(64 * 1_024)
    const counted = await rawRequest(site.url, UPLOAD, { method: 'POST', headers, chunks: Array.from({ length: Math.ceil(LB03_SITE_UPLOAD_BYTES / chunk.length) + 1 }, () => chunk) })
      .catch(() => ({ status: 413, text: '', headers: {} }))

    expect(declared.status).toBe(413)
    expect(counted.status).toBe(413)
    expect(mock.requests).toEqual([])
  })

  it('is a form or it is refused: another content type, no boundary, a quoted or a too long one, and a body that is not the form it names', async () => {
    const browser = await verified()
    const wrongTypes = [
      'application/json', 'application/octet-stream', 'text/plain', 'multipart/mixed; boundary=abc', 'multipart/form-data', 'multipart/form-data; boundary=',
      'multipart/form-data; boundary="quoted"', `multipart/form-data; boundary=${'b'.repeat(71)}`, 'multipart/form-data; boundary=ab cd', 'multipart/form-data; boundary=ab;cd',
    ]
    const notForms: [string, string][] = [
      ['a body that does not open with its boundary', 'hello\r\n--zz--\r\n'],
      ['a form that is never closed', form('zz', '%PDF-1.7', false)],
      ['a form whose closing line is another boundary\'s', form('zz', '%PDF-1.7').replace('--zz--', '--yy--')],
    ]

    for (const type of wrongTypes) {
      const reply = await browser.request('POST', UPLOAD, { raw: { text: form('abc', '%PDF-1.7'), type } })
      expect(reply.status, type).toBe(415)
      expect(reply.json.error.code, type).toBe('unsupported_media_type')
    }
    for (const [name, text] of notForms) {
      const reply = await browser.request('POST', UPLOAD, { raw: { text, type: 'multipart/form-data; boundary=zz' } })
      expect(reply.status, name).toBe(400)
      expect(reply.json.error.code, name).toBe('invalid_request')
    }
    expect((await browser.request('POST', UPLOAD, { raw: { text: '', type: 'multipart/form-data; boundary=zz' } })).status).toBe(400)
    expect(mock.requests).toEqual([])
  })

  it('is not passed on by a visitor who has not passed the check, or who writes from another site', async () => {
    const stranger = new Browser(site)
    const browser = await verified()

    const unverified = await stranger.request('POST', UPLOAD, { upload: seedUpload('clean-pdf') })
    const foreign = await browser.request('POST', UPLOAD, { upload: seedUpload('clean-pdf'), origin: 'https://evil.example' })

    expect(unverified.status).toBe(403)
    expect(unverified.json.error.code).toBe('verification_required')
    expect(foreign.status).toBe(403)
    expect(foreign.json.error.code).toBe('forbidden_origin')
    expect(mock.requests).toEqual([])
  })

  it('takes no upload on any other route: a form sent to a route that takes JSON is refused as the wrong media type', async () => {
    const browser = await verified()

    const reply = await browser.request('POST', `${DOCUMENT}/corrections`, { upload: seedUpload('clean-pdf') })

    expect(reply.status).toBe(415)
    expect(reply.json.error.code).toBe('unsupported_media_type')
    expect(mock.requests).toEqual([])
  })

  it('passes on what the back end says of a file it will not take: 413, 415 and the limit of the day, in the platform\'s shape', async () => {
    const browser = await verified()
    mock.script({ status: 415, json: { error: { code: 'unsupported_file', message: 'Send a PDF, a PNG, a JPEG or a WebP.' } } })
    mock.script({ status: 413, json: { error: { code: 'too_large', message: 'The file is larger than 10 MB.' } } })
    mock.script({ status: 429, headers: { 'retry-after': '3600' }, json: { error: { code: 'daily_limit', message: 'Ten documents a day.', resets_at: '2026-10-06T00:00:00+00:00' } } })

    const replies = [await browser.request('POST', UPLOAD, { upload: seedUpload('clean-pdf') }), await browser.request('POST', UPLOAD, { upload: seedUpload('clean-pdf') }), await browser.request('POST', UPLOAD, { upload: seedUpload('clean-pdf') })]

    expect(replies.map(reply => reply.status)).toEqual([415, 413, 429])
    expect(replies.map(reply => reply.json.error.code)).toEqual(['unsupported_file', 'too_large', 'daily_limit'])
    expect(replies[2]?.json.error.resets_at).toBe('2026-10-06T00:00:00+00:00')
    expect(replies[2]?.headers.get('retry-after')).toBe('3600')
  })
})

describe('what comes back as a file', () => {
  it('is a page\'s picture exactly as the back end drew it, kept from sniffing and from every cache, under the name it was offered with', async () => {
    const browser = await verified()
    const id = (await browser.request('POST', UPLOAD, { upload: seedUpload('clean-pdf') })).json.id as string
    for (let poll = 0; poll < 6; poll += 1) await browser.request('GET', `${UPLOAD}/${id}`)

    const page = await browser.request('GET', `${UPLOAD}/${id}/pages/1`)

    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('image/jpeg')
    expect(page.headers.get('content-disposition')).toBe('inline; filename="page-1.jpg"')
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    expect(page.headers.get('cache-control')).toBe('no-store')
    expect(sameBytes(page.bytes, PAGE_PICTURE)).toBe(true)
    for (const leaked of ['server', 'x-powered-by', 'access-control-allow-origin', 'x-internal-host', 'via', 'set-cookie']) expect(page.headers.get(leaked), leaked).toBeNull()
    expect(mock.requests.at(-1)?.headers.accept).toBe('application/json, image/jpeg')
  })

  it('is an export as a CSV with its byte order mark and its name, or as the JSON of the reading, which keeps its name too', async () => {
    const browser = await verified()
    const id = (await browser.request('POST', UPLOAD, { upload: seedUpload('clean-pdf') })).json.id as string
    for (let poll = 0; poll < 6; poll += 1) await browser.request('GET', `${UPLOAD}/${id}`)

    const lines = await browser.request('GET', `${UPLOAD}/${id}/export?format=csv`)
    const journal = await browser.request('GET', `${UPLOAD}/${id}/export?format=journal`)
    const json = await browser.request('GET', `${UPLOAD}/${id}/export`)

    expect(lines.status).toBe(200)
    expect(lines.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(lines.headers.get('content-disposition')).toBe('attachment; filename="invoice-lines.csv"')
    expect(Array.from(lines.bytes.subarray(0, 3))).toEqual([0xEF, 0xBB, 0xBF])
    expect(lines.text).toContain('invoice_number')
    expect(journal.headers.get('content-disposition')).toBe('attachment; filename="journal-entry.csv"')
    expect(json.status).toBe(200)
    expect(json.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(json.headers.get('content-disposition')).toBe('attachment; filename="invoice.json"')
    expect(Object.keys(json.json)).toEqual(['checks', 'corrections', 'document', 'duplicate_of', 'invoice', 'journal'])
  })

  it('is an error in the platform\'s shape when the back end refuses: the export of a document that fails a check, a page that is not there', async () => {
    const browser = await verified()
    const id = (await browser.request('POST', UPLOAD, { upload: seedUpload('clean-pdf') })).json.id as string
    for (let poll = 0; poll < 6; poll += 1) await browser.request('GET', `${UPLOAD}/${id}`)
    await browser.request('POST', `${UPLOAD}/${id}/corrections`, { body: { path: 'total', value: '999999.99' } })

    const refused = await browser.request('GET', `${UPLOAD}/${id}/export?format=csv`)
    const missing = await browser.request('GET', `${UPLOAD}/${id}/pages/9`)

    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('checks_failed')
    expect(missing.status).toBe(404)
    expect(missing.json.error.code).toBe('not_found')
    expect(missing.headers.get('content-type')).toBe('application/json; charset=utf-8')
  })

  it('is only what the document lists for the route: a page is a JPEG and an export is CSV or JSON, whatever else a back end says it is sending', async () => {
    const browser = await verified()
    const wrong: [string, string, Record<string, string>][] = [
      ['a PNG for a page', `${DOCUMENT}/pages/1`, { 'content-type': 'image/png' }],
      ['HTML for a page', `${DOCUMENT}/pages/1`, { 'content-type': 'text/html' }],
      ['a stream of bytes for a page', `${DOCUMENT}/pages/1`, { 'content-type': 'application/octet-stream' }],
      ['a page with no type', `${DOCUMENT}/pages/1`, { 'content-type': '' }],
      ['a JPEG for an export', `${DOCUMENT}/export?format=csv`, { 'content-type': 'image/jpeg' }],
      ['a CSV for a page', `${DOCUMENT}/pages/1`, { 'content-type': 'text/csv' }],
      ['a JPEG for a route that answers JSON only', '/api/lb03/quota', { 'content-type': 'image/jpeg' }],
      ['a CSV for a route that answers JSON only', '/api/lb03/documents', { 'content-type': 'text/csv' }],
    ]

    for (const [name, path, headers] of wrong) {
      mock.script({ binary: PAGE_PICTURE, headers })
      const reply = await browser.request('GET', path)
      expect(reply.status, name).toBe(502)
      expect(reply.json.error.code, name).toBe('upstream_failed')
      expect(reply.headers.get('content-type'), name).toBe('application/json; charset=utf-8')
    }
  })

  it('is a file only as an answer of 200: a picture under any other status is a failure, and an error that is not JSON is a generic one', async () => {
    const browser = await verified()
    mock.script({ status: 202, binary: PAGE_PICTURE, headers: { 'content-type': 'image/jpeg' } })
    mock.script({ status: 404, binary: PAGE_PICTURE, headers: { 'content-type': 'image/jpeg' } })

    const accepted = await browser.request('GET', `${DOCUMENT}/pages/1`)
    const missing = await browser.request('GET', `${DOCUMENT}/pages/1`)

    expect(accepted.status).toBe(502)
    expect(missing.status).toBe(502)
    expect(missing.json.error.code).toBe('upstream_failed')
  })

  it('is offered under a plain name or under none: a name that could climb out of its folder, carry another parameter or run long is dropped', async () => {
    const browser = await verified()
    const unsafe = [
      'attachment; filename="../../etc/passwd"', 'attachment; filename="a b.csv"', 'attachment; filename=plain.csv', 'attachment; filename="x.csv"; filename*=UTF-8\'\'evil.exe',
      `attachment; filename="${'a'.repeat(65)}"`, 'attachment; filename="x.csv"; evil=1', 'form-data; name="x"', 'attachment; filename="x\\y.csv"', 'attachment; filename="é.csv"', 'attachment',
    ]

    for (const disposition of unsafe) {
      mock.script({ binary: Buffer.from('a,b\r\n'), headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': disposition } })
      const reply = await browser.request('GET', `${DOCUMENT}/export?format=csv`)
      expect(reply.status, disposition).toBe(200)
      expect(reply.headers.get('content-disposition'), disposition).toBeNull()
    }
    mock.script({ binary: Buffer.from('a,b\r\n'), headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="plain-name_1.csv"' } })
    const kept = await browser.request('GET', `${DOCUMENT}/export?format=csv`)
    expect(kept.headers.get('content-disposition')).toBe('attachment; filename="plain-name_1.csv"')
    expect(kept.headers.get('content-type')).toBe('text/csv; charset=utf-8')
  })

  it('passes a name only for a route that answers files: a JSON route\'s own Content-Disposition is not passed on', async () => {
    const browser = await verified()
    mock.script({ json: { documents: [] }, headers: { 'content-disposition': 'attachment; filename="documents.json"' } })

    const reply = await browser.request('GET', UPLOAD)

    expect(reply.status).toBe(200)
    expect(reply.headers.get('content-disposition')).toBeNull()
  })

  it('is cut off when it is bigger than the system\'s limit, and a file that stops short is a failure too', async () => {
    const browser = await verified()
    mock.script({ binary: Buffer.alloc(2 * 1_048_576 + 1), headers: { 'content-type': 'image/jpeg' } })
    mock.script({ binary: Buffer.alloc(2 * 1_048_576), headers: { 'content-type': 'image/jpeg' } })

    const tooBig = await browser.request('GET', `${DOCUMENT}/pages/1`)
    const justRight = await browser.request('GET', `${DOCUMENT}/pages/1`)

    expect(tooBig.status).toBe(502)
    expect(justRight.status).toBe(200)
    expect(justRight.bytes.length).toBe(2 * 1_048_576)
  })
})

describe('LB-03 through the proxy, start to finish', () => {
  it('reads a document, corrects it, and exports and deletes it, as the board does', async () => {
    const browser = await verified()

    const uploaded = await browser.request('POST', UPLOAD, { upload: seedUpload('clean-pdf') })
    const id = uploaded.json.id as string
    const states: string[] = [uploaded.json.state as string]
    let document = uploaded.json
    for (let poll = 0; poll < 8 && document.state !== 'ready'; poll += 1) {
      document = (await browser.request('GET', `${UPLOAD}/${id}`)).json
      states.push(document.state as string)
    }
    const quota = await browser.request('GET', '/api/lb03/quota')
    const listed = await browser.request('GET', UPLOAD)
    const corrected = await browser.request('POST', `${UPLOAD}/${id}/corrections`, { body: { path: 'total', value: '999999.99' } })
    const refused = await browser.request('POST', `${UPLOAD}/${id}/corrections`, { body: { path: 'total', value: 'lots' } })
    const deleted = await browser.request('DELETE', `${UPLOAD}/${id}`)
    const gone = await browser.request('GET', `${UPLOAD}/${id}`)

    expect(uploaded.status).toBe(202)
    expect(states).toEqual(['uploaded', 'ocr', 'extract', 'validate', 'ready'])
    expect(document.fields.length).toBeGreaterThan(5)
    expect(quota.json).toMatchObject({ used: 1, remaining: 9, active: 0 })
    expect(listed.json.documents).toHaveLength(1)
    expect(corrected.status).toBe(200)
    expect(corrected.json.checks.find((check: { id: string }) => check.id === 'total_reconciles').status).toBe('failed')
    expect(corrected.json.corrections).toHaveLength(1)
    expect(refused.status).toBe(422)
    expect(refused.json.error.code).toBe('invalid_field')
    expect(deleted.status).toBe(204)
    expect(gone.status).toBe(404)
    // The mock checks each of its own answers against the document, so what the proxy passed on is what the document describes.
    expect(mock.violations).toEqual([])
  })

  it('shows a visitor only their own documents and their pictures, however the ID is guessed', async () => {
    const owner = await verified()
    const stranger = await verified()
    const id = (await owner.request('POST', UPLOAD, { upload: seedUpload('clean-pdf') })).json.id as string
    for (let poll = 0; poll < 6; poll += 1) await owner.request('GET', `${UPLOAD}/${id}`)

    expect((await stranger.request('GET', `${UPLOAD}/${id}`)).status).toBe(404)
    expect((await stranger.request('GET', `${UPLOAD}/${id}/pages/1`)).status).toBe(404)
    expect((await stranger.request('GET', `${UPLOAD}/${id}/export?format=csv`)).status).toBe(404)
    expect((await stranger.request('DELETE', `${UPLOAD}/${id}`)).status).toBe(404)
    expect((await stranger.request('GET', UPLOAD)).json.documents).toEqual([])
    expect((await owner.request('GET', `${UPLOAD}/${id}/pages/1`)).status).toBe(200)
  })

  it('counts the visitor\'s ten documents a day in the back end, whatever the cookie does', async () => {
    const browser = await verified()
    for (let count = 0; count < 10; count += 1) {
      const reply = await browser.request('POST', UPLOAD, { upload: seedUpload('clean-pdf') })
      expect(reply.status, `upload ${count + 1}`).toBe(202)
      // Two documents are read at a time: end each one so the daily limit is the one that stops the eleventh.
      for (let poll = 0; poll < 6; poll += 1) await browser.request('GET', `${UPLOAD}/${reply.json.id as string}`)
    }

    const refused = await browser.request('POST', UPLOAD, { upload: seedUpload('clean-pdf') })

    expect(refused.status).toBe(429)
    expect(refused.json.error.code).toBe('daily_limit')
    expect(refused.json.error.resets_at).toBe('2026-10-06T00:00:00+00:00')
  })
})
