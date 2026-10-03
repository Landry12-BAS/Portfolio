// The verifier: the step that decides what the reader may see. A model proposes passages of a
// contract with the rule each goes against; this checks each against the contract's own text and
// keeps only what is really there. Nothing else in the system vouches for a quote.
//
//   - The rule must be one of the playbook's risk rules, and the topic the model named must be that rule's.
//   - The quote is looked for on every page, with spaces, line breaks, hyphens, capitals and accents ignored.
//     A quote that is nowhere in the text is an invented clause: it is dropped and counted, never shown.
//   - A quote shorter than twelve letters or digits proves nothing, and one longer than 1,200 characters
//     is not one passage.
//   - A quote inside a passage that talks to the reviewer is dropped: the contract's instructions to a
//     machine are not a finding about the deal.
//   - Where the quote is found more than once, the occurrence inside the clause the model named is used.
//
// What is kept is the contract's own characters: the citation is the range found in the page's text
// and the quote shown is that text with its line breaks and hyphenation joined. The model's own
// words for the quote are thrown away. The same two-sided check protects a missing clause.
import { findQuoteRanges, foldQuote, LB04_DROP_REASONS, LB04_LIMITS } from '@lb/contracts'
import type { Lb04Citation, Lb04DropReason } from '@lb/contracts'

import type { Playbook, PlaybookRule } from '../playbook/playbook.ts'
import { clauseAt } from './clauses.ts'
import type { Clause } from './clauses.ts'
import { missingRules } from './detect.ts'
import { overlapsPassage } from './screen.ts'
import type { SourceIndex } from './source.ts'

/** One passage a model proposed: the rule it goes against, the topic and clause it names, and the words it quotes. */
export interface Note {
  rule: string
  topic?: string | undefined
  clause?: string | undefined
  quote: string
}

/** A note whose quote was found in the contract. */
export interface VerifiedNote {
  // The note's position in the model's list, from 0.
  position: number
  rule: PlaybookRule
  // The clause number as printed, worked out from where the quote was found, or null.
  clause: string | null
  citation: Lb04Citation
  // The contract's own words at the citation, with line breaks and hyphenation joined.
  quote: string
}

/** How many findings were dropped for each reason. */
export type DropCounts = Record<Lb04DropReason, number>

/** A count of zero for every reason. */
export function noDrops(): DropCounts {
  return Object.fromEntries(LB04_DROP_REASONS.map(reason => [reason, 0])) as DropCounts
}

/** Adds one to the count of a reason. */
function drop(counts: DropCounts, reason: Lb04DropReason): void {
  counts[reason] += 1
}

/** Joins the words a line break or a hyphen cut in two, and collapses white space, so a quote reads as the sentence it is. */
export function readableQuote(source: string): string {
  return source.replaceAll(/(?<=[a-z])-\n(?=[a-z])/g, '').replaceAll(/\s+/g, ' ').trim()
}

/** One place a quote was found. */
interface Occurrence {
  page: number
  start: number
  end: number
}

/** Finds every place a quote occurs, page by page, in order. */
function occurrencesOf(index: SourceIndex, quote: string): Occurrence[] {
  return index.pages.flatMap(page => findQuoteRanges(page.folded, quote).map(range => ({ page: page.page, start: range.start, end: range.end })))
}

/** Chooses which occurrence a finding cites: one inside the named clause when there is one, otherwise the first. */
function chooseOccurrence(occurrences: readonly Occurrence[], clauses: readonly Clause[], named: string | undefined): Occurrence | undefined {
  const inNamed = named === undefined ? undefined : occurrences.find(occurrence => clauseAt(clauses, occurrence.page, occurrence.start)?.number === named.trim())
  return inNamed ?? occurrences[0]
}

/** Everything the checks need to know about the contract and the review so far. */
export interface VerifyContext {
  index: SourceIndex
  clauses: readonly Clause[]
  playbook: Playbook
  // The passages that talk to the reviewer.
  instructions: readonly Lb04Citation[]
}

