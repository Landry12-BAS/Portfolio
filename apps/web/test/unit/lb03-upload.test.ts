// Tests of getting a document ready to send and of the addresses the board puts in a page: the quick
// checks on a file the visitor chose (not empty, not over what the site passes on, a kind the reader
// knows, and never an SVG), a sample's file read from the site's static files and held to the size the
// golden set says it has, the addresses of pictures and downloads (built only from plain names), and the
// words a refusal of the API gets.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LB03_SAMPLES } from '#shared/data/samples/lb03'
import { LB03_SITE_FILE_BYTES } from '#shared/lb03-limits'

import { ApiProblem } from '~/board-kit/problem'
import { correctionRefusal, uploadRefusal } from '~/boards/lb-03/refusals'
import { checkChosenFile, formatSize, loadSampleFile } from '~/boards/lb-03/upload'
import { EXPORT_FILE_NAMES, exportUrl, pageUrl, sampleFileUrl, samplePageUrl } from '~/boards/lb-03/urls'

import { seedUpload } from '../support/lb03-files'

describe('the quick checks on a chosen file', () => {
  it('say a file is empty, over what the site passes on, or not a kind the reader knows', () => {
    expect(checkChosenFile({ name: 'a.pdf', size: 0, type: 'application/pdf' })).toBe('empty')
    expect(checkChosenFile({ name: 'a.pdf', size: LB03_SITE_FILE_BYTES + 1, type: 'application/pdf' })).toBe('too_large')
    expect(checkChosenFile({ name: 'notes.txt', size: 10, type: 'text/plain' })).toBe('unsupported')
  })

  it('let through a file of exactly the limit, and each of the four kinds by its name or by its type', () => {
    expect(checkChosenFile({ name: 'a.pdf', size: LB03_SITE_FILE_BYTES, type: 'application/pdf' })).toBeUndefined()
    for (const name of ['a.pdf', 'a.PNG', 'a.jpg', 'a.jpeg', 'a.webp']) expect(checkChosenFile({ name, size: 10, type: '' }), name).toBeUndefined()
    for (const type of ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']) expect(checkChosenFile({ name: 'scan', size: 10, type }), type).toBeUndefined()
  })

  it('never let an SVG through, whatever it is called or says it is: it can carry script and references', () => {
    expect(checkChosenFile({ name: 'logo.svg', size: 10, type: 'image/svg+xml' })).toBe('unsupported')
    expect(checkChosenFile({ name: 'a.html', size: 10, type: 'text/html' })).toBe('unsupported')
    expect(checkChosenFile({ name: 'a.zip', size: 10, type: 'application/zip' })).toBe('unsupported')
  })

  it('write a size in kilobytes or megabytes in the visitor\'s language, with a space that does not break', () => {
    expect(formatSize(1_536, 'en')).toBe('1.5 kB')
    expect(formatSize(2_621_440, 'en')).toBe('2.5 MB')
    expect(formatSize(2_621_440, 'cs')).toBe('2,5 MB')
  })
})

describe('a sample\'s file', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Stands the site's static files in with the seed's own, answering 404 for a path that is not one of the sample files. */
  function staticFiles(replace: (name: string, bytes: Uint8Array) => Uint8Array = (_, bytes) => bytes): typeof fetch {
    return vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      const sample = LB03_SAMPLES.find(candidate => path === sampleFileUrl(candidate.file))
      if (sample === undefined) return new Response('no', { status: 404 })
      return new Response(new Uint8Array(replace(sample.file, seedUpload(sample.id).bytes)), { status: 200, headers: { 'content-type': sample.mime } })
    }) as unknown as typeof fetch
  }

  it('is read as a file of its own name and type, of the size the golden set says it has', async () => {
    vi.stubGlobal('fetch', staticFiles())
    for (const sample of LB03_SAMPLES) {
      const file = await loadSampleFile(sample)
      expect(file.name).toBe(sample.file)
      expect(file.type).toBe(sample.mime)
      expect(file.size).toBe(sample.bytes)
      expect(checkChosenFile(file)).toBeUndefined()
    }
  })

  it('is refused when what the site serves is not the file the golden set describes', async () => {
    vi.stubGlobal('fetch', staticFiles((_, bytes) => bytes.slice(0, bytes.length - 1)))
    const rejected = await loadSampleFile(LB03_SAMPLES[0]).catch((error: unknown) => error)
    expect(rejected).toBeInstanceOf(ApiProblem)
    expect((rejected as ApiProblem).code).toBe('bad_answer')
  })

  it('is refused when the site does not have it, as a problem the board can show', async () => {
    vi.stubGlobal('fetch', staticFiles())
    const rejected = await loadSampleFile({ file: 'missing.pdf', mime: 'application/pdf', bytes: 10 }).catch((error: unknown) => error)
    expect(rejected).toBeInstanceOf(ApiProblem)
    expect((rejected as ApiProblem).kind).toBe('notFound')
  })

  it('is refused as a network problem when the site cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('offline')
    }))
    const rejected = await loadSampleFile(LB03_SAMPLES[0]).catch((error: unknown) => error)
    expect((rejected as ApiProblem).kind).toBe('network')
  })
})

