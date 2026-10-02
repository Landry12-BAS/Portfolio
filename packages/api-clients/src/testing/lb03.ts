// LB-03 as the mock back end plays it: a visitor uploads an invoice, a credit note or a till receipt, the
// reader works through it as the document is polled (uploaded, ocr, extract, validate, perhaps repair,
// ready), and the reading has the fields, boxes, checks, duplicate verdict and journal entry the real service
// makes. A file is recognised by its hash against the seed's manifest, so the six samples and every other
// document of the golden set read as the golden set says (the planted errors fail their one check, the
// hostile page is stopped, the six-page file is refused) and are lit up where the generator drew each field.
// Any other file is read as the clean sample, because the mock cannot read: it says so by being a mock, and a
// recording made on it says `mock`. A correction runs the checks again with the engine of lb03-engine.ts, the
// exports are the real CSV and JSON shapes, and the page picture is the sample's (the real service draws
// its own from the file). The ten documents a day, the two being read at once, the hour a document lives and
// the 404 for another visitor's document are the real service's rules. Nothing here measures anything: the
// timings and the confidences are made up, and the spans are fixtures.
import { createHash, randomBytes } from 'node:crypto'

import type { Answer } from './lb01.ts'
import { errorAnswer } from './lb01.ts'
import {
  amountText, blocksExport, checkFieldsOnPage, duplicateResult, expectedPaths, fieldPaths, findDuplicate, getField, identityOf,
  invoiceJson, journalCsv, journalTotals, linesCsv, post, runChecks, setField,
} from './lb03-engine.ts'
import type { CheckResult, Chart, Identity, Invoice, Journal, Known } from './lb03-engine.ts'
import type { Lb03Case, Lb03Seed } from './lb03-seed.ts'
import { lb03Spans } from './lb03-spans.ts'
import type { Lb03Flow } from './lb03-spans.ts'
import type { MockSpan } from './spans.ts'

// The limits of the real service (services/flask-systems/lb03/limits.py).
export const DOCUMENTS_PER_DAY = 10
export const ACTIVE_PER_VISITOR = 2
export const FILE_LIFETIME_MS = 3_600_000
export const MAX_UPLOAD_BYTES = 10 * 1_048_576
export const MAX_PAGES = 5
export const MAX_CORRECTIONS = 100
const DAY_MS = 86_400_000
const MAX_LABEL_CHARS = 80

/** A file the visitor sent: the name it came with, and its bytes. */
export interface Lb03Upload {
  filename: string
  data: Buffer
}

/** An answer that is a file in place of JSON: its bytes, its Content-Type and the headers that go with it. */
export interface Lb03FileAnswer extends Answer {
  file: { bytes: Buffer, contentType: string, headers: Record<string, string> }
}

/** What the mock's LB-03 may be set up with. */
export interface Lb03MockOptions {
  // How many polls of a new document still answer `uploaded`, as when other documents are read first.
  holdPolls?: number
  // How many documents are waiting ahead of a document that is still `uploaded`.
  queuedAhead?: number
}

/** Where a document is in its run: waiting, one of the stages, or at its end. */
type DocumentState = 'uploaded' | 'ocr' | 'extract' | 'validate' | 'repair' | 'ready' | 'failed'

/** What the file's first bytes say it is. */
type FileKind = 'pdf' | 'png' | 'jpeg' | 'webp'

/** A step of a document's run, as the API shows it. */
interface Step {
  name: string
  status: 'ok' | 'error' | 'skipped'
  ms: number
  detail: Record<string, string | number | boolean>
}

/** Where a field is printed, as the API shows it. */
interface Placement {
  page: number
  quad: number[]
  confidence: number
  match: number
}

/** A correction a visitor made. */
interface Correction {
  path: string
  was: string | null
  now: string | null
  at: string
}

/** How a document's reading ends. */
type Ending = { kind: 'ready', repair: boolean } | { kind: 'failed', code: string, at: 'ocr' | 'extract' }

