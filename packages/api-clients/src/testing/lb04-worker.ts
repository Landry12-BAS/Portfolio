// The stand-in for LB-04's worker, as the mock back end plays it. It opens a contract's PDF with the
// service's own extraction (the worker thread over pdf.js), reviews the text with the service's own
// pipeline (the same clause splitter, injection screen, quote verifier and report), and proposes a
// redline with the service's own proposal and word-by-word difference. The one thing that is not
// real is the models: they are the golden set's reference reviewer (services/node-systems/src/
// modules/lb04/golden/reference.ts), which finds exactly what the golden set plants in a sample
// contract. A PDF that is not one of the samples is reviewed by a reviewer that finds no risky
// passage and lists every clause the playbook requires as missing, so the verifier keeps only the
// clauses the text really lacks. No model is called, and nothing here measures anything: the spans
// it writes carry the pipeline's real names and counts, with timings and token counts that are made up.
import { createHash } from 'node:crypto'

import { createRun, currentSpanId, GatewayCallError, runScope, spanIdFrom, spanScope, Tracer } from '@lb/common'
import type { Span, SpanWriter } from '@lb/common'

import { LB04_FILE_FAILURES } from '../../../contracts/src/index.ts'
import type { Lb04FailureCode, Lb04Finding, Lb04Redline, Lb04Report } from '../../../contracts/src/index.ts'
import type { JsonModel, ModelReply, PromptMessage, ReviewModels } from '../../../../services/node-systems/src/modules/lb04/analysis/model.ts'
import { freshWorking, reviewContract } from '../../../../services/node-systems/src/modules/lb04/analysis/pipeline.ts'
import type { Guard } from '../../../../services/node-systems/src/modules/lb04/analysis/pipeline.ts'
import { proposeRedline } from '../../../../services/node-systems/src/modules/lb04/analysis/propose.ts'
import { DEFAULT_CONFIG } from '../../../../services/node-systems/src/modules/lb04/config.ts'
import { reactionTo } from '../../../../services/node-systems/src/modules/lb04/engine/failures.ts'
import { rootSpanIdOf } from '../../../../services/node-systems/src/modules/lb04/engine/trace.ts'
import type { ReportCase } from '../../../../services/node-systems/src/modules/lb04/golden/cases.ts'
import { referenceAnswers, referenceGuard } from '../../../../services/node-systems/src/modules/lb04/golden/reference.ts'
import type { Answerer } from '../../../../services/node-systems/src/modules/lb04/golden/reference.ts'
import { ExtractionRefused, extractPdf } from '../../../../services/node-systems/src/modules/lb04/pdf/extract.ts'
import type { ExtractedPage } from '../../../../services/node-systems/src/modules/lb04/pdf/extract.ts'
import type { Playbook } from '../../../../services/node-systems/src/modules/lb04/playbook/playbook.ts'

import type { Lb04Seed } from './lb04-seed.ts'
import type { MockSpan } from './spans.ts'

// How long a contract waits for a worker before its review starts, and what opening a file costs, in milliseconds. All made up.
const QUEUE_WAIT_MS = 350
const OPEN_BASE_MS = 120
const OPEN_PER_PAGE_MS = 35
// How many different files' extractions the worker keeps, so a long run of tests holds a bounded amount.
const KEPT_EXTRACTIONS = 32

/** A file the extraction opened, or the reason it was refused. */
export type Opened = { pages: ExtractedPage[] } | { refused: Lb04FailureCode }

/** How a review ended: with its report, or as failed with a reason. */
export type Ended = { report: Lb04Report } | { failed: Lb04FailureCode }

/** What the worker needs to know of a contract to review it. */
export interface ReviewInput {
  id: string
  // The visitor's session key, which the trace's run carries.
  session: string
  origin: 'upload' | 'sample'
  bytes: Uint8Array
  // When the contract was made, in Unix milliseconds: the review's root span starts here and the trace's clock too.
  createdAt: number
  // Ends this review as failed with this reason, as a test asks (a file failure refuses the file, a model failure makes the first model fail).
  forced?: Lb04FailureCode
}

/** A clock the mock moves by hand, so the made-up timings of a trace are the same on every run. */
export class StepClock {
  #now: number

