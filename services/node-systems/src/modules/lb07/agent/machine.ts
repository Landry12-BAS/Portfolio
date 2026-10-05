// The agent: a state machine in code, not a framework. It asks the model for the whole plan in one call,
// runs the plan step by step in the sandbox's browser, asks the model again only when a step failed (with
// the page's accessibility tree as data, at most twice), runs the final plan once more in the second
// engine, has the model put the findings code made into words, and verifies the generated test by
// running the final plan on the clean shop. Every model answer is checked by a schema; every browser
// action is one step of the closed vocabulary; the model never sees a cookie, a URL or a line of code.
//
// What it costs: the guard (1, for a visitor's own goal), the plan (1, 2 with its repair), at most two
// re-plans (1 each, no repair), the bug reports (1, 2 with its repair): at most 7 model calls, within
// routing.yaml's cap of 8 for lb-07. Browser time: three passes of the plan at most, under one wall clock.
import { LB07_LIMITS, lb07PlanAnswerSchema, lb07ReplanAnswerSchema, lb07ReportAnswerSchema } from '@lb/contracts'
import type { Lb07BugId, Lb07BugReport, Lb07Engine, Lb07FailureCode, Lb07Finding, Lb07State, Lb07Step, Lb07StepStatus, Lb07StepView, Lb07Verification, Lb07VerificationPass } from '@lb/contracts'
import type { Tracer } from '@lb/common'

import type { Runner } from '../runner/client.ts'
import { RunnerError } from '../runner/client.ts'
import type { RunnerFinding, StepOutcome } from '../runner/protocol.ts'
import { askForJson, askOnce, ModelOutputInvalid } from './ask.ts'
import type { JsonModel } from './model.ts'
import { planMessages, replanMessages, reportMessages } from './prompts.ts'
import type { Failure } from './prompts.ts'
import { checkReports, FindingLedger, isBugFinding, verdictOf } from './report.ts'
import { generateTest } from './testgen.ts'
import type { Working } from './working.ts'

/** The injection guard, as the machine asks it. */
export interface Guard {
  check: (text: string) => Promise<{ flagged: boolean, score: number }>
}

/** What the machine logs through: a warning with a label, never a visitor's words. */
export interface MachineLogger {
  warn: (fields: Record<string, unknown>, message: string) => void
}

/** What the machine needs: the browser, the model, the guard, the tracer, the pacing and the clock. */
export interface MachineDeps {
  runner: Runner
  model: JsonModel
  guard: Guard | undefined
  tracer: Tracer
  log: MachineLogger
  // The whole run's browser time, and how the machine waits for a browser another run holds.
  runTimeMs: number
  busyWaitMs: number
  busyWaits: number
  // The shop's origin, for the generated test's comment.
  shopOrigin: string
  now: () => number
}

/** One run's input. */
export interface MachineInput {
  runId: string
  goal: string
  bugs: readonly Lb07BugId[]
  // The signed token that switches the bugs on; the green pass runs without it.
  bugToken: string
  origin: 'sample' | 'custom'
}

/** A piece of evidence the machine made: a screenshot's bytes, or a snapshot's text. */
export interface EvidenceRecord {
  id: string
  kind: 'screenshot' | 'snapshot'
  engine: Lb07Engine
  stepIndex: number | null
  image?: Buffer
  text?: string
}

/** What the machine tells the engine as it goes, so the visitor can follow and a retry can resume. */
export interface MachineHooks {
  onState: (state: Exclude<Lb07State, 'queued' | 'done' | 'failed'>) => Promise<void>
  // The whole step list of the main pass, every time it changes.
  onSteps: (steps: readonly Lb07StepView[]) => Promise<void>
  onFinding: (finding: Lb07Finding) => Promise<void>
  onEvidence: (evidence: EvidenceRecord) => Promise<void>
  save: (working: Working) => Promise<void>
}

/** What a run came to. */
export interface MachineResult {
  reading: string | undefined
  steps: Lb07StepView[]
  findings: Lb07Finding[]
  findingsDropped: number
  finalPlan: Lb07Step[]
  reports: Lb07BugReport[]
  reportsDropped: number
  verification: Lb07Verification
  testSource: string
  engines: Lb07Engine[]
  modelCalls: number
  replans: number
  offOriginRequests: number
  blocked: number
  durationMs: number
}

/** The run ended for a reason that is final and is the run's own: the wall clock, or a plan that was refused. */
export class RunEnded extends Error {
  readonly code: Lb07FailureCode

