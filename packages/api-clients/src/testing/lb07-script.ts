// How the mock back end's LB-07 works out a whole run the moment it is started: the same state machine as
// the service's agent (services/node-systems/src/modules/lb07/agent/machine.ts) played over the mock shop
// in beats, with the stand-in planner, so what a visitor polls is a run that unfolds as the real one does.
// The guard for a visitor's own goal, the one plan, the main pass in Chromium step by step (a screenshot
// after each step that made a finding, three at most, and one with the page's tree at the end), a re-plan
// for each step that failed (two at most), the second engine (Chromium wearing Firefox's user agent), the
// bug reports, the clean shop, the verdict and the generated test. The findings are kept by the service's
// own ledger, the verdict is the service's own rule and the test is written by the service's own
// template, so those three are exactly what the real service would show. A failure a test asks for ends
// the run where the real one would end it.
//
// A script is counted in beats: the run's owner turns beats into time (`tickMs`), so the same script plays
// in milliseconds in a unit test and in seconds on the end-to-end tests' site.
import type { Lb07BugId, Lb07BugReport, Lb07Engine, Lb07FailureCode, Lb07Finding, Lb07State, Lb07Step, Lb07StepStatus, Lb07StepView, Lb07Verdict, Lb07Verification, Lb07VerificationPass } from '../../../contracts/src/index.ts'
import { LB07_LIMITS } from '../../../contracts/src/index.ts'
import { checkReports, FindingLedger, isBugFinding, verdictOf } from '../../../../services/node-systems/src/modules/lb07/agent/report.ts'
import { generateTest } from '../../../../services/node-systems/src/modules/lb07/agent/testgen.ts'
import type { GoldenCase } from '../../../../services/node-systems/src/modules/lb07/golden/cases.ts'

import { planFor, replanFromPage, writeReports } from './lb07-plan.ts'
import { syntheticScreenshot } from './lb07-png.ts'
import { ShopSession } from './lb07-shop.ts'
import type { ShopFinding, StepOutcome } from './lb07-shop.ts'

/** The shop's origin as a reader of the generated test would run it: the service's own default. */
export const MOCK_SHOP_ORIGIN = 'http://127.0.0.1:8007'

/** What a run is made from. */
export interface ScriptInput {
  origin: 'sample' | 'custom'
  sampleId: string | null
  goal: string
  bugs: readonly Lb07BugId[]
  // A failure a test asked for: the run ends with it where the real service would.
  failure: Lb07FailureCode | undefined
}

/** One stretch of a run during which what the visitor polls stays the same. */
export interface Frame {
  // How many beats it lasts.
  beats: number
  state: Exclude<Lb07State, 'done' | 'failed'>
  steps: Lb07StepView[]
  modelCalls: number
  replans: number
  findings: number
  reading: string | null
}

/** A piece of evidence and the beat at which it is stored. */
export interface ScriptEvidence {
  id: string
  kind: 'screenshot' | 'snapshot'
  engine: Lb07Engine
  stepIndex: number | null
  image?: Buffer
  text?: string
  at: number
}

/** A span of the run's trace, placed in beats: it is written when its end has passed. */
export interface ScriptSpan {
  key: string
  parent: string | undefined
  kind: 'system.run' | 'system.step' | 'gateway.call' | 'gateway.attempt'
  name: string
  status: 'ok' | 'error' | 'skipped'
  from: number
  to: number
  attrs: Record<string, string | number | boolean>
}

/** How a run ends. */
export type ScriptEnding
  = | { state: 'done', report: ScriptReport, testSource: string, verdict: Lb07Verdict }
    | { state: 'failed', code: Lb07FailureCode }

/** The report of a run that ended done, without the run's id and goal, which its owner adds. */
export interface ScriptReport {
  reading: string | null
  findings: Lb07Finding[]
  findingsDropped: number
  reports: Lb07BugReport[]
  reportsDropped: number
  verification: Lb07Verification
  engines: Lb07Engine[]
  modelCalls: number
  replans: number
  durationMs: number
}

