// Running the golden set through a pipeline and grading what comes back. The pipeline is
// anything that turns a description into an outcome: the live one (about one to two
// gateway calls a case, so run it when prompts or routes change), or a fake in a test.
import type { DescribeWorkflow } from '../generate/outcome.ts'
import type { GoldenCase } from './cases.ts'
import { gradeOutcome } from './grade.ts'

/** One case's grade: every rule it broke, and how many gateway calls it cost. */
export interface CaseGrade {
  caseId: string
  kind: GoldenCase['kind']
  failures: string[]
  modelCalls: number
}

/** The grades of one eval run, with the numbers a report needs. */
export interface EvalReport {
  grades: CaseGrade[]
}

/** Tells whether a case met every rule. */
export function passed(grade: CaseGrade): boolean {
  return grade.failures.length === 0
}

/** Returns the share of graded cases that met every rule. */
export function passRate(report: EvalReport): number {
  return report.grades.length === 0 ? 0 : report.grades.filter(passed).length / report.grades.length
}

/** Returns how many gateway calls the run made in all. */
export function totalModelCalls(report: EvalReport): number {
  return report.grades.reduce((total, grade) => total + grade.modelCalls, 0)
}

/** Counts the failures by the check that failed (the words before the first colon), most common first. */
export function failuresByCheck(report: EvalReport): [string, number][] {
  const tally = new Map<string, number>()
  for (const failure of report.grades.flatMap(grade => grade.failures)) {
    const check = failure.split(':', 1)[0] ?? failure
    tally.set(check, (tally.get(check) ?? 0) + 1)
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1])
}

/** How an eval run is paced and which cases it runs. */
export interface EvalOptions {
  // Run only these cases; all of them when absent.
  caseIds?: ReadonlySet<string>
  // Called after each case, so a command can print progress and wait out a rate limit.
  afterCase?: (grade: CaseGrade) => Promise<void>
}

/**
 * Runs the cases one after another through the pipeline and grades each outcome. A
 * pipeline that can't answer (a spent budget, a provider outage) is a failure of that
 * case with the check `unavailable`, never an exception that hides the rest.
 */
export async function evaluate(cases: readonly GoldenCase[], describe: DescribeWorkflow, options: EvalOptions = {}): Promise<EvalReport> {
  const grades: CaseGrade[] = []
  for (const entry of cases) {
    if (options.caseIds && !options.caseIds.has(entry.id)) continue
    let grade: CaseGrade
    try {
      const outcome = await describe(entry.description)
      grade = { caseId: entry.id, kind: entry.kind, failures: gradeOutcome(entry, outcome), modelCalls: outcome.modelCalls }
    }
    catch (error) {
      // Only the error's name: its message could quote the description.
      grade = { caseId: entry.id, kind: entry.kind, failures: [`unavailable: ${error instanceof Error ? error.name : 'unknown error'}`], modelCalls: 0 }
    }
    grades.push(grade)
    await options.afterCase?.(grade)
  }
  return { grades }
}