  /** Starts at `start`, in Unix milliseconds. */
  constructor(start: number) {
    this.#now = start
  }

  /** The time now. A function of its own, so a tracer can be given it as its clock. */
  readonly now = (): number => this.#now

  /** Moves the clock on. */
  advance(milliseconds: number): void {
    this.#now += Math.round(milliseconds)
  }

  /** Moves the clock to a later moment, and leaves it where it is when the moment is earlier. */
  moveTo(moment: number): void {
    this.#now = Math.max(this.#now, moment)
  }
}

/** Turns a span the tracer wrote into the shape the Scope's route returns. */
function toMockSpan(span: Span): MockSpan {
  const kind: MockSpan['kind'] = span.kind === 'system.run' || span.kind === 'system.tool' ? span.kind : 'system.step'
  return { v: 1, runId: span.runId, system: 'lb-04', spanId: span.spanId, ...(span.parentId === undefined ? {} : { parentId: span.parentId }), kind, name: span.name, status: span.status, startMs: span.startMs, endMs: span.endMs, attrs: { ...span.attrs } }
}

/** Where a review's spans are kept, in the order they ended, which is the order the gateway's stream holds them. */
class SpanLog implements SpanWriter {
  readonly spans: MockSpan[] = []

  /** Keeps the spans the tracer writes. */
  async write(spans: readonly Span[]): Promise<void> {
    for (const span of spans) this.spans.push(toMockSpan(span))
  }
}

/** The details of one model call the stand-in models record, as the gateway would. */
interface CallDetails {
  alias: string
  model: string
  startMs: number
  endMs: number
  inputTokens: number
  outputTokens: number
  dataClass: 'visitor' | 'synthetic'
  // The gateway's code for a call it refused before any provider was asked, such as `quota_exceeded`.
  refusedAs?: string
}

/** A review's trace: its spans, its clock and the tracer that writes to both. */
export class Trace {
  readonly runId: string
  readonly log = new SpanLog()
  readonly clock: StepClock
  readonly tracer: Tracer
  #calls = 0

  /** Starts the trace of the run `runId` at `start`. */
  constructor(runId: string, start: number) {
    this.runId = runId
    this.clock = new StepClock(start)
    this.tracer = new Tracer(this.log, this.clock.now)
  }

  /** Writes a model call as the gateway writes it: the call under the step that asked, and the one attempt under the call. A call the gateway refused has no attempt and ends as an error. */
  recordCall(call: CallDetails): void {
    this.#calls += 1
    const callId = spanIdFrom(`${this.runId}:call:${this.#calls}`)
    const provider = call.model.split('/')[0] ?? ''
    const parentId = currentSpanId()
    if (call.refusedAs === undefined) {
      this.log.spans.push({ v: 1, runId: this.runId, system: 'lb-04', spanId: spanIdFrom(`${this.runId}:attempt:${this.#calls}`), parentId: callId, kind: 'gateway.attempt', name: call.model, status: 'ok', startMs: call.startMs + 2, endMs: Math.max(call.endMs - 2, call.startMs + 2), attrs: { provider, model: call.model, inputTokens: call.inputTokens, outputTokens: call.outputTokens } })
    }
    const attrs = { alias: call.alias, dataClass: call.dataClass, stream: false, attempts: call.refusedAs === undefined ? 1 : 0, provider, model: call.model, inputTokens: call.inputTokens, outputTokens: call.outputTokens, usage: 'reported' }
    this.log.spans.push({ v: 1, runId: this.runId, system: 'lb-04', spanId: callId, ...(parentId === undefined ? {} : { parentId }), kind: 'gateway.call', name: call.alias, status: call.refusedAs === undefined ? 'ok' : 'error', startMs: call.startMs, endMs: call.endMs, attrs: call.refusedAs === undefined ? attrs : { ...attrs, error: call.refusedAs } })
  }
}

/** What an alias is called, which model its chain starts with, and how long a made-up call takes. */
interface Standing {
  alias: string
  model: (dataClass: 'visitor' | 'synthetic') => string
  latencyMs: (inputTokens: number, outputTokens: number) => number
}