/** A whole run, worked out at its start. */
export interface RunScript {
  frames: Frame[]
  // The beat at which the run ends: the sum of its frames.
  beats: number
  ending: ScriptEnding
  evidence: ScriptEvidence[]
  spans: ScriptSpan[]
}

// How many beats each part of a run takes.
const BEATS = { guard: 1, plan: 2, step: 1, replan: 2, passEnd: 1, cross: 3, report: 2, verify: 3 } as const
// Screenshots of the main pass after steps that made a finding, as the machine takes them.
const MAX_STEP_SCREENSHOTS = 3
// The made-up time a model call takes, for the report's duration.
const MODEL_CALL_MS = 1_400
// The aliases and models the trace names: the ones routing.yaml gives LB-07.
const AGENT_CALL = { alias: 'lb-tools', model: 'groq/gpt-oss-120b' } as const
const GUARD_CALL = { alias: 'lb-guard', model: 'groq/llama-prompt-guard-2-86m' } as const

/** Turns a step's outcome into its status, as the machine does. */
function statusOf(outcome: StepOutcome): Lb07StepStatus {
  if (outcome === 'ok') return 'passed'
  if (outcome === 'expectation') return 'finding'
  if (outcome === 'blocked') return 'blocked'
  return 'failed'
}

/** Copies a step list, so a frame keeps the list as it was. */
function copied(views: readonly Lb07StepView[]): Lb07StepView[] {
  return views.map(view => ({ ...view }))
}

/** The run ended before it was over, with a reason. */
class Ended extends Error {
  readonly code: Lb07FailureCode

  /** Ends the run with the reason. */
  constructor(code: Lb07FailureCode) {
    super(code)
    this.name = 'Ended'
    this.code = code
  }
}

/** What one pass of the plan came to. */
interface PassResult {
  executed: Lb07Step[]
  complete: boolean
  stepsPassed: boolean
  bugFindings: number
  durationMs: number
}

/** How a pass is run. */
interface PassOptions {
  engine: Lb07Engine
  bugsOn: boolean
  steps: readonly Lb07Step[]
  main: boolean
  axe: boolean
  // The span the pass's steps nest under, for the passes after the main one.
  parent: string
  // The beats the pass may spread its steps over when it is not the main one.
  from: number
  to: number
}

/** Works out one run. */
class ScriptWriter {
  readonly frames: Frame[] = []
  readonly evidence: ScriptEvidence[] = []
  readonly spans: ScriptSpan[] = []
  readonly #input: ScriptInput
  readonly #golden: readonly GoldenCase[]
  readonly #ledger = new FindingLedger()
  #beat = 0
  #state: Frame['state'] = 'queued'
  #views: Lb07StepView[] = []
  #modelCalls = 0
  #replans = 0
  #reading: string | null = null
  #stepIndex = 0
  #stepMs = 0
  #scripted: Lb07Step[][] | undefined

  /** Starts a run of the input. */
  constructor(input: ScriptInput, golden: readonly GoldenCase[]) {
    this.#input = input
    this.#golden = golden
  }