/** One document of one visitor, with everything the mock made of it when it was uploaded. */
interface MockDocument {
  id: string
  session: string
  label: string
  kind: FileKind
  byteSize: number
  createdAt: number
  source: Lb03Case
  fileSha256: string
  ending: Ending
  sequence: DocumentState[]
  // How many polls moved it on, and how many were answered `uploaded` while it waited for a reader.
  polls: number
  held: number
  steps: Step[]
  runId: string
  invoice: Invoice | undefined
  placements: Map<string, Placement>
  checks: CheckResult[]
  journal: Journal | undefined
  duplicate: { of: string, source: 'document' | 'sample', sameContent: boolean } | undefined
  identity: Identity | undefined
  corrections: Correction[]
  modelCalls: number
}

// What each failure code says, for someone reading the API: the real service's own sentences.
const FAILURE_MESSAGES: Record<string, string> = {
  unsupported_file: 'The file is not a PDF, PNG, JPEG or WebP.',
  too_large: 'The file is larger than 10 MB.',
  too_many_pages: 'The file has more than 5 pages.',
  image_too_big: 'The image or a page of it has more pixels than the reader accepts.',
  unreadable_file: 'The file could not be decoded.',
  unsafe_file: 'The file carries active content or reaches outside itself, which the reader refuses.',
  no_text: 'No words could be read from the pages.',
  ocr_failed: 'The reader stopped before it finished.',
  injection_suspected: 'The injection check flagged the text, so no model was shown it.',
  unchecked: 'The injection check could not run, so no model was shown the text.',
  model_failed: 'The language models are not answering right now.',
  model_budget: 'Today\'s free model capacity is used up.',
  model_output: 'The model\'s reply could not be read.',
  time_limit: 'The document took longer than the time it is given.',
  call_limit: 'The document needed more model calls than it is given.',
  interrupted: 'The process that was reading the document stopped before it finished.',
}

// The checks a model may be sent back to repair: the ones about reading the document again.
const REPAIRABLE = new Set(['required_fields', 'dates_valid', 'currency_known', 'signs_agree', 'line_math', 'line_items_sum', 'vat_math', 'vat_bases', 'total_reconciles'])

const NOT_FOUND = 'There is no such document. Documents are deleted an hour after they are uploaded.'

/** Tells what a file is by its first bytes, and nothing else. */
function sniff(data: Buffer): FileKind | undefined {
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png'
  if (data.subarray(0, 3).equals(Buffer.from([0xFF, 0xD8, 0xFF]))) return 'jpeg'
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return undefined
}

/** Makes a file name safe to show back: no folders, no odd characters, and a limit to its length. */
function cleanLabel(filename: string): string {
  const name = filename.replaceAll('\\', '/').split('/').pop() ?? ''
  const shown = name.replace(/[^\w .,()+&'-]+/gu, ' ').split(/\s+/).filter(Boolean).join(' ').slice(0, MAX_LABEL_CHARS)
  return shown === '' ? 'document' : shown
}

/** Writes a day from a moment, in UTC. */
function dayOf(moment: number): string {
  return new Date(moment).toISOString().slice(0, 10)
}

/** Makes a number from 0 up to but not including 1 that is the same for the same text. */
function unit(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0) / 2 ** 32
}

/** Writes a confidence in a word: high from 0.9, medium from 0.75, low below. */
function bandOf(confidence: number): 'high' | 'medium' | 'low' {
  return confidence >= 0.9 ? 'high' : confidence >= 0.75 ? 'medium' : 'low'
}

/** Says what kind of value a field holds, so the board can offer the right way to correct it. */
function kindOf(path: string): string {
  const kinds: Record<string, string> = {
    document_type: 'choice', vendor: 'text', invoice_number: 'text', description: 'text', issue_date: 'date', due_date: 'date', currency: 'currency', quantity: 'quantity', rate: 'rate',
  }
  return kinds[path.split('.').pop() ?? ''] ?? 'amount'
}

/** Writes a JSON document the way the service's export does: keys sorted, two spaces of indent. */
function stableJson(value: unknown, indent = ''): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[\n${value.map(item => `${indent}  ${stableJson(item, `${indent}  `)}`).join(',\n')}\n${indent}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return entries.length === 0 ? '{}' : `{\n${entries.map(([key, item]) => `${indent}  ${JSON.stringify(key)}: ${stableJson(item, `${indent}  `)}`).join(',\n')}\n${indent}}`
  }
  return JSON.stringify(value)
}