const LONG: Standing = { alias: 'lb-long', model: dataClass => (dataClass === 'synthetic' ? 'openrouter/nemotron-3-ultra' : 'workers-ai/gpt-oss-120b'), latencyMs: (input, output) => 600 + 0.6 * input + 14 * output }
const REASON: Standing = { alias: 'lb-reason', model: () => 'groq/gpt-oss-120b', latencyMs: (input, output) => 400 + 0.3 * input + 14 * output }
const FAST: Standing = { alias: 'lb-fast', model: () => 'groq/gpt-oss-20b', latencyMs: (input, output) => 250 + 0.3 * input + 10 * output }
const GUARD: Standing = { alias: 'lb-guard', model: () => 'groq/llama-prompt-guard-2-86m', latencyMs: () => 190 }

/** Counts the tokens of a text the rough way: four characters to a token. A made-up figure, as every figure of the mock's spans is. */
function tokensOf(text: string): number {
  return Math.ceil(text.length / 4)
}

/** A model that answers from a script and writes the call it would have been, so the trace has the gateway's spans. */
class StandInModel implements JsonModel {
  readonly #trace: Trace
  readonly #standing: Standing
  readonly #dataClass: 'visitor' | 'synthetic'
  readonly #answer: Answerer

  /** Answers with `answer`, and records each call in `trace` as `standing` describes it. */
  constructor(trace: Trace, standing: Standing, dataClass: 'visitor' | 'synthetic', answer: Answerer) {
    this.#trace = trace
    this.#standing = standing
    this.#dataClass = dataClass
    this.#answer = answer
  }

  /** Answers the conversation, moves the trace's clock by the call's made-up time and writes the call's spans. A script that throws a gateway error is a call the gateway refused. */
  async ask(messages: readonly PromptMessage[]): Promise<ModelReply> {
    const startMs = this.#trace.clock.now()
    const inputTokens = tokensOf(messages.map(message => message.content).join(''))
    const model = this.#standing.model(this.#dataClass)
    let reply: ModelReply
    try {
      reply = this.#answer(messages)
    }
    catch (error) {
      this.#trace.clock.advance(20)
      this.#trace.recordCall({ alias: this.#standing.alias, model, startMs, endMs: this.#trace.clock.now(), inputTokens, outputTokens: 0, dataClass: this.#dataClass, refusedAs: error instanceof GatewayCallError ? error.code : 'internal_error' })
      throw error
    }
    const outputTokens = tokensOf(reply.kind === 'json' ? JSON.stringify(reply.value) : reply.text)
    this.#trace.clock.advance(this.#standing.latencyMs(inputTokens, outputTokens))
    this.#trace.recordCall({ alias: this.#standing.alias, model, startMs, endMs: this.#trace.clock.now(), inputTokens, outputTokens, dataClass: this.#dataClass })
    return reply
  }
}

/** A guard that answers as the case expects and writes the call it would have been. */
class StandInGuard implements Guard {
  readonly #trace: Trace
  readonly #dataClass: 'visitor' | 'synthetic'
  readonly #verdict: Guard

  /** Wraps `verdict`, recording each check in `trace`. */
  constructor(trace: Trace, dataClass: 'visitor' | 'synthetic', verdict: Guard) {
    this.#trace = trace
    this.#dataClass = dataClass
    this.#verdict = verdict
  }

  /** Checks a text and writes the guard call's spans. */
  async check(text: string): Promise<{ flagged: boolean, score: number }> {
    const startMs = this.#trace.clock.now()
    const verdict = await this.#verdict.check(text)
    this.#trace.clock.advance(GUARD.latencyMs(0, 0))
    this.#trace.recordCall({ alias: GUARD.alias, model: GUARD.model(this.#dataClass), startMs, endMs: this.#trace.clock.now(), inputTokens: tokensOf(text), outputTokens: 1, dataClass: this.#dataClass })
    return verdict
  }
}