  /** Adds a frame of the state as it stands, lasting some beats. */
  #frame(beats: number): void {
    this.frames.push({ beats, state: this.#state, steps: copied(this.#views), modelCalls: Math.min(this.#modelCalls, LB07_LIMITS.maxModelCalls), replans: this.#replans, findings: this.#ledger.findings.length, reading: this.#reading })
    this.#beat += beats
  }

  /** Adds a span, and under it the gateway calls it made, each with its one attempt, one after another. */
  #span(span: ScriptSpan, call?: { alias: string, model: string, tokens: number }, calls = 1): void {
    this.spans.push(span)
    if (!call) return
    const usage = { inputTokens: call.tokens, outputTokens: Math.round(call.tokens / 6) }
    const width = (span.to - span.from) / calls
    for (let number = 0; number < calls; number += 1) {
      const from = span.from + number * width
      const key = `${span.key}.call${number}`
      this.spans.push({ key, parent: span.key, kind: 'gateway.call', name: call.alias, status: 'ok', from: from + 0.05, to: from + width - 0.05, attrs: { alias: call.alias, dataClass: this.#input.origin === 'sample' ? 'synthetic' : 'visitor', stream: false, attempts: 1, provider: call.model.split('/')[0] ?? '', model: call.model, usage: 'reported', ...usage } })
      this.spans.push({ key: `${key}.attempt`, parent: key, kind: 'gateway.attempt', name: call.model, status: 'ok', from: from + 0.1, to: from + width - 0.1, attrs: { provider: call.model.split('/')[0] ?? '', model: call.model, ...usage } })
    }
  }

  /** Keeps a piece of evidence, stored at the current beat, and returns its id. */
  #keepEvidence(piece: Omit<ScriptEvidence, 'id' | 'at'>): string {
    const id = `e${this.evidence.length + 1}`
    this.evidence.push({ ...piece, id, at: this.#beat })
    return id
  }

  /** Adds the runner's findings to the ledger, with the evidence that shows them. */
  #keep(found: readonly ShopFinding[], evidenceIds: readonly string[]): void {
    for (const finding of found) this.#ledger.add(finding, evidenceIds)
  }

  /** The guard of a visitor's own goal: one model call, while the run still says it is queued. A curated sample's goal is the owner's and is not asked about. */
  #guard(): void {
    if (this.#input.origin === 'sample') return
    this.#span({ key: 'guard', parent: 'run', kind: 'system.step', name: 'guard the goal', status: 'ok', from: this.#beat, to: this.#beat + BEATS.guard, attrs: { flagged: false } }, { ...GUARD_CALL, tokens: 90 })
    this.#modelCalls += 1
    this.#frame(BEATS.guard)
  }

  /** The plan, in one model call, or the failure a test asked for at this point. */
  #plan(): Lb07Step[] {
    const failure = this.#input.failure
    this.#state = 'planning'
    const calls = failure === 'planning_unavailable' ? 0 : failure === 'plan_invalid' ? 2 : 1
    const from = this.#beat
    this.#span({ key: 'plan', parent: 'run', kind: 'system.step', name: 'plan the test', status: calls === 1 && failure !== 'plan_refused' ? 'ok' : 'error', from, to: from + BEATS.plan, attrs: { attempts: Math.max(1, calls) } }, calls === 0 ? undefined : { ...AGENT_CALL, tokens: 2_600 }, Math.max(1, calls))
    this.#modelCalls += calls
    this.#frame(BEATS.plan)
    if (failure === 'planning_unavailable' || failure === 'plan_invalid' || failure === 'plan_refused') throw new Ended(failure)
    const planned = planFor(this.#input.goal, this.#golden, this.#input.sampleId)
    this.#reading = planned.reading
    this.#scripted = planned.scripted
    return planned.plan
  }

  /** Asks the stand-in planner for the steps that replace a failed one and what followed it, once the budget allows. */
  #replan(session: ShopSession, failed: Lb07Step, remaining: readonly Lb07Step[]): Lb07Step[] | undefined {
    if (this.#replans >= LB07_LIMITS.maxReplans) return undefined
    const scripted = this.#scripted
    const answer = scripted === undefined ? replanFromPage(failed, remaining, session.controls()) : (scripted[this.#replans] ?? [])
    this.#replans += 1
    this.#modelCalls += 1
    this.#state = 'replanning'
    const from = this.#beat
    this.#span({ key: `replan${this.#replans}`, parent: 'run', kind: 'system.step', name: 're-plan after a failed step', status: 'ok', from, to: from + BEATS.replan, attrs: { outcome: answer.length === 0 ? 'stop' : 'replaced', steps: answer.length } }, { ...AGENT_CALL, tokens: 3_400 })
    this.#frame(BEATS.replan)
    this.#state = 'running'
    return answer
  }

  /** Marks the steps still to come as skipped. */
  #skip(queue: readonly Lb07Step[], plan: number): void {
    for (const step of queue) {
      this.#views.push({ index: this.#stepIndex, step, status: 'skipped', plan, durationMs: null, outcome: null })
      this.#stepIndex += 1
    }
  }

  /** Writes the span of one step that ran. */
  #stepSpan(key: string, parent: string, step: Lb07Step, index: number, engine: Lb07Engine, outcome: StepOutcome, findings: number, from: number, to: number): void {
    this.#span({ key, parent, kind: 'system.step', name: `step ${step.action}`, status: outcome === 'ok' || outcome === 'expectation' ? 'ok' : 'error', from, to, attrs: { index, engine, outcome, findings } })
  }

  /** Runs the main pass: in Chromium with the bugs on, step by step in frames the visitor sees, re-planning what fails. */
  #mainPass(plan: readonly Lb07Step[]): PassResult {
    const session = new ShopSession(this.#input.bugs, 'chromium')
    const executed: Lb07Step[] = []
    const bugsBefore = this.#ledger.bugFindings
    const timeoutAfter = this.#input.failure === 'run_timeout' ? Math.max(1, Math.ceil(plan.length / 2)) : undefined
    let queue = [...plan]
    let planNumber = 0
    let screenshots = 0
    let stepsPassed = true
    let complete = true
    let durationMs = 0
    this.#state = 'running'
    if (this.#input.failure === 'runner_unavailable' || this.#input.failure === 'internal') {
      this.#frame(BEATS.plan)
      throw new Ended(this.#input.failure)
    }
    while (queue.length > 0) {
      if (timeoutAfter !== undefined && this.#stepIndex >= timeoutAfter) throw new Ended('run_timeout')
      const step = queue.shift() as Lb07Step
      const view: Lb07StepView = { index: this.#stepIndex, step, status: 'running', plan: planNumber, durationMs: null, outcome: null }
      this.#views.push(view)
      const from = this.#beat
      this.#frame(BEATS.step)
      const result = session.step(step, view.index)
      this.#stepSpan(`step${view.index}`, 'run', step, view.index, 'chromium', result.outcome, result.findings.length, from, this.#beat)
      view.status = statusOf(result.outcome)
      view.outcome = result.outcome
      view.durationMs = result.durationMs
      durationMs += result.durationMs
      if (view.status !== 'passed') stepsPassed = false
      let evidenceIds: string[] = []
      if (result.findings.length > 0 && screenshots < MAX_STEP_SCREENSHOTS) {
        screenshots += 1
        evidenceIds = [this.#keepEvidence({ kind: 'screenshot', engine: 'chromium', stepIndex: view.index, image: syntheticScreenshot(view.index + 1) })]
      }
      this.#keep(result.findings, evidenceIds)
      if (step.action === 'goto' && result.outcome === 'ok') this.#keep(session.axe(view.index), [])
      if (view.status === 'passed' || view.status === 'finding') executed.push(step)
      this.#stepIndex += 1
      if (view.status === 'blocked') {
        complete = false
        this.#skip(queue, planNumber)
        break
      }
      if (view.status === 'failed') {
        const replacement = this.#replan(session, step, queue)
        if (replacement === undefined || replacement.length === 0) {
          complete = false
          this.#skip(queue, planNumber)
          break
        }
        planNumber += 1
        queue = [...replacement]
      }
    }
    if (executed.length > 0) this.#keep(session.axe(null), [])
    this.#keepEvidence({ kind: 'screenshot', engine: 'chromium', stepIndex: null, image: syntheticScreenshot(0) })
    const page = session.snapshot()
    if (page !== '') this.#keepEvidence({ kind: 'snapshot', engine: 'chromium', stepIndex: null, text: page })
    this.#frame(BEATS.passEnd)
    if (executed.length === 0) complete = false
    if (this.#views.length === 0) stepsPassed = false
    return { executed, complete, stepsPassed, bugFindings: this.#ledger.bugFindings - bugsBefore, durationMs }
  }

  /** Runs a pass after the main one, inside one frame: the second engine, or the clean shop. */
  #quietPass(options: PassOptions): PassResult {
    const session = new ShopSession(options.bugsOn ? this.#input.bugs : [], options.engine)
    const bugsBefore = this.#ledger.bugFindings
    const executed: Lb07Step[] = []
    const width = (options.to - options.from) / Math.max(1, options.steps.length)
    let stepsPassed = options.steps.length > 0
    let durationMs = 0
    for (const [offset, step] of options.steps.entries()) {
      const index = this.#stepIndex
      const result = session.step(step, index)
      this.#stepSpan(`${options.parent}.step${offset}`, options.parent, step, index, options.engine, result.outcome, result.findings.length, options.from + offset * width, options.from + (offset + 1) * width)
      durationMs += result.durationMs
      const status = statusOf(result.outcome)
      if (status !== 'passed') stepsPassed = false
      this.#keep(result.findings, [])
      if (options.axe && step.action === 'goto' && result.outcome === 'ok') this.#keep(session.axe(index), [])
      if (status === 'passed' || status === 'finding') executed.push(step)
      this.#stepIndex += 1
      if (status === 'blocked' || status === 'failed') break
    }
    if (options.axe && executed.length > 0) this.#keep(session.axe(null), [])
    return { executed, complete: executed.length === options.steps.length, stepsPassed, bugFindings: this.#ledger.bugFindings - bugsBefore, durationMs }
  }

  /** The bug reports: one model call when code found a bug, none when it found nothing. */
  #report(ran: readonly Lb07Step[]): { reports: Lb07BugReport[], dropped: number } {
    this.#state = 'reporting'
    const bugFindings = this.#ledger.findings.filter(isBugFinding)
    const from = this.#beat
    if (bugFindings.length === 0) {
      this.#span({ key: 'report', parent: 'run', kind: 'system.step', name: 'write bug reports', status: 'skipped', from, to: from + 1, attrs: { reason: 'nothing to report' } })
      this.#frame(1)
      return { reports: [], dropped: 0 }
    }
    const checked = checkReports(writeReports(bugFindings, ran), this.#ledger.findings)
    this.#modelCalls += 1
    this.#span({ key: 'report', parent: 'run', kind: 'system.step', name: 'write bug reports', status: 'ok', from, to: from + BEATS.report, attrs: { attempts: 1, reports: checked.kept.length, dropped: checked.dropped } }, { ...AGENT_CALL, tokens: 1_900 + 180 * bugFindings.length })
    this.#frame(BEATS.report)
    return { reports: checked.kept, dropped: checked.dropped }
  }

  /** Works out the whole run, from the guard to the generated test, or to the failure that ends it. */
  write(): RunScript {
    try {
      return this.#run()
    }
    catch (error) {
      if (!(error instanceof Ended)) throw error
      return this.#finish({ state: 'failed', code: error.code })
    }
  }

  /** The run as the machine plays it. */
  #run(): RunScript {
    this.#guard()
    if (this.#input.failure === 'goal_refused') {
      if (this.frames.length === 0) this.#frame(BEATS.guard)
      throw new Ended('goal_refused')
    }
    const plan = this.#plan()
    const bugsOn = this.#input.bugs.length > 0
    const main = this.#mainPass(plan)
    const finalPlan = main.executed
    const engines: Lb07Engine[] = ['chromium']
    let cross: Lb07VerificationPass | null = null
    if (main.complete) {
      this.#state = 'cross_checking'
      const from = this.#beat
      const pass = this.#quietPass({ engine: 'firefox-ua', bugsOn: true, steps: finalPlan, main: false, axe: false, parent: 'cross', from: from + 0.2, to: from + BEATS.cross - 0.2 })
      this.#span({ key: 'cross', parent: 'run', kind: 'system.step', name: 'cross-check in the second engine', status: 'ok', from, to: from + BEATS.cross, attrs: { bug_findings: pass.bugFindings, steps_passed: pass.stepsPassed } })
      this.#frame(BEATS.cross)
      cross = { engine: 'firefox-ua', bugsOn: true, stepsPassed: pass.stepsPassed, findings: pass.bugFindings, durationMs: pass.durationMs }
      this.#stepMs += pass.durationMs
      engines.push('firefox-ua')
    }
    const written = this.#report(finalPlan.length > 0 ? finalPlan : plan)
    this.#state = 'verifying'
    let green: Lb07VerificationPass | null = null
    const from = this.#beat
    if (main.complete) {
      const pass = this.#quietPass({ engine: 'chromium', bugsOn: false, steps: finalPlan, main: false, axe: true, parent: 'verify', from: from + 0.2, to: from + BEATS.verify - 0.2 })
      this.#span({ key: 'verify', parent: 'run', kind: 'system.step', name: 'verify the test on the clean shop', status: 'ok', from, to: from + BEATS.verify, attrs: { steps_passed: pass.stepsPassed, bug_findings: pass.bugFindings } })
      green = { engine: 'chromium', bugsOn: false, stepsPassed: pass.stepsPassed, findings: pass.bugFindings, durationMs: pass.durationMs }
      this.#stepMs += pass.durationMs
    }
    this.#frame(main.complete ? BEATS.verify : 1)
    this.#stepMs += main.durationMs
    const red: Lb07VerificationPass | null = bugsOn && main.complete ? { engine: 'chromium', bugsOn: true, stepsPassed: main.stepsPassed, findings: main.bugFindings, durationMs: main.durationMs } : null
    const verdict = verdictOf(bugsOn, red, bugsOn ? cross : null, green)
    const testSource = generateTest({ goal: this.#input.goal, steps: finalPlan.length > 0 ? finalPlan : plan, shopOrigin: MOCK_SHOP_ORIGIN })
    this.#span({ key: 'generate', parent: 'run', kind: 'system.step', name: 'generate the test', status: 'ok', from: this.#beat, to: this.#beat, attrs: { verdict, chars: testSource.length } })
    const report: ScriptReport = {
      reading: this.#reading,
      findings: this.#ledger.findings,
      findingsDropped: this.#ledger.dropped,
      reports: written.reports,
      reportsDropped: written.dropped,
      verification: { verdict, red, cross: bugsOn ? cross : null, green },
      engines,
      modelCalls: Math.min(this.#modelCalls, LB07_LIMITS.maxModelCalls),
      replans: this.#replans,
      durationMs: this.#stepMs + this.#modelCalls * MODEL_CALL_MS,
    }
    return this.#finish({ state: 'done', report, testSource, verdict })
  }

  /** Ends the script: the root span and the ending. */
  #finish(ending: ScriptEnding): RunScript {
    const outcome = ending.state === 'done' ? 'done' : ending.code
    this.#span({ key: 'run', parent: undefined, kind: 'system.run', name: 'qa run', status: ending.state === 'done' ? 'ok' : 'error', from: 0, to: this.#beat, attrs: { outcome, origin: this.#input.origin, model_calls: Math.min(this.#modelCalls, LB07_LIMITS.maxModelCalls), findings: this.#ledger.findings.length, replans: this.#replans, bugs_on: this.#input.bugs.length } })
    return { frames: this.frames, beats: this.#beat, ending, evidence: this.evidence, spans: this.spans }
  }
}

/** Works out a whole run for the mock, from its input and the golden set. */
export function writeScript(input: ScriptInput, golden: readonly GoldenCase[]): RunScript {
  return new ScriptWriter(input, golden).write()
}
