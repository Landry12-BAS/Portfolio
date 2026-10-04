// The review of one contract, from its extracted pages to its report.
//
//   1. split     clauses, by their numbers (code)
//   2. screen    the passages that talk to a reviewer (code), and the guard model's verdict on them (1 call)
//   3. analyse   the long-document model reads the clauses, less the passages the screen found, against the playbook and quotes what it finds (1 call, 2 with its repair)
//   4. verify    every quote is checked against the contract's text, and missing clauses against the whole text (code)
//   5. report    the reasoning model rates each verified finding and says why it matters (1 call, 2 with its repair)
//   6. assemble  the report and the radar, by code: nothing a model wrote is shown unless step 4 kept it
//
// That is at most five model calls, with the redlines (one call each, at most three) making eight. The
// model's answers are checked against schemas, each gets one repair and never a second, and the
// step that decides what the reader sees is the verifier. Every result that cost a call is saved as
// it arrives (`Working`), so a retry after a failure resumes where the job stopped and never pays
// twice for an answer it already has.
//
// The pipeline runs inside the review's run (`runScope`), so the gateway labels each call with the
// contract's run, and every step is a span of the run: names, counts and labels, never the contract's words.
import { NOT_LEGAL_ADVICE } from '@lb/contracts'
import type { Lb04Citation, Lb04Report, Lb04Screen } from '@lb/contracts'
import type { Tracer } from '@lb/common'
import { z } from 'zod'
import type { ZodType } from 'zod'

import type { Playbook } from '../playbook/playbook.ts'
import { analysisAnswerSchema, reportAnswerSchema } from './answers.ts'
import type { ReportAnswer } from './answers.ts'
import { splitClauses } from './clauses.ts'
import type { PageInput } from './clauses.ts'
import { ALIASES } from './model.ts'
import type { JsonModel, ModelReply, PromptMessage, ReviewModels } from './model.ts'
import { analysisMessages, MAX_ECHO_CHARS, reportMessages, repairMessages } from './prompts.ts'
import { buildReport } from './report.ts'
import { findInstructionPassages, guardInput } from './screen.ts'
import { buildSourceIndex } from './source.ts'
import { decideMissing, noDrops, verifyNotes } from './verify.ts'
import type { DropCounts, MissingClause } from './verify.ts'

/** The guard: whether a text looks like a prompt injection. In production, the gateway's `lb-guard`. */
export interface Guard {
  check: (text: string) => Promise<{ flagged: boolean, score: number }>
}

/** What the pipeline is built from. */
export interface ReviewDeps {
  models: ReviewModels
  // Without a guard (a service with no gateway), the screen says `unchecked`, and the review goes on: what a contract says to a reviewer is held by the verifier whatever the guard says.
  guard: Guard | undefined
  tracer: Tracer
  playbook: Playbook
}

/**
 * What the review has worked out so far and paid for, saved after each model call so a retry resumes
 * where the job stopped. It is read back from the database with this schema, so a record that doesn't
 * fit (an older shape, a damaged row) is refused and the review starts again, rather than trusted.
 */
export const workingSchema = z.object({
  // What the guard said, so a retry doesn't ask again. `null` means it could not be asked.
  screen: z.object({ flagged: z.boolean().nullable(), score: z.number().min(0).max(1).nullable() }).optional(),
  notes: analysisAnswerSchema.optional(),
  // The second model's answer, or `unusable` when it failed its schema even after the repair and the playbook's own severities are used.
  calibration: z.union([z.literal('unusable'), reportAnswerSchema]).optional(),
  // The model calls made so far.
  calls: z.int().min(0).max(20),
})

/** What the review has worked out so far and paid for. */
export type Working = z.infer<typeof workingSchema>

/** What the guard said, saved so a retry doesn't ask again. `null` means it could not be asked. */
export type SavedScreen = NonNullable<Working['screen']>

/** What the engine lets the pipeline tell it. */
export interface ReviewHooks {
  // The review has moved on to a state the visitor sees.
  onState: (state: 'analysing' | 'verifying') => Promise<void>
  // Working has changed and should be saved.
  save: (working: Working) => Promise<void>
  // True on the last attempt the job gets: the second model's failure is then not worth failing the whole review for.
  lastAttempt: boolean
}

