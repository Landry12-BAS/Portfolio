// Everything the engine and the routes read from and write to LB-04's schema, in one place.
//
// Three rules hold throughout. A visitor reads only their own contracts, and says so in the query
// itself (`session_key`), so another visitor's contract is simply not found. A contract that has
// expired is not found either, even before the sweep deletes it: an hour is an hour. And the worker's
// writes to a contract refuse to touch one that has ended, so a retry or a late job can never undo a
// finished review or fail a reviewed one twice.
import { createHash } from 'node:crypto'

import { LB04_LIMITS, NOT_LEGAL_ADVICE } from '@lb/contracts'
import type { Lb04ContractView, Lb04FailureCode, Lb04FileView, Lb04PagesView, Lb04Redline, Lb04Report, Lb04State } from '@lb/contracts'
import { and, asc, desc, eq, gt, inArray, lt, lte, sql } from 'drizzle-orm'

import { AppError } from '../../../core/errors.ts'
import { workingSchema } from '../analysis/pipeline.ts'
import type { Working } from '../analysis/pipeline.ts'
import type { Executor, Lb04Db } from '../db/connection.ts'
import { contractFiles, contractPages, contracts, redlines, reports } from '../db/schema.ts'
import type { Lb04Deps } from './deps.ts'
import { dailyLimit, release, reserve } from './usage.ts'

/** The states in which a contract is still being worked on. */
const OPEN_STATES: readonly Lb04State[] = ['queued', 'extracting', 'analysing', 'verifying']

/** What a failed contract says in plain words: a sentence for the API. The board words each code itself, in its own language. */
const FAILURE_MESSAGES: Readonly<Record<Lb04FailureCode, string>> = {
  pdf_unreadable: 'The file could not be read as a PDF.',
  pdf_encrypted: 'The PDF is encrypted, and encrypted files are not read.',
  pdf_xfa: 'The PDF holds an XFA form, which is not read.',
  pdf_embedded_files: 'The PDF carries embedded files, which are not read.',
  too_many_pages: `The contract has more than ${LB04_LIMITS.maxPages} pages.`,
  no_text_layer: 'The PDF has no text layer, as a scan has, and no OCR is done.',
  too_much_text: 'The PDF holds more text than a review reads.',
  extraction_timeout: 'Reading the PDF took too long.',
  extraction_failed: 'Reading the PDF failed.',
  analysis_unavailable: 'The model could not be reached, or its free quota for today is spent.',
  analysis_invalid: 'The model did not answer in a form that could be used.',
  internal: 'The review failed.',
}

/** The error for a contract that isn't there for this visitor: never made, someone else's, or deleted. */
export function contractNotFound(): AppError {
  return new AppError(404, 'contract_not_found', 'There is no such contract, or it has been deleted.')
}

/** The error for a contract whose review has not got far enough to answer yet. */
export function notReady(): AppError {
  return new AppError(409, 'not_ready', 'The review of this contract is not finished yet.')
}

/** The error for a contract whose review failed: it ended without a report, a text or a file, and there is nothing to show of it. */
export function reviewFailed(): AppError {
  return new AppError(409, 'review_failed', 'The review of this contract failed, so there is nothing to show of it.')
}

/** Picks the error for a contract that has nothing to show: its review failed, or has not finished yet. */
function nothingToShow(state: Lb04State): AppError {
  return state === 'failed' ? reviewFailed() : notReady()
}

/** A contract as it is stored, with what a route or the worker needs of it. */
interface ContractRow {
  id: string
  sessionKey: string
  origin: 'upload' | 'sample'
  sampleId: string | null
  title: string
  state: Lb04State
  failureCode: Lb04FailureCode | null
  pages: number | null
  modelCalls: number
  redlinesUsed: number
  createdAt: Date
  expiresAt: Date
}

/** The columns a read of a contract takes, typed as the rest of the engine uses them. */
const CONTRACT_COLUMNS = {
  id: contracts.id,
  sessionKey: contracts.sessionKey,
  origin: contracts.origin,
  sampleId: contracts.sampleId,
  title: contracts.title,
  state: contracts.state,
  failureCode: contracts.failureCode,
  pages: contracts.pages,
  modelCalls: contracts.modelCalls,
  redlinesUsed: contracts.redlinesUsed,
  createdAt: contracts.createdAt,
  expiresAt: contracts.expiresAt,
} as const

/** Narrows the text columns the database stores to the closed lists the code uses, refusing a value that isn't on one. */
function typed(row: Awaited<ReturnType<typeof selectContract>>[number]): ContractRow {
  return { ...row, origin: row.origin === 'sample' ? 'sample' : 'upload', state: row.state as Lb04State, failureCode: row.failureCode as Lb04FailureCode | null }
}

