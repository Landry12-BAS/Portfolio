// What the board says about the validation checks. The service runs eleven checks, in a fixed order, and
// reports for each one its verdict, the numbers that disagree and the paths of the fields it is about.
// It also writes an English sentence, which is for someone reading the API: the board writes its own, in
// the visitor's language, from the check's name and those numbers. This file picks the sentence and its
// numbers; the words are in the locale files.
import { CHECK_IDS } from './schemas'
import type { Check, CheckId } from './schemas'

import { rowNumber } from './fields'

/** The sentence a failed check is told in: a locale key under `lb03.checks.failed`, and the values it takes. */
export interface CheckSentence {
  key: string
  values: Record<string, string | number>
}

/** What a list of checks comes to. */
export interface CheckTally {
  passed: number
  // Failed checks that stop an export (errors), and failed checks that only ask for a look (warnings).
  errors: number
  warnings: number
  skipped: number
}

// What the `dates_valid` check says it expected, when it faults an issue date: the date must be on or before
// the day the document is judged on, or on or after 1 January 2000. The service writes both in English, so
// the board reads the date out of them and says the rest in its own words.
const NOT_AFTER = /^on or before (\d{4}-\d{2}-\d{2})$/
const NOT_BEFORE = /^(\d{4}-\d{2}-\d{2}) or later$/

/** Puts the checks in the order the service runs them, which is the order the board lists them in. */
export function inCheckOrder(checks: readonly Check[]): Check[] {
  return checks.toSorted((a, b) => CHECK_IDS.indexOf(a.id) - CHECK_IDS.indexOf(b.id))
}

/** Counts the checks by what became of them. */
export function tally(checks: readonly Check[]): CheckTally {
  const count: CheckTally = { passed: 0, errors: 0, warnings: 0, skipped: 0 }
  for (const check of checks) {
    if (check.status === 'passed') count.passed += 1
    else if (check.status === 'skipped') count.skipped += 1
    else if (check.severity === 'error') count.errors += 1
    else count.warnings += 1
  }
  return count
}

/** Tells whether a check failed in a way that stops the export. */
export function stopsExport(check: Check): boolean {
  return check.status === 'failed' && check.severity === 'error'
}

/** Reads the number of the line or VAT line a check faults, from the first field it names. */
function rowOf(check: Check): number {
  return rowNumber(check.fields[0] ?? '') ?? 1
}

/** Picks which total the lines or the VAT bases were compared with: the subtotal, or the total when the prices include VAT. */
function targetOf(check: Check): 'subtotal' | 'total' {
  return check.fields[0] === 'total' ? 'total' : 'subtotal'
}

/** Picks the sentence for a failed date check. A date check that says something unexpected gets the plain one. */
function dateSentence(check: Check): CheckSentence {
  const actual = check.actual ?? ''
  if (check.fields[0] === 'due_date') return { key: 'lb03.checks.failed.dates_valid.due', values: { actual } }
  const after = NOT_AFTER.exec(check.expected ?? '')?.[1]
  if (after !== undefined) return { key: 'lb03.checks.failed.dates_valid.future', values: { actual, limit: after } }
  const before = NOT_BEFORE.exec(check.expected ?? '')?.[1]
  if (before !== undefined) return { key: 'lb03.checks.failed.dates_valid.early', values: { actual, limit: before } }
  return { key: 'lb03.checks.failed.dates_valid.other', values: { actual } }
}

/**
 * Chooses the sentence that tells a failed check, with the numbers it was found with. The numbers are
 * decimal strings from the service (code worked them out, never the model), shown as they are. A check
 * that is not failed has no such sentence: its status says everything.
 */
export function sentenceFor(check: Check): CheckSentence {
  const expected = check.expected ?? ''
  const actual = check.actual ?? ''
  const id: CheckId = check.id
  switch (id) {
    case 'required_fields':
      return { key: 'lb03.checks.failed.required_fields', values: { count: check.fields.length } }
    case 'dates_valid':
      return dateSentence(check)
    case 'currency_known':
      return { key: 'lb03.checks.failed.currency_known', values: { actual, allowed: expected } }
    case 'signs_agree':
      return { key: 'lb03.checks.failed.signs_agree', values: {} }
    case 'line_math':
      return { key: 'lb03.checks.failed.line_math', values: { line: rowOf(check), expected, actual } }
    case 'line_items_sum':
      return { key: `lb03.checks.failed.line_items_sum.${targetOf(check)}`, values: { expected, actual } }
    case 'vat_math':
      return { key: 'lb03.checks.failed.vat_math', values: { line: rowOf(check), expected, actual } }
    case 'vat_bases':
      return { key: `lb03.checks.failed.vat_bases.${targetOf(check)}`, values: { expected, actual } }
    case 'total_reconciles':
      return { key: 'lb03.checks.failed.total_reconciles', values: { expected, actual } }
    case 'fields_on_page':
      return { key: 'lb03.checks.failed.fields_on_page', values: { count: check.fields.length } }
    case 'not_duplicate':
      return { key: 'lb03.checks.failed.not_duplicate', values: {} }
  }
}