/** A model answered, but not in a form the schema accepts, even after its one repair. */
export class ModelOutputInvalid extends Error {
  constructor() {
    super('The model\'s answer was not usable after its one repair.')
    this.name = 'ModelOutputInvalid'
  }
}

/** Reads what a model replied against a schema: the value, or the problems, never the values that were wrong. */
export function readReply<Value>(reply: ModelReply, schema: ZodType<Value>): { value: Value } | { problems: string[] } {
  if (reply.kind === 'text') return { problems: ['The reply was not a JSON object.'] }
  const parsed = schema.safeParse(reply.value)
  if (parsed.success) return { value: parsed.data }
  return { problems: parsed.error.issues.map(issue => `${issue.path.join('.') || '(reply)'}: ${issue.message}`) }
}

/**
 * Asks a model for a JSON answer that fits a schema. A reply that doesn't fit is sent back once with
 * what was wrong, and a second that doesn't fit is final. Returns the value and how many calls it took (one or two).
 */
export async function askForJson<Value>(model: JsonModel, base: readonly PromptMessage[], schema: ZodType<Value>, echoLimit: number): Promise<{ value: Value, calls: number }> {
  const first = await model.ask(base)
  const firstRead = readReply(first, schema)
  if ('value' in firstRead) return { value: firstRead.value, calls: 1 }
  const second = await model.ask(repairMessages(base, first, firstRead.problems, echoLimit))
  const secondRead = readReply(second, schema)
  if ('value' in secondRead) return { value: secondRead.value, calls: 2 }
  throw new ModelOutputInvalid()
}

/** Asks the guard about the passages (or the opening), and reports it as unchecked when it can't be asked. */
async function screenContract(deps: ReviewDeps, text: string): Promise<SavedScreen> {
  return deps.tracer.span('screen for injection', async (span) => {
    if (!deps.guard) {
      span.skip('no guard')
      return { flagged: null, score: null }
    }
    try {
      const verdict = await deps.guard.check(text)
      span.set('flagged', verdict.flagged)
      span.set('score', Math.round(verdict.score * 10_000) / 10_000)
      return { flagged: verdict.flagged, score: verdict.score }
    }
    catch (error) {
      // The guard fails closed: no readable verdict means the text counts as unchecked, and the review goes on, held by the verifier.
      span.set('flagged', false)
      span.set('outcome', 'unchecked')
      span.set('error', error instanceof Error ? error.name : 'unknown')
      return { flagged: null, score: null }
    }
  })
}

// The most passages the report shows; it counts the rest.
const SHOWN_PASSAGES = 8

/** Turns what the guard said and the passages the phrases found into the screen the report carries. */
function screenOf(saved: SavedScreen, passages: readonly Lb04Citation[]): Lb04Screen {
  const shown = passages.slice(0, SHOWN_PASSAGES)
  if (saved.flagged === null) return { verdict: passages.length > 0 ? 'flagged' : 'unchecked', guardScore: null, passages: shown, passageCount: passages.length }
  return { verdict: saved.flagged || passages.length > 0 ? 'flagged' : 'clean', guardScore: saved.score, passages: shown, passageCount: passages.length }
}

/** Adds the counts of two sets of dropped findings. */
function sumDrops(a: DropCounts, b: DropCounts): DropCounts {
  const total = noDrops()
  for (const reason of Object.keys(total) as (keyof DropCounts)[]) total[reason] = a[reason] + b[reason]
  return total
}