/** The mock's LB-03: its documents, the visitors' counts of them and the traces they leave. */
export class Lb03Mock {
  readonly #seed: Lb03Seed
  readonly #now: () => number
  readonly #documents = new Map<string, MockDocument>()
  readonly #runs = new Map<string, MockSpan[]>()
  readonly #options: Lb03MockOptions

  /** Starts with no documents. */
  constructor(seed: Lb03Seed, now: () => number, options: Lb03MockOptions = {}) {
    this.#seed = seed
    this.#now = now
    this.#options = options
  }

  /** Forgets every document and trace. */
  reset(): void {
    this.#documents.clear()
    this.#runs.clear()
  }

  /** Reads how many documents a visitor has uploaded today, how many are being read, and the limits. */
  quota(session: string): Answer {
    const used = this.#usedToday(session)
    return {
      status: 200,
      body: {
        used,
        remaining: Math.max(DOCUMENTS_PER_DAY - used, 0),
        active: this.#active(session),
        resets_at: this.#nextMidnight(),
        can_read: true,
        limits: {
          documents_per_day: DOCUMENTS_PER_DAY,
          concurrent_documents: ACTIVE_PER_VISITOR,
          max_upload_bytes: MAX_UPLOAD_BYTES,
          max_pages: MAX_PAGES,
          file_lifetime_seconds: FILE_LIFETIME_MS / 1_000,
          max_model_calls_per_document: 5,
          document_deadline_seconds: 150,
        },
      },
    }
  }