describe('the addresses the board puts in a page', () => {
  it('are built from a document\'s id, a page number and a format, and from nothing else', () => {
    expect(pageUrl('Ab-1_2345', 2)).toBe('/api/lb03/documents/Ab-1_2345/pages/2')
    expect(exportUrl('Ab-1_2345', 'journal')).toBe('/api/lb03/documents/Ab-1_2345/export?format=journal')
    expect(samplePageUrl('clean-pdf', 1)).toBe('/lb03/pages/clean-pdf-1.jpg')
    expect(sampleFileUrl('bohemia-packaging-2026-0412.pdf')).toBe('/lb03/samples/bohemia-packaging-2026-0412.pdf')
    expect(EXPORT_FILE_NAMES).toEqual({ csv: 'invoice-lines.csv', journal: 'journal-entry.csv', json: 'invoice.json' })
  })

  it('refuse a name that could point somewhere else: a path, a query, dots, a space, nothing', () => {
    for (const bad of ['../x', 'a/b', 'a?b=1', 'a b', '', '..', 'a#b', 'a\\b', 'x'.repeat(65)]) {
      expect(() => pageUrl(bad, 1), bad).toThrow()
      expect(() => exportUrl(bad, 'csv'), bad).toThrow()
      expect(() => samplePageUrl(bad, 1), bad).toThrow()
    }
    for (const bad of ['..', '.hidden', '../a.pdf', 'a/b.pdf', '', 'a b.pdf']) expect(() => sampleFileUrl(bad), bad).toThrow()
  })

  it('truncate a page number to a whole number', () => {
    expect(pageUrl('abcdefgh', 2.9)).toBe('/api/lb03/documents/abcdefgh/pages/2')
  })
})

describe('the words a refusal gets', () => {
  it('name the refusals of an upload the kit\'s notices would get wrong: too big, not a file it takes, two being read, every reader busy', () => {
    expect(uploadRefusal(new ApiProblem(413, 'too_large', 'x'))).toBe('too_large')
    expect(uploadRefusal(new ApiProblem(413, 'payload_too_large', 'x'))).toBe('too_large')
    expect(uploadRefusal(new ApiProblem(415, 'unsupported_file', 'x'))).toBe('unsupported')
    expect(uploadRefusal(new ApiProblem(415, 'unsupported_media_type', 'x'))).toBe('unsupported')
    expect(uploadRefusal(new ApiProblem(429, 'document_running', 'x'))).toBe('running')
    expect(uploadRefusal(new ApiProblem(503, 'readers_busy', 'x'))).toBe('busy')
  })

  it('leave the day\'s limit and a service that is off to the kit, whose notices say them right', () => {
    expect(uploadRefusal(new ApiProblem(429, 'daily_limit', 'x'))).toBeUndefined()
    expect(uploadRefusal(new ApiProblem(503, 'unavailable', 'x'))).toBeUndefined()
    expect(uploadRefusal(new ApiProblem(0, 'network', 'x'))).toBeUndefined()
  })

  it('name every refusal of a correction', () => {
    expect(correctionRefusal(new ApiProblem(422, 'invalid_field', 'x'))).toBe('invalid')
    expect(correctionRefusal(new ApiProblem(404, 'not_found', 'x'))).toBe('gone')
    expect(correctionRefusal(new ApiProblem(409, 'too_many_corrections', 'x'))).toBe('too_many')
    expect(correctionRefusal(new ApiProblem(409, 'edit_conflict', 'x'))).toBe('conflict')
    expect(correctionRefusal(new ApiProblem(409, 'not_ready', 'x'))).toBe('not_ready')
    expect(correctionRefusal(new ApiProblem(503, 'unavailable', 'x'))).toBeUndefined()
  })
})