/** The case a file with no golden case of its own is reviewed as: no risky passage, and every required clause claimed missing for the verifier to check. */
function genericCase(playbook: Playbook): ReportCase {
  const required = [...playbook.rules.values()].filter(rule => rule.kind === 'required')
  return {
    kind: 'report',
    id: 'upload',
    contract: 'upload',
    sample: false,
    planted: [],
    tolerated: [],
    absent: required.map(rule => ({ rule: rule.id, topic: rule.topic, severity: rule.severity })),
    screen: 'clean',
    instructions: [],
    maxUnplanted: 0,
  }
}

/** A conversation the first model cannot answer: the model is out of quota, or answers in no usable form, or the service itself fails. */
function failingAnswerer(code: Lb04FailureCode): Answerer {
  return () => {
    if (code === 'analysis_invalid') return { kind: 'text', text: 'I cannot review this.' }
    if (code === 'analysis_unavailable') throw new GatewayCallError('quota_exceeded', 429, undefined)
    throw new Error('The stand-in worker was told to fail.')
  }
}

/** The data class a run of a contract carries. */
function dataClassOf(origin: 'upload' | 'sample'): 'visitor' | 'synthetic' {
  return origin === 'sample' ? 'synthetic' : 'visitor'
}

/** A review in progress: its trace, the models it asks, and the two moments the mock's states follow. */
export interface ReviewJob {
  trace: Trace
  models: ReviewModels
  dataClass: 'visitor' | 'synthetic'
  // Settles when the file has been opened: with its pages, or the reason it was refused.
  extracted: Promise<Opened>
  // Settles when the review has ended: with the report, or the reason it failed.
  ended: Promise<Ended>
}

/** The worker: reviews contracts and makes redlines with the service's own code and stand-in models. */
export class Lb04Worker {
  readonly #playbook: Playbook
  readonly #cases = new Map<string, ReportCase>()
  readonly #generic: ReportCase
  readonly #opened = new Map<string, Promise<Opened>>()

  /** Knows the samples' golden cases by the hash of their files, so a file identical to a sample is reviewed as that sample is. */
  constructor(seed: Lb04Seed) {
    this.#playbook = seed.playbook
    this.#generic = genericCase(seed.playbook)
    for (const sample of seed.samples) {
      if (sample.golden.kind === 'report') this.#cases.set(sample.entry.sha256, sample.golden)
    }
  }

  /** Starts a review. The job's promises settle as the review goes; it never rejects. */
  start(input: ReviewInput): ReviewJob {
    const trace = new Trace(input.id, input.createdAt)
    const dataClass = dataClassOf(input.origin)
    const entry = this.#cases.get(createHash('sha256').update(input.bytes).digest('hex')) ?? this.#generic
    const models = this.#modelsFor(trace, dataClass, entry, input.forced)
    let announce: (opened: Opened) => void = () => {}
    const extracted = new Promise<Opened>((resolve) => {
      announce = resolve
    })
    const ended = this.#run(input, trace, dataClass, entry, models, announce)
    return { trace, models, dataClass, extracted, ended }
  }