  /** Takes a file: a file that is not one of the four kinds or is too big is refused, a visitor out of places gets a 429, else it is read. */
  upload(session: string, upload: Lb03Upload | undefined): Answer {
    if (upload === undefined) return errorAnswer(422, 'invalid_request', 'The upload is one file part, named file.')
    if (upload.data.length > MAX_UPLOAD_BYTES) return errorAnswer(413, 'too_large', 'The file is larger than 10 MB.')
    const kind = sniff(upload.data)
    if (kind === undefined) return errorAnswer(415, 'unsupported_file', 'The file is not a PDF, PNG, JPEG or WebP.')
    if (this.#usedToday(session) >= DOCUMENTS_PER_DAY) {
      return { status: 429, body: { error: { code: 'daily_limit', message: `You have uploaded today's ${DOCUMENTS_PER_DAY} documents. The count starts again at midnight UTC.`, resets_at: this.#nextMidnight() } } }
    }
    if (this.#active(session) >= ACTIVE_PER_VISITOR) {
      return errorAnswer(429, 'document_running', `${ACTIVE_PER_VISITOR} of your documents are being read. Wait for one to finish, then upload again.`)
    }
    const document = this.#read(session, kind, upload)
    this.#documents.set(document.id, document)
    this.#runs.set(document.runId, lb03Spans(document.runId, this.#now(), this.#flow(document)))
    return { status: 202, body: this.#out(document) }
  }

  /** Lists a visitor's documents of the hour, newest first. */
  list(session: string): Answer {
    const documents = this.#own(session).toSorted((a, b) => b.createdAt - a.createdAt)
    return { status: 200, body: { documents: documents.map(document => this.#summary(document)) } }
  }

  /** Reads one document, and moves it on one state as it is polled. */
  get(session: string, id: string): Answer {
    const document = this.#find(session, id)
    if (document === undefined) return errorAnswer(404, 'not_found', NOT_FOUND)
    if (document.held < (this.#options.holdPolls ?? 0)) document.held += 1
    else document.polls += 1
    return { status: 200, body: this.#out(document) }
  }

  /** Corrects one field of a read document: every check runs again, and the correction is recorded. */
  correct(session: string, id: string, body: { path: string, value: string }): Answer {
    const document = this.#find(session, id)
    if (document === undefined) return errorAnswer(404, 'not_found', NOT_FOUND)
    if (this.#state(document) !== 'ready' || document.invoice === undefined) return errorAnswer(409, 'not_ready', 'The document has not been read yet, or it could not be read.')
    if (document.corrections.length >= MAX_CORRECTIONS) return errorAnswer(409, 'too_many_corrections', `A document keeps at most ${MAX_CORRECTIONS} corrections.`)
    const before = getField(document.invoice, body.path)
    const edited = setField(document.invoice, body.path, body.value)
    if (before === undefined || edited === undefined) return errorAnswer(422, 'invalid_field', 'That field doesn\'t exist on this document, or the value doesn\'t fit it.')
    const after = getField(edited, body.path) ?? null
    if (after === (before ?? null)) return { status: 200, body: this.#out(document) }
    document.placements.delete(body.path)
    document.corrections.push({ path: body.path, was: before ?? null, now: after, at: new Date(this.#now()).toISOString() })
    document.invoice = edited
    this.#check(document)
    return { status: 200, body: this.#out(document) }
  }

  /** Returns the JPEG of one page of a visitor's document. */
  page(session: string, id: string, number: number): Answer | Lb03FileAnswer {
    const document = this.#find(session, id)
    if (document === undefined || !this.#pagesDrawn(document) || number < 1 || number > document.source.pages) return errorAnswer(404, 'not_found', NOT_FOUND)
    const sample = document.source.sample
    const picture = sample === undefined ? undefined : this.#seed.picture(sample, number)
    if (picture === undefined) return errorAnswer(404, 'not_found', NOT_FOUND)
    return { status: 200, file: { bytes: picture, contentType: 'image/jpeg', headers: { 'content-disposition': `inline; filename="page-${number}.jpg"` } } }
  }

  /** Makes a file of a read document: its lines or its journal entry as CSV, or everything as JSON. */
  exportDocument(session: string, id: string, format: string): Answer | Lb03FileAnswer {
    const document = this.#find(session, id)
    if (document === undefined) return errorAnswer(404, 'not_found', NOT_FOUND)
    if (!['csv', 'journal', 'json'].includes(format)) return errorAnswer(422, 'invalid_request', 'The format is csv, journal or json.')
    if (this.#state(document) !== 'ready' || document.invoice === undefined) return errorAnswer(409, 'not_ready', 'The document has not been read yet, or it could not be read.')
    if (format === 'json') return this.#jsonFile(document, document.invoice)
    if (blocksExport(document.checks)) return errorAnswer(409, 'checks_failed', 'The document fails a check that stops its export. Correct the failing fields first.')
    const csv = (name: string, text: string): Lb03FileAnswer => ({ status: 200, file: { bytes: Buffer.from(text, 'utf8'), contentType: 'text/csv; charset=utf-8', headers: { 'content-disposition': `attachment; filename="${name}"` } } })
    if (format === 'csv') return csv('invoice-lines.csv', linesCsv(document.invoice))
    const entry = post(document.invoice, this.#seed.chart)
    return entry === undefined ? errorAnswer(409, 'no_journal_entry', 'The document does not make a balanced journal entry.') : csv('journal-entry.csv', journalCsv(entry))
  }

  /** Deletes a document that has ended, with its files. */
  remove(session: string, id: string): Answer {
    const document = this.#find(session, id)
    if (document === undefined) return errorAnswer(404, 'not_found', NOT_FOUND)
    if (!this.#final(document)) return errorAnswer(409, 'still_reading', 'The document is still being read. It can be deleted once it has ended.')
    this.#documents.delete(id)
    return { status: 204 }
  }

  /** Returns the spans of a run, oldest first, or undefined for a run that is not known. */
  spansOf(runId: string): MockSpan[] | undefined {
    return this.#runs.get(runId)
  }

  /** Gives a run the spans a test wants. */
  setSpans(runId: string, spans: MockSpan[]): void {
    this.#runs.set(runId, spans)
  }

  /** Returns a visitor's unexpired documents. */
  #own(session: string): MockDocument[] {
    const now = this.#now()
    return [...this.#documents.values()].filter(document => document.session === session && document.createdAt + FILE_LIFETIME_MS > now)
  }

  /** Finds a visitor's own document, if it exists and has not expired. */
  #find(session: string, id: string): MockDocument | undefined {
    return this.#own(session).find(document => document.id === id)
  }

  /** The next midnight, UTC, as the real API writes it. */
  #nextMidnight(): string {
    const midnight = Date.parse(`${dayOf(this.#now())}T00:00:00Z`) + DAY_MS
    return new Date(midnight).toISOString().replace('.000Z', '+00:00')
  }

  /** Counts the documents a visitor uploaded since midnight, UTC. */
  #usedToday(session: string): number {
    const midnight = Date.parse(`${dayOf(this.#now())}T00:00:00Z`)
    return [...this.#documents.values()].filter(document => document.session === session && document.createdAt >= midnight).length
  }

  /** Counts the visitor's documents that are still being read. */
  #active(session: string): number {
    return this.#own(session).filter(document => !this.#final(document)).length
  }

  /** Tells where a document is in the pipeline. */
  #state(document: MockDocument): DocumentState {
    return document.sequence[Math.min(document.polls, document.sequence.length - 1)] ?? 'uploaded'
  }

  /** Tells whether a document's pipeline is over. */
  #final(document: MockDocument): boolean {
    const state = this.#state(document)
    return state === 'ready' || state === 'failed'
  }

  /** Reads an uploaded file as the golden set says: the document it is, or the clean sample when the mock does not know it. */
  #read(session: string, kind: FileKind, upload: Lb03Upload): MockDocument {
    const hash = createHash('sha256').update(upload.data).digest('hex')
    const known = this.#seed.cases.find(item => item.sha256 === hash)
    const stand = known ?? this.#seed.cases.find(item => item.sample === 'clean-pdf') ?? this.#seed.cases[0]
    if (stand === undefined) throw new Error('The golden set has no documents.')
    const ending = this.#endingOf(stand)
    const document: MockDocument = {
      id: randomBytes(16).toString('base64url'),
      session,
      label: cleanLabel(upload.filename),
      kind,
      byteSize: upload.data.length,
      createdAt: this.#now(),
      source: stand,
      fileSha256: known === undefined ? stand.sha256 : hash,
      ending,
      sequence: this.#sequenceOf(ending),
      polls: 0,
      held: 0,
      steps: [],
      runId: `run-${randomBytes(10).toString('hex')}`,
      invoice: ending.kind === 'ready' ? stand.invoice : undefined,
      placements: new Map(),
      checks: [],
      journal: undefined,
      duplicate: undefined,
      identity: undefined,
      corrections: [],
      modelCalls: 0,
    }
    if (ending.kind === 'ready' && document.invoice !== undefined) {
      document.placements = this.#place(stand, document.invoice)
      this.#check(document)
    }
    document.modelCalls = ending.kind === 'ready' ? (ending.repair ? 3 : 2) : ending.at === 'extract' ? 1 : 0
    document.steps = this.#stepsOf(document)
    return document
  }

  /** Decides how a document ends, from what the golden set expects of it. */
  #endingOf(source: Lb03Case): Ending {
    const { expect } = source
    if (expect.outcome === 'failed') return { kind: 'failed', code: expect.failure ?? 'unreadable_file', at: 'ocr' }
    if (expect.outcome === 'held' && expect.guardFlags) return { kind: 'failed', code: 'injection_suspected', at: 'extract' }
    return { kind: 'ready', repair: expect.failingChecks.some(check => REPAIRABLE.has(check)) }
  }

  /** Lists the states a document is polled through. */
  #sequenceOf(ending: Ending): DocumentState[] {
    if (ending.kind === 'failed') return ending.at === 'ocr' ? ['uploaded', 'ocr', 'failed'] : ['uploaded', 'ocr', 'extract', 'failed']
    return ending.repair ? ['uploaded', 'ocr', 'extract', 'validate', 'repair', 'ready'] : ['uploaded', 'ocr', 'extract', 'validate', 'ready']
  }

  /** Puts a box on every printed field the generator drew, with a made-up certainty a photograph or a handwriting makes lower. */
  #place(source: Lb03Case, invoice: Invoice): Map<string, Placement> {
    const found = new Map<string, Placement>()
    const wanted = new Set(expectedPaths(invoice))
    const photographed = source.mime !== 'application/pdf'
    for (const box of source.boxes) {
      if (!wanted.has(box.path)) continue
      // The handwritten receipt's first description wraps over two lines, so no word of it is found whole.
      if (source.kind === 'handwritten' && box.path === 'line_items.0.description') continue
      const chance = unit(`${source.id}:${box.path}`)
      const ocr = source.kind === 'handwritten' ? 0.62 + 0.3 * chance : photographed ? 0.78 + 0.2 * chance : 0.96 + 0.035 * chance
      const match = photographed && unit(`${box.path}:${source.id}`) > 0.85 ? 0.9 : 1
      found.set(box.path, { page: box.page, quad: box.quad, confidence: Math.round(ocr * match * 10_000) / 10_000, match })
    }
    return found
  }

  /** Runs every check on the reading as it stands, finds the duplicate it may be, and makes the journal entry if nothing stops it. */
  #check(document: MockDocument): void {
    const invoice = document.invoice
    if (invoice === undefined) return
    const confirmed = new Set(document.corrections.map(item => item.path))
    const identity = identityOf(invoice)
    const match = identity === undefined ? undefined : findDuplicate(identity, this.#known(document), document.fileSha256)
    document.identity = identity
    document.duplicate = match === undefined ? undefined : { of: match.known.reference, source: match.known.source, sameContent: match.sameContent }
    document.checks = [
      ...runChecks(invoice, this.#seed.today),
      checkFieldsOnPage(invoice, new Set(document.placements.keys()), confirmed),
      duplicateResult(identity, match),
    ]
    document.journal = blocksExport(document.checks) ? undefined : post(invoice, this.#seed.chart)
  }

  /** Lists what a reading is compared with: the visitor's other documents that are read, and the samples. */
  #known(document: MockDocument): Known[] {
    const others: Known[] = this.#own(document.session)
      .filter(other => other.id !== document.id && other.ending.kind === 'ready' && other.identity !== undefined)
      .map(other => ({ source: 'document', reference: other.id, identity: other.identity as Identity }))
    const samples: Known[] = []
    for (const item of this.#seed.cases) {
      if (item.sample === undefined || item.invoice === undefined) continue
      const identity = identityOf(item.invoice)
      if (identity !== undefined) samples.push({ source: 'sample', reference: item.sample, identity, fileSha256: item.sha256 })
    }
    return [...others, ...samples]
  }

  /** Lists the steps a document's run took, in order, with made-up timings. */
  #stepsOf(document: MockDocument): Step[] {
    const { ending, source } = document
    const picture = document.kind !== 'pdf'
    const ocr: Step = { name: 'ocr', status: 'ok', ms: 3_200, detail: { pages: source.pages, words: 120, worker_ms: 2_900, seccomp: true, landlock_abi: 3 } }
    const steps: Step[] = [{ name: 'queue', status: 'ok', ms: 40, detail: { waited_ms: 40 } }]
    if (ending.kind === 'failed' && ending.at === 'ocr') return [...steps, { name: 'ocr', status: 'error', ms: 0, detail: { code: ending.code } }]
    steps.push(ocr)
    if (ending.kind === 'failed') return [...steps, { name: 'injection check', status: 'error', ms: 190, detail: { segments: 1, flagged: true, score: 0.99 } }]
    steps.push({ name: 'injection check', status: 'ok', ms: 190, detail: { segments: 1, flagged: false, score: 0.01 } })
    steps.push({ name: 'extract', status: 'ok', ms: picture ? 5_200 : 1_900, detail: { alias: picture ? 'lb-vision' : 'lb-fast', attempts: 1, text_chars: 900, text_cut: false, picture } })
    const failed = document.checks.filter(check => check.status === 'failed' && check.severity === 'error' && REPAIRABLE.has(check.id)).length
    steps.push({ name: 'validate', status: 'ok', ms: 2, detail: { failed, ran: 9 } })
    if (ending.repair) steps.push({ name: 'repair', status: 'ok', ms: picture ? 5_200 : 1_900, detail: { adopted: false, failed_before: failed, failed_after: failed } })
    const expected = document.invoice === undefined ? 0 : expectedPaths(document.invoice).length
    steps.push({ name: 'place fields', status: 'ok', ms: 6, detail: { found: document.placements.size, expected } })
    steps.push({ name: 'check duplicates', status: 'ok', ms: 3, detail: { compared: this.#known(document).length, duplicate: document.duplicate !== undefined } })
    steps.push(document.journal === undefined ? { name: 'journal entry', status: 'skipped', ms: 0, detail: { reason: 'checks_failed' } } : { name: 'journal entry', status: 'ok', ms: 2, detail: { lines: document.journal.lines.length } })
    return steps
  }

  /** Describes how a document's run went, for the spans it leaves. */
  #flow(document: MockDocument): Lb03Flow {
    const { ending } = document
    const failedChecks = document.checks.filter(check => check.status === 'failed' && check.severity === 'error').length
    return {
      kind: document.kind,
      failure: ending.kind === 'failed' ? ending.code : undefined,
      stoppedAt: ending.kind === 'failed' ? ending.at : undefined,
      picture: document.kind !== 'pdf',
      repair: ending.kind === 'ready' && ending.repair,
      repairAdopted: false,
      failedChecks,
      placed: document.placements.size,
      expected: document.invoice === undefined ? 0 : expectedPaths(document.invoice).length,
      compared: this.#known(document).length,
      duplicate: document.duplicate !== undefined,
      journalLines: document.journal?.lines.length,
      pages: document.source.pages,
      words: 120,
    }
  }

  /** Which steps a document shows at each state: the ones that were saved when the pipeline moved on. */
  #visibleSteps(document: MockDocument, state: DocumentState): Step[] {
    const names: Record<DocumentState, string[]> = {
      uploaded: [],
      ocr: ['queue'],
      extract: ['queue', 'ocr'],
      validate: ['queue', 'ocr', 'injection check', 'extract'],
      repair: ['queue', 'ocr', 'injection check', 'extract', 'validate'],
      ready: document.steps.map(step => step.name),
      failed: document.steps.map(step => step.name),
    }
    const shown = names[state]
    return document.steps.filter(step => shown.includes(step.name))
  }

  /** Writes a field's box and what the checks say of it. */
  #fieldsOut(document: MockDocument, invoice: Invoice): Record<string, unknown>[] {
    const edited = new Set(document.corrections.map(item => item.path))
    return fieldPaths(invoice).map((path) => {
      const placement = document.placements.get(path)
      return {
        path,
        kind: kindOf(path),
        value: getField(invoice, path) ?? null,
        box: placement === undefined ? null : { ...placement, band: bandOf(placement.confidence) },
        edited: edited.has(path),
        checks: document.checks.filter(check => check.status === 'failed' && check.fields.includes(path)).map(check => check.id).toSorted(),
      }
    })
  }

  /** Writes a journal entry as the API shows it. */
  #journalOut(entry: Journal): Record<string, unknown> {
    const totals = journalTotals(entry)
    return {
      date: entry.date,
      reference: entry.reference,
      currency: entry.currency,
      lines: entry.lines.map(line => ({ account: line.account, name: line.name, debit: amountText(line.debit), credit: amountText(line.credit), memo: line.memo })),
      total_debit: amountText(totals.debit),
      total_credit: amountText(totals.credit),
    }
  }

  /**
   * Says whether the document's pages have been read and drawn: a document that is read to the end has them, and so has
   * one that failed after the OCR (the injection check, a model), which is how the service keeps its pictures. One the
   * OCR refused, or that is still being read, has none.
   */
  #pagesDrawn(document: MockDocument): boolean {
    const state = this.#state(document)
    if (state === 'ready') return true
    return state === 'failed' && document.ending.kind === 'failed' && document.ending.at === 'extract'
  }

  /** Writes a document as the API shows it: where it is, and once it is read everything that was made of it. */
  #out(document: MockDocument): Record<string, unknown> {
    const state = this.#state(document)
    const ready = state === 'ready' && document.invoice !== undefined
    const final = state === 'ready' || state === 'failed'
    const checks = ready ? document.checks : undefined
    const created = new Date(document.createdAt).toISOString()
    return {
      id: document.id,
      state,
      failure: document.ending.kind === 'failed' && state === 'failed' ? { code: document.ending.code, message: FAILURE_MESSAGES[document.ending.code] ?? 'The document could not be read.' } : null,
      label: document.label,
      kind: document.kind,
      byte_size: document.byteSize,
      pages: this.#pagesDrawn(document) ? document.source.pages : null,
      created_at: created,
      updated_at: new Date(Math.max(this.#now(), document.createdAt)).toISOString(),
      expires_at: new Date(document.createdAt + FILE_LIFETIME_MS).toISOString(),
      queued_ahead: state === 'uploaded' ? (this.#options.queuedAhead ?? 0) : null,
      text_cut: false,
      model: ready ? (document.kind === 'pdf' ? 'groq/gpt-oss-20b' : 'openrouter/qwen2.5-vl-32b-instruct:free') : null,
      model_calls: final ? document.modelCalls : 0,
      run_id: final ? document.runId : null,
      ocr_ms: final ? 3_200 : null,
      elapsed_ms: final ? document.steps.reduce((total, step) => total + step.ms, 0) + 60 : null,
      steps: this.#visibleSteps(document, state),
      prices_include_vat: ready ? (document.invoice?.pricesIncludeVat ?? null) : null,
      fields: ready && document.invoice !== undefined ? this.#fieldsOut(document, document.invoice) : null,
      checks: checks ?? null,
      duplicate: ready && document.duplicate !== undefined ? { of: document.duplicate.of, source: document.duplicate.source, same_content: document.duplicate.sameContent } : null,
      journal: ready && document.journal !== undefined ? this.#journalOut(document.journal) : null,
      journal_status: ready ? (document.journal !== undefined ? 'made' : blocksExport(document.checks) ? 'blocked_by_checks' : 'does_not_balance') : null,
      corrections: document.corrections,
      can_export: ready && !blocksExport(document.checks),
    }
  }

  /** Writes a document's line in the list. */
  #summary(document: MockDocument): Record<string, unknown> {
    const out = this.#out(document)
    const checks = out.checks as CheckResult[] | null
    return {
      id: out.id,
      state: out.state,
      failure: out.failure,
      label: out.label,
      kind: out.kind,
      byte_size: out.byte_size,
      pages: out.pages,
      created_at: out.created_at,
      expires_at: out.expires_at,
      checks_failed: checks === null ? null : checks.filter(check => check.status === 'failed').length,
      can_export: out.can_export,
    }
  }

  /** Makes the JSON file of a read document: the invoice, its checks, the journal entry and its corrections. */
  #jsonFile(document: MockDocument, invoice: Invoice): Lb03FileAnswer {
    const content = {
      document: { id: document.id, label: document.label, kind: document.kind, pages: document.source.pages, model: document.kind === 'pdf' ? 'groq/gpt-oss-20b' : 'openrouter/qwen2.5-vl-32b-instruct:free', run_id: document.runId },
      invoice: invoiceJson(invoice),
      checks: document.checks,
      journal: document.journal === undefined ? null : this.#journalOut(document.journal),
      duplicate_of: document.duplicate === undefined ? null : `${document.duplicate.source}:${document.duplicate.of}`,
      corrections: document.corrections,
    }
    return { status: 200, file: { bytes: Buffer.from(`${stableJson(content)}\n`, 'utf8'), contentType: 'application/json', headers: { 'content-disposition': 'attachment; filename="invoice.json"' } } }
  }

  /** The chart the mock posts journal entries to, for a test that looks at it. */
  get chart(): Chart {
    return this.#seed.chart
  }
}
