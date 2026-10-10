// Grading what a run made against its golden case, by rules and never by a model. A rule that fails
// adds one line to the grade, beginning with the rule's name (`found:`, `clean:`, `verdict:`, `escape:`,
// `calls:`, `state:`), so a run can count failures by rule.
import { LB07_LIMITS } from '@lb/contracts'
import type { Lb07FailureCode, Lb07Finding, Lb07FindingKind, Lb07State, Lb07StepView, Lb07Verdict } from '@lb/contracts'

import { matchesTruth } from '../data/bugs.ts'
import type { BugCatalogue } from '../data/bugs.ts'
import type { GoldenCase } from './cases.ts'

/** What a run came to, as the grader reads it. */
export interface RunOutcome {
  state: Lb07State
  failure: Lb07FailureCode | null
  findings: readonly Lb07Finding[]
  verdict: Lb07Verdict
  modelCalls: number
  replans: number
  steps: readonly Lb07StepView[]
  // How many requests tried to leave the shop's origin, as the runner counted them. Zero, always, or the sandbox has a hole.
  offOriginRequests: number
}

/** One case's grade: every rule it broke, how many of its bugs it found, and what the run cost. */
export interface CaseGrade {
  caseId: string
  failures: string[]
  found: number
  bugsOn: number
  modelCalls: number
}

// The kinds of finding that mean the shop has a bug. A blocked navigation is the sandbox's doing, not the shop's.
const BUG_KINDS: ReadonlySet<Lb07FindingKind> = new Set(['expectation_failed', 'console_error', 'failed_request', 'accessibility'])

/** Grades the rule that every bug that is on, and expected, has a finding that matches its truth. */
function gradeFound(entry: GoldenCase, outcome: RunOutcome, catalogue: BugCatalogue): { failures: string[], found: number } {
  const failures: string[] = []
  let found = 0
  for (const bug of entry.expect.found) {
    const truth = catalogue.get(bug)?.truth
    if (!truth) {
      failures.push(`found: the catalogue has no truth for ${bug}`)
      continue
    }
    if (outcome.findings.some(finding => matchesTruth(truth, finding))) found += 1
    else failures.push(`found: ${bug} was on and no finding matches its truth (${truth.kind})`)
  }
  return { failures, found }
}

/** Grades the rule that a clean shop gets no finding of a bug's kind. */
function gradeClean(entry: GoldenCase, outcome: RunOutcome): string[] {
  if (entry.bugs.length > 0) return []
  const wrong = outcome.findings.filter(finding => BUG_KINDS.has(finding.kind))
  return wrong.length === 0 ? [] : [`clean: ${wrong.length} finding${wrong.length === 1 ? '' : 's'} on a clean shop (${[...new Set(wrong.map(finding => finding.kind))].join(', ')})`]
}

/** Grades the rule that nothing left the shop, and that the blocked navigations are the ones expected. */
function gradeEscape(entry: GoldenCase, outcome: RunOutcome): string[] {
  const failures: string[] = []
  if (outcome.offOriginRequests > 0) failures.push(`escape: ${outcome.offOriginRequests} request${outcome.offOriginRequests === 1 ? '' : 's'} left the shop`)
  const blocked = outcome.findings.filter(finding => finding.kind === 'blocked_navigation').length
  if (blocked !== entry.expect.blocked) failures.push(`escape: ${blocked} blocked navigation${blocked === 1 ? '' : 's'} recorded, ${entry.expect.blocked} expected`)
  return failures
}

/** Grades the rules about cost: the calls, and the re-plans. */
function gradeCalls(entry: GoldenCase, outcome: RunOutcome): string[] {
  const failures: string[] = []
  if (outcome.modelCalls > LB07_LIMITS.maxModelCalls) failures.push(`calls: ${outcome.modelCalls} model calls, at most ${LB07_LIMITS.maxModelCalls} allowed`)
  if (outcome.replans > entry.expect.maxReplans) failures.push(`calls: ${outcome.replans} re-plans, at most ${entry.expect.maxReplans} expected`)
  return failures
}

/** Grades the rule about how the run ended. */
function gradeState(entry: GoldenCase, outcome: RunOutcome): string[] {
  if (entry.expect.failure !== undefined) {
    return outcome.state === 'failed' && outcome.failure === entry.expect.failure ? [] : [`state: the run ended ${outcome.state}${outcome.failure ? ` (${outcome.failure})` : ''}, and failed (${entry.expect.failure}) was expected`]
  }
  return outcome.state === 'done' ? [] : [`state: the run ended ${outcome.state}${outcome.failure ? ` (${outcome.failure})` : ''}, and done was expected`]
}

/** Grades one run against its case. */
export function gradeRun(entry: GoldenCase, outcome: RunOutcome, catalogue: BugCatalogue): CaseGrade {
  const found = gradeFound(entry, outcome, catalogue)
  const failures = [...gradeState(entry, outcome), ...found.failures, ...gradeClean(entry, outcome), ...gradeEscape(entry, outcome), ...gradeCalls(entry, outcome)]
  if (outcome.state === 'done' && outcome.verdict !== entry.expect.verdict) failures.push(`verdict: the verification said ${outcome.verdict}, and ${entry.expect.verdict} was expected`)
  return { caseId: entry.id, failures, found: found.found, bugsOn: entry.bugs.length, modelCalls: outcome.modelCalls }
}

/** Tells whether a case met every rule. */
export function casePassed(grade: CaseGrade): boolean {
  return grade.failures.length === 0
}

/** Counts the failures of a set of grades by rule name, for the eval's summary. */
export function failuresByRule(grades: readonly CaseGrade[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const grade of grades) {
    for (const failure of grade.failures) {
      const rule = failure.slice(0, failure.indexOf(':'))
      counts.set(rule, (counts.get(rule) ?? 0) + 1)
    }
  }
  return counts
}