/** Selects one contract by id, and by owner when a session is given, unless it has expired. */
function selectContract(db: Executor, id: string, moment: Date, sessionKey?: string) {
  const owner = sessionKey === undefined ? undefined : eq(contracts.sessionKey, sessionKey)
  return db.select(CONTRACT_COLUMNS).from(contracts).where(and(eq(contracts.id, id), gt(contracts.expiresAt, moment), owner)).limit(1)
}

/** Turns a stored contract into what the API shows of it. */
function viewOf(row: ContractRow): Lb04ContractView {
  return {
    id: row.id,
    runId: row.id,
    title: row.title,
    origin: row.origin,
    sampleId: row.sampleId,
    state: row.state,
    failure: row.failureCode === null ? null : { code: row.failureCode, message: FAILURE_MESSAGES[row.failureCode] },
    pages: row.pages,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    redlinesLeft: Math.max(0, LB04_LIMITS.redlinesPerContract - row.redlinesUsed),
    notLegalAdvice: NOT_LEGAL_ADVICE,
  }
}

/** What a new contract is made from. */
export interface NewContract {
  sessionKey: string
  origin: 'upload' | 'sample'
  sampleId: string | null
  title: string
  file: Uint8Array
}

/**
 * Takes the visitor's places for the day and stores the contract with its file, in one transaction: a
 * contract that can't be stored gives its places back, and a visitor with no place left gets 429 and
 * nothing is stored. A file sent counts as an upload; a sample, which is a file the site already
 * holds, takes only a contract's place.
 */
export async function createContract(deps: Lb04Deps, input: NewContract): Promise<string> {
  const moment = deps.now()
  return deps.db.transaction(async (tx) => {
    if (input.origin === 'upload' && !(await reserve(tx, input.sessionKey, 'upload', moment))) throw dailyLimit('upload', moment)
    if (!(await reserve(tx, input.sessionKey, 'contract', moment))) throw dailyLimit('contract', moment)
    const [created] = await tx.insert(contracts).values({
      sessionKey: input.sessionKey,
      origin: input.origin,
      sampleId: input.sampleId,
      title: input.title,
      createdAt: moment,
      updatedAt: moment,
      expiresAt: new Date(moment.getTime() + deps.config.keptMs),
    }).returning({ id: contracts.id })
    if (!created) throw new Error('A contract was not created.')
    await tx.insert(contractFiles).values({ contractId: created.id, content: Buffer.from(input.file), size: input.file.byteLength, sha256: createHash('sha256').update(input.file).digest('hex') })
    return created.id
  })
}

/** Removes a contract that was stored but could not be queued, and gives its places back, as if it had never been sent. */
export async function withdrawContract(deps: Lb04Deps, id: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [gone] = await tx.delete(contracts).where(eq(contracts.id, id)).returning({ sessionKey: contracts.sessionKey, origin: contracts.origin, createdAt: contracts.createdAt })
    if (!gone) return
    await release(tx, gone.sessionKey, 'contract', gone.createdAt)
    if (gone.origin === 'upload') await release(tx, gone.sessionKey, 'upload', gone.createdAt)
  })
}

/** Reads a visitor's contract as the API shows it, or undefined when it isn't theirs, isn't there or has expired. */
export async function readContractView(db: Executor, sessionKey: string, id: string, moment: Date): Promise<Lb04ContractView | undefined> {
  const [row] = await selectContract(db, id, moment, sessionKey)
  return row === undefined ? undefined : viewOf(typed(row))
}

/** Lists a visitor's contracts, newest first, that have not expired. */
export async function listContractViews(db: Executor, sessionKey: string, moment: Date): Promise<Lb04ContractView[]> {
  const rows = await db.select(CONTRACT_COLUMNS).from(contracts).where(and(eq(contracts.sessionKey, sessionKey), gt(contracts.expiresAt, moment))).orderBy(desc(contracts.createdAt)).limit(20)
  return rows.map(row => viewOf(typed(row)))
}

/** Reads a worker's view of a contract (no session scoping): the row, or undefined when it is gone or has expired. */
export async function readContractForWork(db: Executor, id: string, moment: Date): Promise<ContractRow | undefined> {
  const [row] = await selectContract(db, id, moment)
  return row === undefined ? undefined : typed(row)
}

/** Reads the text of every page of a visitor's contract, once the extraction has made it. */
export async function readPagesView(db: Executor, sessionKey: string, id: string, moment: Date): Promise<Lb04PagesView> {
  const [owned] = await selectContract(db, id, moment, sessionKey)
  if (!owned) throw contractNotFound()
  const rows = await db.select({ page: contractPages.page, text: contractPages.text }).from(contractPages).where(eq(contractPages.contractId, id)).orderBy(asc(contractPages.page))
  if (rows.length === 0) throw nothingToShow(typed(owned).state)
  return { pages: rows }
}