/** Asks the second model to rate the verified findings, within a span. Returns undefined when its answer can't be used, and throws for a model that can't be reached. */
async function calibrate(deps: ReviewDeps, notes: Parameters<typeof reportMessages>[0], missing: Parameters<typeof reportMessages>[1], working: Working, hooks: ReviewHooks): Promise<ReportAnswer | undefined> {
  if (working.calibration !== undefined) return working.calibration === 'unusable' ? undefined : working.calibration
  if (notes.length === 0 && missing.length === 0) return undefined
  return deps.tracer.span('structured report', async (span) => {
    try {
      const answer = await askForJson(deps.models.reason, reportMessages(notes, missing), reportAnswerSchema, MAX_ECHO_CHARS.reason)
      working.calls += answer.calls
      working.calibration = answer.value
      span.set('attempts', answer.calls)
      span.set('rated', answer.value.findings.length + answer.value.missing.length)
      await hooks.save(working)
      return answer.value
    }
    catch (error) {
      if (error instanceof ModelOutputInvalid) {
        // Two answers in the wrong form: the playbook's own severities and wording stand in, and the job does not retry what retrying won't fix.
        working.calls += 2
        working.calibration = 'unusable'
        span.set('attempts', 2)
        span.set('outcome', 'unusable')
        await hooks.save(working)
        return undefined
      }
      if (hooks.lastAttempt) {
        span.set('outcome', 'unavailable')
        return undefined
      }
      throw error
    }
  }, { attrs: { alias: ALIASES.reason } })
}

/**
 * Reviews a contract. `working` holds what an earlier attempt already paid for, and is updated and saved
 * as the review goes on. Throws what the gateway throws (the engine decides whether to retry),
 * `ModelOutputInvalid` when the first model's answer can't be used, and nothing else the visitor's file could cause.
 */
export async function reviewContract(deps: ReviewDeps, input: { contractId: string, pages: readonly PageInput[] }, working: Working, hooks: ReviewHooks): Promise<Lb04Report> {
  const index = buildSourceIndex(input.pages)
  const clauses = await deps.tracer.span('split clauses', (span) => {
    const found = splitClauses(input.pages)
    span.set('clauses', found.length)
    span.set('numbered', found.filter(clause => clause.number !== null).length)
    return found
  })
  const passages = findInstructionPassages(index)

  await hooks.onState('analysing')
  if (working.screen === undefined) {
    working.screen = await screenContract(deps, guardInput(index, passages))
    working.calls += working.screen.flagged === null ? 0 : 1
    await hooks.save(working)
  }
  if (working.notes === undefined) {
    working.notes = await deps.tracer.span('cited analysis', async (span) => {
      const answer = await askForJson(deps.models.long, analysisMessages(deps.playbook, clauses, passages), analysisAnswerSchema, MAX_ECHO_CHARS.long)
      working.calls += answer.calls
      span.set('attempts', answer.calls)
      span.set('notes', answer.value.notes.length)
      span.set('missing', answer.value.missing.length)
      return answer.value
    }, { attrs: { alias: ALIASES.long } })
    await hooks.save(working)
  }

  await hooks.onState('verifying')
  const context = { index, clauses, playbook: deps.playbook, instructions: passages }
  const verified = await deps.tracer.span('verify quotes', (span) => {
    const notes = verifyNotes(working.notes?.notes ?? [], context)
    const riskRules = new Set(notes.kept.map(note => note.rule.id))
    const missing = decideMissing(working.notes?.missing ?? [], context, riskRules)
    const drops = sumDrops(notes.drops, missing.drops)
    span.set('kept', notes.kept.length + missing.missing.length)
    span.set('dropped', Object.values(drops).reduce((total, count) => total + count, 0))
    for (const [reason, count] of Object.entries(drops)) if (count > 0) span.set(`dropped_${reason}`, count)
    return { notes: notes.kept, missing: missing.missing, drops }
  })
  const calibration = await calibrate(deps, verified.notes, verified.missing.map((entry: MissingClause) => entry.rule), working, hooks)

  return deps.tracer.span('assemble report', (span) => {
    const report = buildReport({
      contractId: input.contractId,
      playbook: deps.playbook,
      notes: verified.notes,
      missing: verified.missing,
      calibration,
      screen: screenOf(working.screen ?? { flagged: null, score: null }, passages),
      drops: verified.drops,
      calls: working.calls,
    })
    span.set('findings', report.findings.length)
    span.set('screen', report.screen.verdict)
    span.set('calibrated', report.calibrated)
    return report
  })
}

/** What a review that did not run yet looks like. */
export function freshWorking(): Working {
  return { calls: 0 }
}

/** The label every report carries, re-exported so the engine and the routes need only this module. */
export const REPORT_LABEL = NOT_LEGAL_ADVICE