  constructor(code: Lb07FailureCode, message: string) {
    super(message)
    this.name = 'RunEnded'
    this.code = code
  }
}

// Screenshots of the main pass: one after each step that made a finding, up to this many, and one at the end.
const MAX_STEP_SCREENSHOTS = 3
// A pass is not opened with less browser time than this left.
const MIN_PASS_MS = 5_000

/** How a pass is run. */
interface PassOptions {
  engine: Lb07Engine
  bugToken: string | null
  steps: readonly Lb07Step[]
  // The main pass may re-plan, keeps screenshots and reports its steps to the visitor.
  main: boolean
  // Whether axe runs after each page opened and at the end.
  axe: boolean
}

/** What one pass came to. */
interface PassResult {
  views: Lb07StepView[]
  // The steps that were run and passed or made a finding, in order: the plan as it stood in the end.
  executed: Lb07Step[]
  // Whether the plan was run to its end: no step stopped at the sandbox, and every failed step replaced.
  complete: boolean
  stepsPassed: boolean
  bugFindings: number
  offOriginRequests: number
  blocked: number
  durationMs: number
}

/** Turns a step's outcome into its status. */
function statusOf(outcome: StepOutcome): Lb07StepStatus {
  if (outcome === 'ok') return 'passed'
  if (outcome === 'expectation') return 'finding'
  if (outcome === 'blocked') return 'blocked'
  return 'failed'
}

// What a sentence shown as text has no use for: control and format characters (line breaks, bidirectional overrides,
// zero-width marks) and the line and paragraph separators.
const NOT_PLAIN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/**
 * Makes a model's sentence plain: every character a page has no use for becomes a space, runs of spaces become one,
 * and the ends are trimmed; undefined when nothing is left. The planner's reading is the one sentence a model writes
 * that its schema does not already hold to plain text, and the API refuses to answer with anything else.
 */
export function plainSentence(text: string): string | undefined {
  const plain = text.replaceAll(NOT_PLAIN, ' ').replaceAll(/\s+/g, ' ').trim()
  return plain === '' ? undefined : plain
}

/** Waits for a number of milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Runs the agent for one run. */
export class Agent {
  readonly #deps: MachineDeps
  readonly #input: MachineInput
  readonly #hooks: MachineHooks
  readonly #working: Working
  readonly #ledger = new FindingLedger()
  readonly #startedAt: number
  #evidenceCount = 0
  #replans = 0
  #stepIndex = 0
  #offOrigin = 0
  #blocked = 0

  /** Prepares a run from what an earlier attempt saved. */
  constructor(deps: MachineDeps, input: MachineInput, working: Working, hooks: MachineHooks) {
    this.#deps = deps
    this.#input = input
    this.#hooks = hooks
    this.#working = { ...working }
    this.#startedAt = deps.now()
  }