/** Reads the PDF of a visitor's contract, as base64 inside JSON, for the viewer. */
export async function readFileView(db: Executor, sessionKey: string, id: string, moment: Date): Promise<Lb04FileView> {
  const [owned] = await selectContract(db, id, moment, sessionKey)
  if (!owned) throw contractNotFound()
  const [file] = await db.select({ content: contractFiles.content, size: contractFiles.size }).from(contractFiles).where(eq(contractFiles.contractId, id)).limit(1)
  if (!file) throw nothingToShow(typed(owned).state)
  return { contentType: 'application/pdf', size: file.size, base64: file.content.toString('base64') }
}

/** Reads the finished report of a visitor's contract, with the redlines asked for so far put into it. */
export async function readReportView(db: Executor, sessionKey: string, id: string, moment: Date): Promise<Lb04Report> {
  const [owned] = await selectContract(db, id, moment, sessionKey)
  if (!owned) throw contractNotFound()
  const [stored] = await db.select({ report: reports.report }).from(reports).where(eq(reports.contractId, id)).limit(1)
  if (!stored) throw nothingToShow(typed(owned).state)
  const asked = await db.select({ redline: redlines.redline }).from(redlines).where(eq(redlines.contractId, id)).orderBy(asc(redlines.createdAt))
  return { ...stored.report, redlines: asked.map(entry => entry.redline) }
}

/** Reads the bytes of a contract's file, for the extraction. */
export async function readFileBytes(db: Executor, id: string): Promise<Uint8Array | undefined> {
  const [file] = await db.select({ content: contractFiles.content }).from(contractFiles).where(eq(contractFiles.contractId, id)).limit(1)
  return file === undefined ? undefined : new Uint8Array(file.content)
}

/** Reads the text of every page of a contract, in order, for the review. Empty when the extraction has not stored it. */
export async function readPageTexts(db: Executor, id: string): Promise<{ page: number, text: string }[]> {
  return db.select({ page: contractPages.page, text: contractPages.text }).from(contractPages).where(eq(contractPages.contractId, id)).orderBy(asc(contractPages.page))
}

/** Reads what an earlier attempt saved of the review, or a fresh start when nothing readable was saved. */
export async function readWorking(db: Executor, id: string): Promise<Working> {
  const [row] = await db.select({ working: contracts.working }).from(contracts).where(eq(contracts.id, id)).limit(1)
  const parsed = workingSchema.safeParse(row?.working)
  return parsed.success ? parsed.data : { calls: 0 }
}

/** Counts one more start of a contract's review, and returns how many starts it has had in all. Returns 0 for a contract that is gone. */
export async function countAttempt(db: Executor, id: string): Promise<number> {
  const [row] = await db.update(contracts).set({ attempts: sql`${contracts.attempts} + 1` }).where(eq(contracts.id, id)).returning({ attempts: contracts.attempts })
  return row?.attempts ?? 0
}

/** Moves a contract that is still being worked on to a state the visitor sees. Returns false when it has ended or is gone. */
export async function setState(db: Executor, id: string, state: 'extracting' | 'analysing' | 'verifying', moment: Date): Promise<boolean> {
  const moved = await db.update(contracts).set({ state, updatedAt: moment }).where(and(eq(contracts.id, id), inArray(contracts.state, [...OPEN_STATES]), gt(contracts.expiresAt, moment))).returning({ id: contracts.id })
  return moved.length > 0
}

/** Saves what the review has worked out and paid for, and how many model calls that is. */
export async function saveWorking(db: Executor, id: string, working: Working, moment: Date): Promise<void> {
  await db.update(contracts).set({ working, modelCalls: working.calls, updatedAt: moment }).where(and(eq(contracts.id, id), inArray(contracts.state, [...OPEN_STATES])))
}

/** Stores the text of every page a contract has, replacing what an earlier attempt stored, and the page count. */
export async function savePages(db: Lb04Db, id: string, pages: readonly { page: number, text: string }[], moment: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(contractPages).where(eq(contractPages.contractId, id))
    await tx.insert(contractPages).values(pages.map(page => ({ contractId: id, page: page.page, text: page.text })))
    await tx.update(contracts).set({ pages: pages.length, updatedAt: moment }).where(eq(contracts.id, id))
  })
}

