// LB-04 Contract Radar as the mock back end plays it: a visitor reviews one of the six sample
// contracts or sends a PDF, follows the review as it moves through its states, reads the pages, the
// file and the report, asks for a redline of a finding, and deletes the contract early. The answers
// have the shapes services/node-systems/openapi.json documents. What stands behind them is the
// service's own code over the service's own data: the real upload checks, the real PDF extraction,
// the real review pipeline and redline proposal, and the real playbook, with the golden set's
// reference reviewer in place of the models (lb04-worker.ts says what that finds). The daily limits,
// the one-hour life of a contract, the place given back for a file that fails, and the three
// redlines a contract may have are the real service's too.
//
// The review moves one state each time the site asks for the contract (queued, extracting,
// analysing, verifying, done), so a board can be driven through every state without a clock; with
// `pollsPerState` a state lasts that many polls. `failNext(code)` makes the next contract's review
// end as failed with that reason, for the states a sample never reaches (the model out of quota).
import { randomUUID } from 'node:crypto'

import { LB04_FAILURE_MESSAGES, LB04_LIMITS, NOT_LEGAL_ADVICE } from '../../../contracts/src/index.ts'
import type { Lb04ContractView, Lb04CreateContractRequest, Lb04FailureCode, Lb04Redline, Lb04Report, Lb04State } from '../../../contracts/src/index.ts'
import { AppError } from '../../../../services/node-systems/src/core/errors.ts'
import type { ExtractedPage } from '../../../../services/node-systems/src/modules/lb04/pdf/extract.ts'
import { decodeUpload, titleOf } from '../../../../services/node-systems/src/modules/lb04/pdf/upload.ts'
import { playbookView } from '../../../../services/node-systems/src/modules/lb04/playbook/playbook.ts'

import { errorAnswer } from './lb01.ts'
import type { Answer } from './lb01.ts'
import type { Lb04Seed } from './lb04-seed.ts'
import { Lb04Worker } from './lb04-worker.ts'
import type { ReviewJob } from './lb04-worker.ts'
import type { MockSpan } from './spans.ts'

// A contract is kept this long, as the real service keeps it.
const KEPT_MS = LB04_LIMITS.keptMinutes * 60_000
const DAY_MS = 86_400_000
// How many of a visitor's contracts the list shows, as the real service's list does.
const LISTED = 20

// The states a review is shown in after `queued`, one for each poll.
const STEPS = ['extracting', 'analysing', 'verifying', 'done'] as const

// How much of a trace a visitor may see while the review is in a state, as a share of its spans without the root: the trace grows as the review does.
const TRACE_SHARE: Readonly<Partial<Record<Lb04State, number>>> = { queued: 0, extracting: 0.1, analysing: 0.45, verifying: 0.85 }

/** What a test may choose about the mock's LB-04. */
export interface Lb04MockOptions {
  // How many times the site must ask for a contract before it moves on to its next state: once by default.
  pollsPerState?: number
}

/** A contract the mock holds for one visitor. */
interface ContractRecord {
  id: string
  session: string
  origin: 'upload' | 'sample'
  sampleId: string | null
  title: string
  // The file, until the review fails (a failed review deletes it).
  bytes: Uint8Array | undefined
  createdAt: number
  expiresAt: number
  // How many times the site has asked for it: the review moves on with each.
  polls: number
  state: Lb04State
  failure: Lb04FailureCode | null
  // The page count, once the file has been opened.
  pageCount: number | null
  // The pages' text, from the moment the review shows it has read them until it fails.
  pages: ExtractedPage[] | undefined
  report: Lb04Report | undefined
  redlines: Lb04Redline[]
  redlinesUsed: number
  job: ReviewJob
}

/** The mock's LB-04: its contracts, its worker and its daily allowances. */
export class Lb04Mock {
  readonly #seed: Lb04Seed
  readonly #now: () => number
  readonly #worker: Lb04Worker
  readonly #pollsPerState: number
  readonly #contracts = new Map<string, ContractRecord>()
  readonly #usage = new Map<string, number>()
  readonly #forced: Lb04FailureCode[] = []

  /** Starts with no contracts and a fresh day. */
  constructor(seed: Lb04Seed, now: () => number, options: Lb04MockOptions = {}) {
    this.#seed = seed
    this.#now = now
    this.#worker = new Lb04Worker(seed)
    this.#pollsPerState = Math.max(1, options.pollsPerState ?? 1)
  }

