// Running the golden set through the real agent and grading what comes back. Only the model and the browser
// are replaceable: the live eval command gives the gateway's model and the real sandbox, and a test gives
// scripts, so the state machine, the report rules, the test generator and the grader are the same code in
// both. A live run costs at most seven model calls a case: about 77 for the whole set.
import { createRun, runScope } from '@lb/common'
import type { Tracer } from '@lb/common'
import type { Lb07BugId } from '@lb/contracts'

import { runAgent } from '../agent/machine.ts'
import type { Guard, MachineHooks, MachineLogger } from '../agent/machine.ts'
import { ModelOutputInvalid } from '../agent/ask.ts'
import type { JsonModel } from '../agent/model.ts'
import { freshWorking } from '../agent/working.ts'
import type { BugCatalogue } from '../data/bugs.ts'
import type { Runner } from '../runner/client.ts'
import type { GoldenCase } from './cases.ts'
import { gradeRun } from './grade.ts'
import type { CaseGrade } from './grade.ts'

/** What the run is built from. */
export interface EvalDeps {
  catalogue: BugCatalogue
  tracer: Tracer
  log: MachineLogger
  runner: Runner
  guard: Guard | undefined
  shopOrigin: string
  // The model a case is planned with: the gateway's for every case in a live run, a script per case in a test.
  modelFor: (entry: GoldenCase) => JsonModel
  // Signs the bug token of a case's run.
  signToken: (runId: string, bugs: readonly Lb07BugId[]) => string
  runTimeMs: number
}

/** How a run is paced and which cases it runs. */
export interface EvalOptions {
  caseIds?: ReadonlySet<string>
  afterCase?: (grade: CaseGrade) => Promise<void>
}

const quiet: MachineHooks = { onState: async () => {}, onSteps: async () => {}, onFinding: async () => {}, onEvidence: async () => {}, save: async () => {} }

/** Writes a grade for a case that could not be run: only the error's name is kept. */
function unavailable(entry: GoldenCase, error: unknown): CaseGrade {
  const name = error instanceof Error ? error.name : 'unknown error'
  const failure = error instanceof ModelOutputInvalid ? 'plan: the model\'s answer was not usable, even after its one repair' : `unavailable: ${name}`
  return { caseId: entry.id, failures: [failure], found: 0, bugsOn: entry.bugs.length, modelCalls: 0 }
}

/** Runs one case through the agent, in a run of its own over synthetic data, and grades it. */
export async function evaluateCase(entry: GoldenCase, deps: EvalDeps): Promise<CaseGrade> {
  const runId = `eval-lb07-${entry.id}`.slice(0, 60)
  try {
    const result = await runScope(createRun({ system: 'lb-07', runId, dataClass: 'synthetic' }), () => runAgent(
      { runner: deps.runner, model: deps.modelFor(entry), guard: deps.guard, tracer: deps.tracer, log: deps.log, runTimeMs: deps.runTimeMs, busyWaitMs: 2_000, busyWaits: 90, shopOrigin: deps.shopOrigin, now: () => Date.now() },
      { runId, goal: entry.goal, bugs: entry.bugs, bugToken: deps.signToken(runId, entry.bugs), origin: 'custom' },
      freshWorking(),
      quiet,
    ))
    return gradeRun(entry, { state: 'done', failure: null, findings: result.findings, verdict: result.verification.verdict, modelCalls: result.modelCalls, replans: result.replans, steps: result.steps, offOriginRequests: result.offOriginRequests }, deps.catalogue)
  }
  catch (error) {
    return unavailable(entry, error)
  }
}

/** Runs the chosen cases one after another and returns their grades. */
export async function evaluate(cases: readonly GoldenCase[], deps: EvalDeps, options: EvalOptions = {}): Promise<CaseGrade[]> {
  const grades: CaseGrade[] = []
  for (const entry of cases) {
    if (options.caseIds && !options.caseIds.has(entry.id)) continue
    const grade = await evaluateCase(entry, deps)
    grades.push(grade)
    if (options.afterCase) await options.afterCase(grade)
  }
  return grades
}