  /** Makes a redline of a finding, in the contract's own trace, from the first moment the clock allows. Throws when the proposal does. */
  async redline(job: ReviewJob, input: Pick<ReviewInput, 'id' | 'session' | 'origin'>, finding: Lb04Finding, now: number): Promise<Lb04Redline> {
    job.trace.clock.moveTo(now)
    const run = createRun({ system: 'lb-04', runId: input.id, session: input.session, dataClass: job.dataClass })
    const { redline } = await runScope(run, () => spanScope(rootSpanIdOf(input.id), () => proposeRedline({ models: job.models, playbook: this.#playbook, tracer: job.trace.tracer }, finding)))
    return redline
  }

  /** Builds the three stand-in models of a review for a case; a forced model failure makes the first one fail. */
  #modelsFor(trace: Trace, dataClass: 'visitor' | 'synthetic', entry: ReportCase, forced: Lb04FailureCode | undefined): ReviewModels {
    const answers = referenceAnswers(entry, this.#playbook)
    const modelFailure = forced !== undefined && !LB04_FILE_FAILURES.includes(forced)
    return {
      long: new StandInModel(trace, LONG, dataClass, modelFailure ? failingAnswerer(forced) : answers.long),
      reason: new StandInModel(trace, REASON, dataClass, answers.reason),
      fast: new StandInModel(trace, FAST, dataClass, answers.fast),
    }
  }

  /** Opens a file with the service's own extraction, once for each distinct file the worker is given. */
  #open(bytes: Uint8Array): Promise<Opened> {
    const key = createHash('sha256').update(bytes).digest('hex')
    const known = this.#opened.get(key)
    if (known) return known
    const opening = extractPdf(bytes, DEFAULT_CONFIG.extraction).then(
      (pages): Opened => ({ pages }),
      (error: unknown): Opened => ({ refused: error instanceof ExtractionRefused ? error.code : 'extraction_failed' }),
    )
    if (this.#opened.size >= KEPT_EXTRACTIONS) this.#opened.delete(this.#opened.keys().next().value ?? key)
    this.#opened.set(key, opening)
    return opening
  }

  /** Runs one review in its run, and writes the root span last, outside every span, as the service does. */
  async #run(input: ReviewInput, trace: Trace, dataClass: 'visitor' | 'synthetic', entry: ReportCase, models: ReviewModels, announce: (opened: Opened) => void): Promise<Ended> {
    const run = createRun({ system: 'lb-04', runId: input.id, session: input.session, dataClass })
    const outcome = await runScope(run, () => spanScope(rootSpanIdOf(input.id), () => this.#work(input, trace, entry, models, announce)))
    const pages = outcome.pages
    await runScope(run, () => trace.tracer.record({
      name: 'contract review',
      kind: 'system.run',
      status: 'report' in outcome.ended ? 'ok' : 'error',
      spanId: rootSpanIdOf(input.id),
      startMs: input.createdAt,
      endMs: trace.clock.now(),
      attrs: { outcome: 'report' in outcome.ended ? 'done' : outcome.ended.failed, origin: input.origin, pages, model_calls: 'report' in outcome.ended ? outcome.ended.report.calls : 0 },
    }))
    return outcome.ended
  }

  /** Opens the file and reviews its text, and says how it ended. Never throws: what goes wrong is a failed review, as the engine makes it. */
  async #work(input: ReviewInput, trace: Trace, entry: ReportCase, models: ReviewModels, announce: (opened: Opened) => void): Promise<{ ended: Ended, pages: number }> {
    trace.clock.advance(QUEUE_WAIT_MS)
    const opened = await this.#openInSpan(input, trace)
    announce(opened)
    if ('refused' in opened) return { ended: { failed: opened.refused }, pages: 0 }
    try {
      const report = await reviewContract(
        { models, guard: new StandInGuard(trace, dataClassOf(input.origin), referenceGuard(entry)), tracer: trace.tracer, playbook: this.#playbook },
        { contractId: input.id, pages: opened.pages },
        freshWorking(),
        { onState: async () => {}, save: async () => {}, lastAttempt: true },
      )
      return { ended: { report }, pages: opened.pages.length }
    }
    catch (error) {
      return { ended: { failed: failureOf(error) }, pages: opened.pages.length }
    }
  }

  /** Opens the file inside the `extract text` span, the way the service does, so the span's counts are the file's real ones. */
  #openInSpan(input: ReviewInput, trace: Trace): Promise<Opened> {
    return trace.tracer.span('extract text', async (span) => {
      const forced = input.forced
      const opened: Opened = forced !== undefined && LB04_FILE_FAILURES.includes(forced) ? { refused: forced } : await this.#open(input.bytes)
      if ('pages' in opened) {
        span.set('pages', opened.pages.length)
        span.set('characters', opened.pages.reduce((total, page) => total + page.text.length, 0))
        trace.clock.advance(OPEN_BASE_MS + OPEN_PER_PAGE_MS * opened.pages.length)
      }
      else {
        span.set('refused', opened.refused)
        trace.clock.advance(OPEN_BASE_MS)
      }
      return opened
    })
  }
}

/** Says why a review failed, as the engine decides it for a review that has no attempt left: what the gateway or the model did, or the service itself. */
function failureOf(error: unknown): Lb04FailureCode {
  const reaction = reactionTo(error)
  if (reaction?.kind === 'fail') return reaction.code
  return reaction ? 'analysis_unavailable' : 'internal'
}