  /** The browser time left before the wall clock. */
  #remainingMs(): number {
    return this.#startedAt + this.#deps.runTimeMs - this.#deps.now()
  }

  /** Counts model calls and saves the working state. */
  async #paid(calls: number): Promise<void> {
    this.#working.calls += calls
    await this.#hooks.save(this.#working)
  }

  /**
   * Screens a visitor's own goal before any model sees it: the guard is asked once (its verdict is saved, so a later
   * attempt does not pay again), and a goal it flags ends the run as `goal_refused` before the planner is asked. A
   * sample's goal is the owner's and is not asked about. A guard that cannot be reached leaves the goal `unchecked`
   * and the run goes on: the closed vocabulary and the sandbox hold whatever the goal says.
   */
  async #guard(): Promise<void> {
    if (this.#input.origin === 'sample') return
    if (this.#working.guard === undefined) await this.#askGuard()
    const verdict = this.#working.guard
    if (verdict !== undefined && verdict !== 'unchecked' && verdict.flagged) throw new RunEnded('goal_refused', 'The injection guard flagged the goal.')
  }

  /** Asks the guard about the goal, once, and saves what it said. */
  async #askGuard(): Promise<void> {
    await this.#deps.tracer.span('guard the goal', async (span) => {
      if (!this.#deps.guard) {
        span.skip('no guard')
        this.#working.guard = 'unchecked'
        await this.#paid(0)
        return
      }
      try {
        const verdict = await this.#deps.guard.check(this.#input.goal)
        this.#working.guard = { flagged: verdict.flagged, score: Math.round(verdict.score * 10_000) / 10_000 }
        span.set('flagged', verdict.flagged)
        await this.#paid(1)
      }
      catch (error) {
        // The guard is advice here: the closed vocabulary and the sandbox hold the line whatever the goal says.
        span.set('outcome', 'unchecked')
        span.set('error', error instanceof Error ? error.name : 'unknown')
        this.#working.guard = 'unchecked'
        await this.#paid(0)
      }
    })
  }

  /** Asks the model for the whole plan, once (with its one repair). */
  async #plan(): Promise<Lb07Step[]> {
    if (this.#working.plan) return this.#working.plan
    await this.#hooks.onState('planning')
    return this.#deps.tracer.span('plan the test', async (span) => {
      const answer = await askForJson(this.#deps.model, planMessages(this.#input.goal), lb07PlanAnswerSchema)
      span.set('attempts', answer.calls)
      span.set('steps', answer.value.steps.length)
      this.#working.plan = answer.value.steps
      this.#working.reading = plainSentence(answer.value.reading)
      await this.#paid(answer.calls)
      return answer.value.steps
    })
  }

  /** Opens a session, waiting while another run holds the browser, and refusing when the wall clock is nearly spent. */
  async #open(engine: Lb07Engine, bugToken: string | null): Promise<string> {
    for (let waited = 0; ; waited += 1) {
      const remaining = this.#remainingMs()
      if (remaining < MIN_PASS_MS) throw new RunEnded('run_timeout', 'The run has used its browser time.')
      try {
        return await this.#deps.runner.open({ runId: this.#input.runId, engine, bugToken, wallClockMs: Math.min(remaining, LB07_LIMITS.runTimeMs) })
      }
      catch (error) {
        if (!(error instanceof RunnerError) || error.code !== 'busy' || waited >= this.#deps.busyWaits) throw error
        await wait(this.#deps.busyWaitMs)
      }
    }
  }

  /** Keeps a piece of evidence and returns its id. */
  async #evidence(record: Omit<EvidenceRecord, 'id'>): Promise<string> {
    this.#evidenceCount += 1
    const id = `e${this.#evidenceCount}`
    await this.#hooks.onEvidence({ id, ...record })
    return id
  }

  /** Adds the runner's findings to the ledger and tells the engine about each one kept. */
  async #keep(found: readonly RunnerFinding[], evidenceIds: readonly string[]): Promise<void> {
    for (const finding of found) {
      const kept = this.#ledger.add(finding, evidenceIds)
      if (kept) await this.#hooks.onFinding(kept)
    }
  }

  /** Asks the model for the steps that replace a failed step and what followed it. Returns the new steps, or undefined when the model could not say or the budget is spent. */
  async #replan(sessionId: string, failure: Omit<Failure, 'snapshot' | 'path'>): Promise<Lb07Step[] | undefined> {
    if (this.#replans >= LB07_LIMITS.maxReplans) return undefined
    this.#replans += 1
    await this.#hooks.onState('replanning')
    return this.#deps.tracer.span('re-plan after a failed step', async (span) => {
      const page = await this.#deps.runner.snapshot(sessionId)
      span.set('snapshot_chars', page.text.length)
      const answer = await askOnce(this.#deps.model, replanMessages(this.#input.goal, { ...failure, snapshot: page.text, path: page.path }), lb07ReplanAnswerSchema)
      await this.#paid(1)
      span.set('outcome', answer === undefined ? 'unusable' : answer.steps.length === 0 ? 'stop' : 'replaced')
      if (answer) span.set('steps', answer.steps.length)
      await this.#hooks.onState('running')
      return answer?.steps
    })
  }

  /** Runs one pass of a plan in one session. */
  async #pass(options: PassOptions): Promise<PassResult> {
    const passStart = this.#deps.now()
    const sessionId = await this.#open(options.engine, options.bugToken)
    const views: Lb07StepView[] = []
    const executed: Lb07Step[] = []
    let queue = [...options.steps]
    let planNumber = 0
    let screenshots = 0
    let stepsPassed = true
    let complete = true
    const startIndex = this.#stepIndex
    const bugFindingsBefore = this.#ledger.bugFindings

    /** Marks the steps still in the queue as skipped. */
    const skipRest = async (): Promise<void> => {
      for (const step of queue) {
        views.push({ index: this.#stepIndex, step, status: 'skipped', plan: planNumber, durationMs: null, outcome: null })
        this.#stepIndex += 1
      }
      queue = []
      if (options.main) await this.#hooks.onSteps(views)
    }

    try {
      while (queue.length > 0) {
        if (this.#remainingMs() <= 0) throw new RunEnded('run_timeout', 'The run has used its browser time.')
        const step = queue.shift() as Lb07Step
        const view: Lb07StepView = { index: this.#stepIndex, step, status: 'running', plan: planNumber, durationMs: null, outcome: null }
        views.push(view)
        if (options.main) await this.#hooks.onSteps(views)
        const answer = await this.#deps.tracer.span(`step ${step.action}`, async (span) => {
          span.set('index', view.index)
          span.set('engine', options.engine)
          const result = await this.#deps.runner.step(sessionId, view.index, step)
          span.set('outcome', result.outcome)
          span.set('findings', result.findings.length)
          return result
        })
        view.status = statusOf(answer.outcome)
        view.outcome = answer.outcome
        view.durationMs = answer.durationMs
        if (view.status !== 'passed') stepsPassed = false
        let evidenceIds: string[] = []
        if (options.main && answer.findings.length > 0 && screenshots < MAX_STEP_SCREENSHOTS) {
          screenshots += 1
          const shot = await this.#deps.runner.screenshot(sessionId)
          if (shot.base64 !== '') evidenceIds = [await this.#evidence({ kind: 'screenshot', engine: options.engine, stepIndex: view.index, image: Buffer.from(shot.base64, 'base64') })]
        }
        await this.#keep(answer.findings, evidenceIds)
        if (options.axe && step.action === 'goto' && answer.outcome === 'ok') await this.#keep((await this.#deps.runner.axe(sessionId, view.index)).findings, [])
        if (view.status === 'passed' || view.status === 'finding') executed.push(step)
        this.#stepIndex += 1
        if (options.main) await this.#hooks.onSteps(views)
        if (view.status === 'blocked') {
          complete = false
          await skipRest()
          break
        }
        if (view.status === 'failed') {
          const outcome = answer.outcome === 'not_found' || answer.outcome === 'ambiguous' || answer.outcome === 'timeout' ? answer.outcome : 'error'
          const replacement = options.main ? await this.#replan(sessionId, { step, outcome, done: executed, remaining: [step, ...queue] }) : undefined
          if (replacement === undefined || replacement.length === 0) {
            complete = false
            await skipRest()
            break
          }
          planNumber += 1
          queue = [...replacement]
        }
      }
      if (options.axe && executed.length > 0) await this.#keep((await this.#deps.runner.axe(sessionId, null)).findings, [])
      if (options.main) {
        const shot = await this.#deps.runner.screenshot(sessionId)
        if (shot.base64 !== '') await this.#evidence({ kind: 'screenshot', engine: options.engine, stepIndex: null, image: Buffer.from(shot.base64, 'base64') })
        const page = await this.#deps.runner.snapshot(sessionId)
        if (page.text !== '') await this.#evidence({ kind: 'snapshot', engine: options.engine, stepIndex: null, text: page.text })
      }
    }
    catch (error) {
      if (error instanceof RunnerError && error.code === 'expired') {
        await this.#deps.runner.close(sessionId).catch(() => undefined)
        throw new RunEnded('run_timeout', 'The run has used its browser time.')
      }
      await this.#deps.runner.close(sessionId).catch(() => undefined)
      throw error
    }
    const closed = await this.#deps.runner.close(sessionId)
    await this.#keep(closed.findings, [])
    this.#offOrigin += closed.offOriginRequests
    this.#blocked += closed.blocked
    if (this.#stepIndex === startIndex) stepsPassed = false
    if (executed.length === 0) complete = false
    return { views, executed, complete, stepsPassed, bugFindings: this.#ledger.bugFindings - bugFindingsBefore, offOriginRequests: closed.offOriginRequests, blocked: closed.blocked, durationMs: this.#deps.now() - passStart }
  }

  /** Asks the model to put the findings into bug reports, once (with its one repair), and keeps what checks out. */
  async #report(steps: readonly Lb07Step[]): Promise<void> {
    if (this.#working.reports !== undefined) return
    await this.#hooks.onState('reporting')
    const bugFindings = this.#ledger.findings.filter(isBugFinding)
    await this.#deps.tracer.span('write bug reports', async (span) => {
      if (bugFindings.length === 0) {
        span.skip('nothing to report')
        this.#working.reports = []
        this.#working.reportsDropped = 0
        await this.#paid(0)
        return
      }
      try {
        const answer = await askForJson(this.#deps.model, reportMessages(this.#input.goal, steps, bugFindings), lb07ReportAnswerSchema)
        const checked = checkReports(answer.value.reports, this.#ledger.findings)
        span.set('attempts', answer.calls)
        span.set('reports', checked.kept.length)
        span.set('dropped', checked.dropped)
        this.#working.reports = checked.kept
        this.#working.reportsDropped = checked.dropped
        await this.#paid(answer.calls)
      }
      catch (error) {
        if (!(error instanceof ModelOutputInvalid)) throw error
        // The findings stand on their own; the words were the model's to add.
        span.set('attempts', 2)
        span.set('outcome', 'unusable')
        this.#working.reports = []
        this.#working.reportsDropped = 0
        await this.#paid(2)
      }
    })
  }

  /** The verification pass's summary. */
  static #summary(engine: Lb07Engine, bugsOn: boolean, pass: PassResult): Lb07VerificationPass {
    return { engine, bugsOn, stepsPassed: pass.stepsPassed, findings: pass.bugFindings, durationMs: pass.durationMs }
  }

  /** Runs the whole state machine and returns what the run came to. */
  async run(): Promise<MachineResult> {
    await this.#guard()
    const plan = await this.#plan()
    await this.#hooks.onState('running')
    const main = await this.#pass({ engine: 'chromium', bugToken: this.#input.bugToken, steps: plan, main: true, axe: true })
    const finalPlan = main.executed
    // A plan that was not run to its end (a step stopped at the sandbox, or failed and not replaced) proves nothing: no second engine, no green pass, no verdict.
    const complete = main.complete
    const engines: Lb07Engine[] = ['chromium']

    let cross: Lb07VerificationPass | null = null
    if (complete) {
      await this.#hooks.onState('cross_checking')
      await this.#deps.tracer.span('cross-check in the second engine', async (span) => {
        const pass = await this.#pass({ engine: 'firefox-ua', bugToken: this.#input.bugToken, steps: finalPlan, main: false, axe: false })
        cross = Agent.#summary('firefox-ua', true, pass)
        span.set('bug_findings', pass.bugFindings)
        span.set('steps_passed', pass.stepsPassed)
      })
      engines.push('firefox-ua')
    }

    await this.#report(finalPlan.length > 0 ? finalPlan : plan)

    await this.#hooks.onState('verifying')
    let green: Lb07VerificationPass | null = null
    if (complete) {
      await this.#deps.tracer.span('verify the test on the clean shop', async (span) => {
        const pass = await this.#pass({ engine: 'chromium', bugToken: null, steps: finalPlan, main: false, axe: true })
        green = Agent.#summary('chromium', false, pass)
        span.set('steps_passed', pass.stepsPassed)
        span.set('bug_findings', pass.bugFindings)
      })
    }
    const red: Lb07VerificationPass | null = this.#input.bugs.length > 0 && complete ? Agent.#summary('chromium', true, main) : null
    const verdict = verdictOf(this.#input.bugs.length > 0, red, this.#input.bugs.length > 0 ? cross : null, green)
    const testSource = this.#deps.tracer.span('generate the test', (span) => {
      const source = generateTest({ goal: this.#input.goal, steps: finalPlan.length > 0 ? finalPlan : plan, shopOrigin: this.#deps.shopOrigin })
      span.set('verdict', verdict)
      span.set('chars', source.length)
      return source
    })

    return {
      reading: this.#working.reading,
      steps: main.views,
      findings: this.#ledger.findings,
      findingsDropped: this.#ledger.dropped,
      finalPlan,
      reports: this.#working.reports ?? [],
      reportsDropped: this.#working.reportsDropped ?? 0,
      verification: { verdict, red, cross: this.#input.bugs.length > 0 ? cross : null, green },
      testSource: await testSource,
      engines,
      modelCalls: this.#working.calls,
      replans: this.#replans,
      offOriginRequests: this.#offOrigin,
      blocked: this.#blocked,
      durationMs: this.#deps.now() - this.#startedAt,
    }
  }
}

/** Runs the agent for one run. */
export function runAgent(deps: MachineDeps, input: MachineInput, working: Working, hooks: MachineHooks): Promise<MachineResult> {
  return new Agent(deps, input, working, hooks).run()
}