/** Stores the finished report and ends the contract as done, once. Returns false when it had already ended. */
export async function completeContract(db: Lb04Db, id: string, report: Lb04Report, moment: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const ended = await tx.update(contracts).set({ state: 'done', updatedAt: moment, working: null, modelCalls: report.calls }).where(and(eq(contracts.id, id), inArray(contracts.state, [...OPEN_STATES]))).returning({ id: contracts.id })
    if (ended.length === 0) return false
    await tx.insert(reports).values({ contractId: id, report, createdAt: moment }).onConflictDoNothing()
    return true
  })
}

/**
 * Ends a contract as failed, once. The file, the text and what the review had saved are deleted at
 * once (there is nothing to show of a failed review), and the visitor's place for the day is given
 * back, on the day it was taken, by this one transition and so only once however often a failed job is run.
 * Returns false when the contract had already ended or is gone.
 */
export async function failContract(db: Lb04Db, id: string, code: Lb04FailureCode, moment: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const ended = await tx.update(contracts).set({ state: 'failed', failureCode: code, updatedAt: moment, working: null }).where(and(eq(contracts.id, id), inArray(contracts.state, [...OPEN_STATES]))).returning({ sessionKey: contracts.sessionKey, createdAt: contracts.createdAt })
    const [row] = ended
    if (!row) return false
    await release(tx, row.sessionKey, 'contract', row.createdAt)
    await tx.delete(contractFiles).where(eq(contractFiles.contractId, id))
    await tx.delete(contractPages).where(eq(contractPages.contractId, id))
    return true
  })
}

/**
 * Takes one of a finished contract's redlines, and tells whether there was one: the statement that
 * does it refuses to pass the limit and to touch a contract that is not the visitor's, not done, or expired.
 */
export async function reserveRedline(db: Executor, sessionKey: string, id: string, moment: Date): Promise<boolean> {
  const taken = await db.update(contracts)
    .set({ redlinesUsed: sql`${contracts.redlinesUsed} + 1` })
    .where(and(eq(contracts.id, id), eq(contracts.sessionKey, sessionKey), eq(contracts.state, 'done'), gt(contracts.expiresAt, moment), lt(contracts.redlinesUsed, LB04_LIMITS.redlinesPerContract)))
    .returning({ used: contracts.redlinesUsed })
  return taken.length > 0
}

/** Gives back a redline taken with `reserveRedline`, for one that could not be made. */
export async function releaseRedline(db: Executor, id: string): Promise<void> {
  await db.update(contracts).set({ redlinesUsed: sql`${contracts.redlinesUsed} - 1` }).where(and(eq(contracts.id, id), gt(contracts.redlinesUsed, 0)))
}

/** Reads the redline already made for a finding, if there is one. */
export async function readRedline(db: Executor, id: string, findingId: string): Promise<Lb04Redline | undefined> {
  const [row] = await db.select({ redline: redlines.redline }).from(redlines).where(and(eq(redlines.contractId, id), eq(redlines.findingId, findingId))).limit(1)
  return row?.redline
}

/** Stores a redline for a finding, and tells whether it was stored. A second redline for the same finding is not stored: the first stands. */
export async function saveRedline(db: Executor, id: string, redline: Lb04Redline, moment: Date): Promise<boolean> {
  const stored = await db.insert(redlines).values({ contractId: id, findingId: redline.findingId, redline, createdAt: moment }).onConflictDoNothing().returning({ id: redlines.id })
  return stored.length > 0
}

/** Deletes a visitor's own contract now, with everything that belongs to it, and tells whether there was one. It does not give back the visitor's place for the day. */
export async function deleteContractOf(db: Executor, sessionKey: string, id: string): Promise<boolean> {
  const gone = await db.delete(contracts).where(and(eq(contracts.id, id), eq(contracts.sessionKey, sessionKey))).returning({ id: contracts.id })
  return gone.length > 0
}

/** Deletes every contract whose hour is up, with everything that belongs to it (the foreign keys cascade). Returns how many. */
export async function deleteExpired(db: Executor, moment: Date): Promise<number> {
  const gone = await db.delete(contracts).where(lte(contracts.expiresAt, moment)).returning({ id: contracts.id })
  return gone.length
}

/** Lists the contracts that are still being worked on but have shown no sign of life for `staleAfterMs`, for the sweep to queue again. */
export async function listStaleContracts(db: Executor, moment: Date, staleAfterMs: number): Promise<string[]> {
  const cutoff = new Date(moment.getTime() - staleAfterMs)
  const rows = await db.select({ id: contracts.id }).from(contracts).where(and(inArray(contracts.state, [...OPEN_STATES]), lt(contracts.updatedAt, cutoff), gt(contracts.expiresAt, moment))).limit(100)
  return rows.map(row => row.id)
}