  /** Forgets every contract, allowance and scripted failure. */
  reset(): void {
    this.#contracts.clear()
    this.#usage.clear()
    this.#forced.length = 0
  }

  /** Makes the next contract's review end as failed with `code`: a file failure refuses the file as the extraction would, and any other makes the first model fail. */
  failNext(code: Lb04FailureCode): void {
    this.#forced.push(code)
  }

  /** What is left of the visitor's day, and the system's limits. */
  limits(session: string): Answer {
    const used = this.#used(session, 'contract')
    const limit = LB04_LIMITS.contractsPerVisitorPerDay
    return {
      status: 200,
      body: {
        contracts: { limit, used, remaining: Math.max(limit - used, 0) },
        maxPages: LB04_LIMITS.maxPages,
        maxFileBytes: LB04_LIMITS.maxFileBytes,
        keptMinutes: LB04_LIMITS.keptMinutes,
        redlinesPerContract: LB04_LIMITS.redlinesPerContract,
        resetsAt: new Date(this.#midnight() + DAY_MS).toISOString(),
      },
    }
  }

  /** The curated sample contracts. */
  samples(): Answer {
    return { status: 200, body: this.#seed.samples.map(sample => ({ id: sample.entry.id, title: sample.entry.title, pages: sample.entry.pages })) }
  }

  /** The playbook the reviews are read against. */
  playbook(): Answer {
    return { status: 200, body: playbookView(this.#seed.playbook) }
  }

  /**
   * Starts a review of a sample or of a PDF the visitor sends: 404 for an unknown sample, 415 for a file that is
   * not a PDF, 413 for one over the limit, 429 when the day's contracts or files are used up. The answer is the contract, queued.
   */
  create(session: string, request: Lb04CreateContractRequest): Answer {
    let source: { bytes: Uint8Array, title: string, origin: 'upload' | 'sample', sampleId: string | null }
    try {
      source = this.#sourceOf(request)
    }
    catch (error) {
      if (error instanceof AppError) return errorAnswer(error.status, error.code, error.message)
      throw error
    }
    if (source.origin === 'upload' && this.#used(session, 'upload') >= LB04_LIMITS.uploadsPerVisitorPerDay) return this.#limitAnswer('upload')
    if (this.#used(session, 'contract') >= LB04_LIMITS.contractsPerVisitorPerDay) return this.#limitAnswer('contract')
    if (source.origin === 'upload') this.#take(session, 'upload', this.#midnight())
    this.#take(session, 'contract', this.#midnight())
    const id = randomUUID()
    const createdAt = this.#now()
    const job = this.#worker.start({ id, session, origin: source.origin, bytes: source.bytes, createdAt, forced: this.#forced.shift() })
    const record: ContractRecord = {
      id,
      session,
      origin: source.origin,
      sampleId: source.sampleId,
      title: source.title,
      bytes: source.bytes,
      createdAt,
      expiresAt: createdAt + KEPT_MS,
      polls: 0,
      state: 'queued',
      failure: null,
      pageCount: null,
      pages: undefined,
      report: undefined,
      redlines: [],
      redlinesUsed: 0,
      job,
    }
    this.#contracts.set(id, record)
    return { status: 201, body: this.#view(record) }
  }

  /** The visitor's contracts, newest first, that have not expired. */
  list(session: string): Answer {
    const own = [...this.#contracts.values()].filter(record => record.session === session && record.expiresAt > this.#now()).reverse()
    return { status: 200, body: own.slice(0, LISTED).map(record => this.#view(record)) }
  }

  /** One contract, moved on to the next state of its review first, as it would have moved while the site waited. */
  async get(session: string, id: string): Promise<Answer> {
    const record = this.#find(session, id)
    if (!record) return this.#notFound()
    await this.#advance(record)
    return { status: 200, body: this.#view(record) }
  }

  /** The text of every page, from the moment the review has read the file until it ends as done; 409 before and after a failure. */
  pages(session: string, id: string): Answer {
    const record = this.#find(session, id)
    if (!record) return this.#notFound()
    if (record.pages === undefined) return this.#nothingToShow(record)
    return { status: 200, body: { pages: record.pages.map(page => ({ page: page.page, text: page.text })) } }
  }

  /** The PDF, as base64: there from the start until the review fails, which deletes it. */
  file(session: string, id: string): Answer {
    const record = this.#find(session, id)
    if (!record) return this.#notFound()
    if (record.bytes === undefined) return this.#nothingToShow(record)
    return { status: 200, body: { contentType: 'application/pdf', size: record.bytes.byteLength, base64: Buffer.from(record.bytes).toString('base64') } }
  }

  /** The finished report, with the redlines made so far. */
  report(session: string, id: string): Answer {
    const record = this.#find(session, id)
    if (!record) return this.#notFound()
    if (record.report === undefined) return this.#nothingToShow(record)
    return { status: 200, body: { ...record.report, redlines: record.redlines } }
  }

  /**
   * A redline of one finding: a redline already made is shown again for nothing (200), a new one takes one of the
   * contract's three and is made by the real proposal with the stand-in model (201). 404 for a finding the report
   * does not have, 409 until the review is done, 429 when the three are made.
   */
  async redline(session: string, id: string, findingId: string): Promise<Answer> {
    const record = this.#find(session, id)
    if (!record) return this.#notFound()
    if (record.report === undefined) return this.#nothingToShow(record)
    const finding = record.report.findings.find(candidate => candidate.id === findingId)
    if (!finding) return errorAnswer(404, 'finding_not_found', 'This contract has no such finding.')
    const made = record.redlines.find(candidate => candidate.findingId === findingId)
    if (made) return { status: 200, body: made }
    if (record.redlinesUsed >= LB04_LIMITS.redlinesPerContract) return errorAnswer(429, 'redline_limit', 'This contract has its redlines made.')
    record.redlinesUsed += 1
    try {
      const redline = await this.#worker.redline(record.job, record, finding, this.#now())
      record.redlines.push(redline)
      return { status: 201, body: redline }
    }
    catch {
      record.redlinesUsed -= 1
      return errorAnswer(503, 'analysis_unavailable', 'The model is unavailable right now: the free quota may be spent, or a provider may be down. The samples show what a review looks like, and you can come back later.')
    }
  }

  /** Deletes a contract now. It does not give back the visitor's place for the day. */
  delete(session: string, id: string): Answer {
    const record = this.#find(session, id)
    if (!record) return this.#notFound()
    this.#contracts.delete(id)
    return { status: 204 }
  }

  /** The spans of a contract's trace that the review has got as far as showing; the root span, which ends the trace, only once the review has ended. Undefined for an ID with no trace. */
  spansOf(runId: string): MockSpan[] | undefined {
    const record = this.#contracts.get(runId)
    if (!record || record.expiresAt <= this.#now()) return undefined
    const spans = record.job.trace.log.spans
    if (spans.length === 0) return undefined
    if (record.state === 'done' || record.state === 'failed') return [...spans]
    const share = TRACE_SHARE[record.state] ?? 0
    const body = spans.filter(span => !(span.kind === 'system.run' && span.parentId === undefined))
    const shown = body.slice(0, Math.floor(body.length * share))
    return shown.length > 0 ? shown : undefined
  }

  // ---- Contracts ----

  /** Finds one of the visitor's contracts: another visitor's is exactly as missing as one that isn't there, and so is one whose hour is up. */
  #find(session: string, id: string): ContractRecord | undefined {
    const record = this.#contracts.get(id)
    return record?.session === session && record.expiresAt > this.#now() ? record : undefined
  }

  /** The answer for a contract that is not the visitor's, is not there or has expired. */
  #notFound(): Answer {
    return errorAnswer(404, 'contract_not_found', 'There is no such contract, or it has been deleted.')
  }

  /** The answer for a contract that has nothing to show yet, or ever: its review failed, or has not got far enough. */
  #nothingToShow(record: ContractRecord): Answer {
    return record.state === 'failed'
      ? errorAnswer(409, 'review_failed', 'The review of this contract failed, so there is nothing to show of it.')
      : errorAnswer(409, 'not_ready', 'The review of this contract is not finished yet.')
  }

  /** Reads the file and the title a request is about, with the checks the service makes before it takes a place from the visitor's day. */
  #sourceOf(request: Lb04CreateContractRequest): { bytes: Uint8Array, title: string, origin: 'upload' | 'sample', sampleId: string | null } {
    if (request.from === 'upload') return { bytes: decodeUpload(request.contentBase64), title: titleOf(request.filename), origin: 'upload', sampleId: null }
    const sample = this.#seed.samples.find(candidate => candidate.entry.id === request.sampleId)
    if (!sample) throw new AppError(404, 'unknown_sample', 'There is no sample with that id.')
    return { bytes: sample.bytes, title: sample.entry.title, origin: 'sample', sampleId: sample.entry.id }
  }

  /** Describes a contract as the API shows it. */
  #view(record: ContractRecord): Lb04ContractView {
    return {
      id: record.id,
      runId: record.id,
      title: record.title,
      origin: record.origin,
      sampleId: record.sampleId,
      state: record.state,
      failure: record.failure === null ? null : { code: record.failure, message: LB04_FAILURE_MESSAGES[record.failure] },
      pages: record.pageCount,
      createdAt: new Date(record.createdAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
      redlinesLeft: Math.max(0, LB04_LIMITS.redlinesPerContract - record.redlinesUsed),
      notLegalAdvice: NOT_LEGAL_ADVICE,
    }
  }

  // ---- The review's states ----

  /** Moves a review on by one poll: when the poll reaches a new state, the state is shown, and what that state makes known (the pages, the report, a failure) with it. */
  async #advance(record: ContractRecord): Promise<void> {
    if (record.state === 'done' || record.state === 'failed') return
    record.polls += 1
    if ((record.polls - 1) % this.#pollsPerState !== 0) return
    const target = STEPS[Math.floor((record.polls - 1) / this.#pollsPerState)] ?? 'done'
    if (target === 'extracting') {
      record.state = 'extracting'
      return
    }
    if (target === 'analysing') {
      const opened = await record.job.extracted
      if ('refused' in opened) {
        this.#fail(record, opened.refused)
        return
      }
      record.pages = opened.pages
      record.pageCount = opened.pages.length
      record.state = 'analysing'
      return
    }
    const ended = await record.job.ended
    if ('failed' in ended) {
      this.#fail(record, ended.failed)
      return
    }
    if (target === 'verifying') {
      record.state = 'verifying'
      return
    }
    record.report = ended.report
    record.state = 'done'
  }

  /** Ends a review as failed: the file and the text are deleted at once, and the visitor's place for the contract is given back on the day it was taken, as the service does. A file that was sent stays counted as sent. */
  #fail(record: ContractRecord, code: Lb04FailureCode): void {
    record.state = 'failed'
    record.failure = code
    record.bytes = undefined
    record.pages = undefined
    this.#give(record.session, 'contract', new Date(record.createdAt).setUTCHours(0, 0, 0, 0))
  }

  // ---- Allowances ----

  /** Midnight UTC of the mock's day. */
  #midnight(): number {
    return new Date(this.#now()).setUTCHours(0, 0, 0, 0)
  }

  /** How much of a day's allowance of one kind a visitor has used. */
  #used(session: string, kind: 'contract' | 'upload'): number {
    return this.#usage.get(`${session}:${this.#midnight()}:${kind}`) ?? 0
  }

  /** Takes one place of the day that starts at `day`. */
  #take(session: string, kind: 'contract' | 'upload', day: number): void {
    const key = `${session}:${day}:${kind}`
    this.#usage.set(key, (this.#usage.get(key) ?? 0) + 1)
  }

  /** Gives back one place of the day that starts at `day`, never below nothing used. */
  #give(session: string, kind: 'contract' | 'upload', day: number): void {
    const key = `${session}:${day}:${kind}`
    this.#usage.set(key, Math.max((this.#usage.get(key) ?? 0) - 1, 0))
  }

  /** The answer for a visitor who has used the day's contracts or files, with when the day starts again, as a time and as a wait, as the real service says it. */
  #limitAnswer(kind: 'contract' | 'upload'): Answer {
    const resetsAt = this.#midnight() + DAY_MS
    const seconds = Math.max(1, Math.ceil((resetsAt - this.#now()) / 1_000))
    const message = kind === 'contract'
      ? `You have had ${LB04_LIMITS.contractsPerVisitorPerDay} contracts reviewed today, which is the limit. It starts again at 00:00 UTC.`
      : `You have sent ${LB04_LIMITS.uploadsPerVisitorPerDay} files today, which is the limit. It starts again at 00:00 UTC.`
    return { status: 429, headers: { 'retry-after': String(seconds) }, body: { error: { code: kind === 'contract' ? 'daily_limit' : 'upload_limit', message, resets_at: new Date(resetsAt).toISOString() } } }
  }
}