/** Why a note is not acceptable before its quote is looked for, or undefined when it is. */
function problemWithNote(note: Note, playbook: Playbook): Lb04DropReason | undefined {
  const rule = playbook.rules.get(note.rule)
  if (rule?.kind !== 'risk') return 'unknown_rule'
  if (note.topic !== undefined && note.topic !== rule.topic) return 'topic_mismatch'
  if (note.quote.length > LB04_LIMITS.maxQuoteChars) return 'quote_too_long'
  if (foldQuote(note.quote).length < LB04_LIMITS.minQuoteChars) return 'quote_too_short'
  return undefined
}

/** Tells whether two findings of one rule cite overlapping text. */
function overlaps(a: Lb04Citation, b: Lb04Citation): boolean {
  return a.page === b.page && a.start < b.end && b.start < a.end
}

/**
 * Checks each note against the contract's text and returns the ones that hold, in the order they
 * come in the contract, with a count of the ones dropped and why.
 */
export function verifyNotes(notes: readonly Note[], context: VerifyContext): { kept: VerifiedNote[], drops: DropCounts } {
  const drops = noDrops()
  const kept: VerifiedNote[] = []
  for (const [position, note] of notes.entries()) {
    const problem = problemWithNote(note, context.playbook)
    if (problem !== undefined) {
      drop(drops, problem)
      continue
    }
    const found = occurrencesOf(context.index, note.quote)
    if (found.length === 0) {
      drop(drops, 'quote_not_found')
      continue
    }
    const outside = found.filter(occurrence => !overlapsPassage(context.instructions, occurrence.page, occurrence))
    const chosen = chooseOccurrence(outside, context.clauses, note.clause)
    if (chosen === undefined) {
      drop(drops, 'quote_in_instruction')
      continue
    }
    const citation: Lb04Citation = { page: chosen.page, start: chosen.start, end: chosen.end }
    const rule = context.playbook.rules.get(note.rule) as PlaybookRule
    if (kept.some(earlier => earlier.rule.id === rule.id && overlaps(earlier.citation, citation))) {
      drop(drops, 'duplicate')
      continue
    }
    const source = (context.index.pages.find(page => page.page === chosen.page)?.text ?? '').slice(chosen.start, chosen.end)
    kept.push({ position, rule, clause: clauseAt(context.clauses, chosen.page, chosen.start)?.number ?? null, citation, quote: readableQuote(source) })
  }
  kept.sort((a, b) => a.citation.page - b.citation.page || a.citation.start - b.citation.start)
  return { kept, drops }
}

/** A missing clause that is to be reported, and who found it. */
export interface MissingClause {
  rule: PlaybookRule
  // `model` when the model said it was missing and the text agrees, `detector` when only the check found it.
  source: 'model' | 'detector'
}

/**
 * Decides which missing clauses are reported. The check of the whole text is the authority both ways:
 * a model's claim that a clause is missing is kept only when the text really lacks it, and a clause
 * the text lacks is reported even if the model said nothing. A missing clause that a risk finding
 * on a rule named in `suppressed_by` already covers is not reported twice.
 */
export function decideMissing(claimed: readonly string[], context: VerifyContext, riskRules: ReadonlySet<string>): { missing: MissingClause[], drops: DropCounts } {
  const drops = noDrops()
  const absent = missingRules(context.index, context.playbook)
  const absentIds = new Set(absent.map(rule => rule.id))
  const claims = new Set<string>()
  for (const id of claimed) {
    const rule = context.playbook.rules.get(id)
    if (rule?.kind !== 'required') drop(drops, 'unknown_rule')
    else if (!absentIds.has(id)) drop(drops, 'absent_contradicted')
    else if (claims.has(id)) drop(drops, 'duplicate')
    else claims.add(id)
  }
  const missing: MissingClause[] = []
  for (const rule of absent) {
    if (rule.suppressedBy.some(other => riskRules.has(other))) {
      if (claims.has(rule.id)) drop(drops, 'duplicate')
      continue
    }
    missing.push({ rule, source: claims.has(rule.id) ? 'model' : 'detector' })
  }
  return { missing, drops }
}
