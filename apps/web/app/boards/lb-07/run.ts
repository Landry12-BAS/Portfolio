// What the board works out from a run as the service shows it: the stage it is in and the stepper drawn
// from it, the plans its steps came from (the first, then a re-plan for each step that failed), whether a
// failure gave the visitor's run back, which pieces of evidence a finished run has, and how long it has
// been in the browser. Nothing here guesses: every stage is the service's state, every count the service's
// own, and a stage the run did not go through (the second engine and the clean shop, when the plan was not
// run to its end) is said to be skipped only when the run's own steps or report show it.
import type { Lb07Engine, Lb07FailureCode, Lb07Report, Lb07RunView, Lb07State, Lb07StepView } from '@lb/contracts'

/** The stages of a run, in order, as the stepper names them. */
export const STAGES = ['queue', 'plan', 'run', 'cross', 'report', 'verify', 'done'] as const
/** One stage of a run. */
export type Stage = (typeof STAGES)[number]
/** Where a stage stands for a run. */
export type StageStatus = 'done' | 'current' | 'waiting' | 'failed' | 'skipped'

/** The stage each state of a running run is in. */
const STAGE_OF_STATE: Readonly<Record<Exclude<Lb07State, 'failed'>, Stage>> = {
  queued: 'queue',
  planning: 'plan',
  running: 'run',
  replanning: 'run',
  cross_checking: 'cross',
  reporting: 'report',
  verifying: 'verify',
  done: 'done',
}

/**
 * The failures after which the service gives the visitor's run for the day back: the system's fault, not the
 * run's (services/node-systems/src/modules/lb07/engine/failures.ts, `REFUNDED`). A test checks this list
 * against the mock back end's, which a test of the mock checks against the service's.
 */
export const GIVEN_BACK: ReadonlySet<Lb07FailureCode> = new Set(['planning_unavailable', 'runner_unavailable', 'plan_invalid', 'internal'])

/** Tells whether a state is the end of a run. */
export function isOver(state: Lb07State): boolean {
  return state === 'done' || state === 'failed'
}

/** The stage a failed run stopped in, from why it failed. */
export function failedStage(run: Pick<Lb07RunView, 'failure' | 'steps'>): Stage {
  switch (run.failure?.code) {
    case 'goal_refused': return 'queue'
    case 'planning_unavailable':
    case 'plan_invalid':
    case 'plan_refused':
      return 'plan'
    case 'runner_unavailable':
    case 'run_timeout':
      return 'run'
    default: return run.steps.length > 0 ? 'run' : 'plan'
  }
}

/**
 * Tells whether the main pass ran the plan to its end, which is what lets the second engine and the clean
 * shop run: no step stopped at the sandbox or skipped, the last step not a failure that was not replaced,
 * and at least one step that did something. The report says it for certain (no green pass); the steps
 * say it while the run goes.
 */
export function planCompleted(steps: readonly Lb07StepView[], report?: Pick<Lb07Report, 'verification'>): boolean {
  if (report) return report.verification.green !== null
  if (steps.length === 0) return false
  if (steps.some(step => step.status === 'blocked' || step.status === 'skipped')) return false
  if (steps.at(-1)?.status === 'failed') return false
  return steps.some(step => step.status === 'passed' || step.status === 'finding')
}

/** Tells whether a run is past its main pass with a plan that was not run to its end, so the second engine and the clean shop will not run. */
export function skipsChecks(run: Pick<Lb07RunView, 'state' | 'steps'>, report?: Pick<Lb07Report, 'verification'>): boolean {
  if (run.state === 'failed') return false
  return STAGES.indexOf(STAGE_OF_STATE[run.state]) > STAGES.indexOf('run') && !planCompleted(run.steps, report)
}

/** The stepper of a run: each stage and where it stands. */
export function stepperOf(run: Pick<Lb07RunView, 'state' | 'failure' | 'steps'>, report?: Pick<Lb07Report, 'verification'>): { stage: Stage, status: StageStatus }[] {
  if (run.state === 'failed') {
    const stopped = STAGES.indexOf(failedStage(run))
    return STAGES.map((stage, index) => ({ stage, status: index < stopped ? 'done' : index === stopped ? 'failed' : 'skipped' }))
  }
  const current = STAGES.indexOf(STAGE_OF_STATE[run.state])
  const skipped = skipsChecks(run, report)
  return STAGES.map((stage, index) => {
    if (skipped && (stage === 'cross' || stage === 'verify')) return { stage, status: 'skipped' }
    if (run.state === 'done' || index < current) return { stage, status: 'done' }
    return { stage, status: index === current ? 'current' : 'waiting' }
  })
}

/** One plan's steps: the first plan, or a re-plan with the step whose failure asked for it. */
export interface PlanGroup {
  plan: number
  // The number (from 1) of the step that failed and made the agent re-plan; null for the first plan.
  after: number | null
  steps: Lb07StepView[]
}

/** Groups a run's steps by the plan they came from, in order. */
export function planGroups(steps: readonly Lb07StepView[]): PlanGroup[] {
  const groups: PlanGroup[] = []
  for (const step of steps) {
    const last = groups.at(-1)
    if (last && last.plan === step.plan) {
      last.steps.push(step)
      continue
    }
    const failed = last?.steps.findLast(candidate => candidate.status === 'failed')
    groups.push({ plan: step.plan, after: last === undefined ? null : (failed === undefined ? null : failed.index + 1), steps: [step] })
  }
  return groups
}

/** A piece of evidence a finished run has, as the board knows it before reading it. */
export interface EvidenceRef {
  id: string
  // The step it was taken after, the engine and the page, from the finding that names it; unknown for the run's closing pieces.
  stepIndex: number | null
  engine: Lb07Engine | null
  path: string | null
}

/** The number of an evidence id such as `e3`. */
export function evidenceNumber(id: string): number {
  return Number(id.slice(1))
}

/**
 * The evidence of a finished run. The service has no list of it, but numbers it as it keeps it: the
 * screenshots taken after steps that made a finding come first, and the findings name them; then the run
 * keeps a screenshot and the page's tree at its end, the next two numbers, which no finding names.
 */
export function evidenceRefs(report: Pick<Lb07Report, 'findings'>): { named: EvidenceRef[], closing: string[] } {
  const named = new Map<string, EvidenceRef>()
  for (const finding of report.findings) {
    for (const id of finding.evidenceIds) {
      if (!named.has(id)) named.set(id, { id, stepIndex: finding.stepIndex, engine: finding.engine, path: finding.path })
    }
  }
  const ordered = [...named.values()].sort((a, b) => evidenceNumber(a.id) - evidenceNumber(b.id))
  const highest = ordered.reduce((most, ref) => Math.max(most, evidenceNumber(ref.id)), 0)
  const closing = [highest + 1, highest + 2].filter(number => number <= 999).map(number => `e${number}`)
  return { named: ordered, closing }
}

/** How long a run has been in the browser, in whole seconds: from its start to its end, or to now while it goes. Undefined before it starts. */
export function secondsRun(run: Pick<Lb07RunView, 'startedAt' | 'endedAt'>, now: number): number | undefined {
  if (run.startedAt === null) return undefined
  const end = run.endedAt === null ? now : Date.parse(run.endedAt)
  return Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1_000))
}
