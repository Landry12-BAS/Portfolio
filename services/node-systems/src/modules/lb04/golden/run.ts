// Running the golden set through the real pipeline and grading what comes back: each seed contract is
// opened by the real extraction (a worker thread over the real PDF), reviewed by the real pipeline,
// and graded against its case. Only the models are replaceable: the live eval command gives it the
// gateway's, and a test gives it scripts, so the grader, the verifier and the extraction are the
// same code in both.
//
// A live run costs at most five model calls a report case, and one more for its redline: about 25
// calls for the whole set. Run it when prompts or routes change, not on every commit.
import { randomUUID } from 'node:crypto'

import type { Lb04Report } from '@lb/contracts'
import type { Tracer } from '@lb/common'

import { ModelOutputInvalid, freshWorking, reviewContract } from '../analysis/pipeline.ts'
import type { Guard } from '../analysis/pipeline.ts'
import type { ReviewModels } from '../analysis/model.ts'
import { proposeRedline } from '../analysis/propose.ts'
import { ExtractionRefused, extractPdf } from '../pdf/extract.ts'
import type { ExtractedPage, ExtractionLimits } from '../pdf/extract.ts'
import type { Playbook } from '../playbook/playbook.ts'
import type { GoldenCase, ReportCase } from './cases.ts'
import { gradeRedline, gradeReport, gradeRefusal } from './grade.ts'
import type { CaseGrade } from './grade.ts'

/** What the run is built from. */
export interface EvalDeps {
  limits: ExtractionLimits
  playbook: Playbook
  tracer: Tracer
  // The models and the guard a case is reviewed with: the gateway's for every case in a live run, scripts per case in a test.
  guardFor: (entry: ReportCase) => Guard | undefined
  modelsFor: (entry: ReportCase) => ReviewModels
  // The bytes of a seed contract, by its id.
  readContract: (id: string) => Uint8Array
  // Runs one case's work inside whatever scope its model calls need (the live command gives each case a run of its own).
  scope?: <Result>(work: () => Promise<Result>) => Promise<Result>
  // Whether to ask for one redline of the first finding a report case plants, and grade it.
  redlines: boolean
}

/** How a run is paced and which cases it runs. */
export interface EvalOptions {
  // Run only these cases; all of them when absent.
  caseIds?: ReadonlySet<string>
  // Called after each case, so a command can print progress and wait out a rate limit.
  afterCase?: (grade: CaseGrade) => Promise<void>
}

/** Runs work as it is, for a run that needs no scope. */
function inPlace<Result>(work: () => Promise<Result>): Promise<Result> {
  return work()
}

/** Writes a grade for a case that could not be run: only the error's name is kept, for its message could quote the contract. */
function unavailable(entry: GoldenCase, error: unknown): CaseGrade {
  const name = error instanceof Error ? error.name : 'unknown error'
  const failure = error instanceof ModelOutputInvalid ? 'analysis: the model\'s answer was not usable, even after its one repair' : `unavailable: ${name}`
  return { caseId: entry.id, kind: entry.kind, failures: [failure], found: 0, planted: entry.kind === 'report' ? entry.planted.length : 0, modelCalls: 0 }
}

/** Asks for one redline of a report's first planted finding and grades it. Returns its failures and the calls it cost. */
async function gradeOneRedline(entry: ReportCase, report: Lb04Report, deps: EvalDeps): Promise<{ failures: string[], calls: number }> {
  const first = entry.planted.map(planted => report.findings.find(finding => finding.kind === 'risk' && finding.rule === planted.rule)).find(finding => finding !== undefined)
  if (!first) return { failures: [], calls: 0 }
  const { redline, calls } = await proposeRedline({ models: deps.modelsFor(entry), playbook: deps.playbook, tracer: deps.tracer }, first)
  return { failures: gradeRedline(redline), calls }
}

/** Reviews one report case's pages and grades the report and, when asked, a redline. */
async function reviewReportCase(entry: ReportCase, pages: readonly ExtractedPage[], deps: EvalDeps): Promise<CaseGrade> {
  const report = await reviewContract(
    { models: deps.modelsFor(entry), guard: deps.guardFor(entry), tracer: deps.tracer, playbook: deps.playbook },
    { contractId: randomUUID(), pages },
    freshWorking(),
    { onState: async () => {}, save: async () => {}, lastAttempt: false },
  )
  const grade = gradeReport(entry, report, pages)
  if (!deps.redlines) return grade
  const redline = await gradeOneRedline(entry, report, deps)
  return { ...grade, failures: [...grade.failures, ...redline.failures], modelCalls: grade.modelCalls + redline.calls }
}

/** Runs one case: opens the contract, and either checks it is refused or reviews it and grades the report. */
async function runCase(entry: GoldenCase, deps: EvalDeps): Promise<CaseGrade> {
  let pages: ExtractedPage[]
  try {
    pages = await extractPdf(deps.readContract(entry.contract), deps.limits)
  }
  catch (error) {
    if (!(error instanceof ExtractionRefused)) throw error
    if (entry.kind === 'refused') return gradeRefusal(entry, error.code, 0)
    return { caseId: entry.id, kind: 'report', failures: [`extraction: the contract was refused as ${error.code}`], found: 0, planted: entry.planted.length, modelCalls: 0 }
  }
  if (entry.kind === 'refused') return gradeRefusal(entry, undefined, 0)
  return reviewReportCase(entry, pages, deps)
}

/**
 * Runs the cases one after another and grades each. A case that can't be run (a spent budget, a
 * provider outage, a model that never answered in the right form) is a failure of that case, never
 * an exception that hides the rest.
 */
export async function evaluate(cases: readonly GoldenCase[], deps: EvalDeps, options: EvalOptions = {}): Promise<CaseGrade[]> {
  const grades: CaseGrade[] = []
  for (const entry of cases) {
    if (options.caseIds && !options.caseIds.has(entry.id)) continue
    const scope = deps.scope ?? inPlace
    let grade: CaseGrade
    try {
      grade = await scope(() => runCase(entry, deps))
    }
    catch (error) {
      grade = unavailable(entry, error)
    }
    grades.push(grade)
    await options.afterCase?.(grade)
  }
  return grades
}
