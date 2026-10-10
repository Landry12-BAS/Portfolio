// LB-07 QA Engineer as the mock back end plays it: a visitor starts a test run from a curated sample or a
// goal of their own with the bugs of their choice, polls it while it waits in the queue for the one browser
// and while it plans, runs, re-plans, cross-checks, writes its reports and verifies, and then reads the
// report, the generated test and the evidence. The answers have the shapes services/node-systems/openapi.json
// documents, and the rules are the service's: two runs a visitor a day (a sample counts, a run the system
// could not do is given back), at most four runs open at once before a new one is told the system is busy,
// one browser, an hour before a run is gone, and every refusal in the service's own codes.
//
// A run is worked out whole the moment it starts (lb07-script.ts) and then shown as far as the clock has
// got: the queue is a schedule computed from the runs' starts and lengths, so nothing runs on a timer, a
// test's clock moves everything, and the same runs always play the same way. Pace is `tickMs` a beat:
// fast by default, so a run takes a few seconds. A test can ask the next run to fail with one of the
// service's failure codes (`failNext`, or the `/__mock/lb07/fail` control) and can fill the queue with
// another visitor's runs (`occupy`).
import { createHash, randomUUID } from 'node:crypto'

import { LB07_FAILURE_CODES, LB07_FAILURE_MESSAGES, LB07_LIMITS, lb07CreateRunRequestSchema, lb07EvidenceViewSchema, lb07ReportSchema, lb07RunViewSchema, lb07TestViewSchema } from '../../../contracts/src/index.ts'
import type { Lb07BugId, Lb07EvidenceView, Lb07FailureCode, Lb07RunView } from '../../../contracts/src/index.ts'
import { testFilename } from '../../../../services/node-systems/src/modules/lb07/agent/testgen.ts'
import { bugViews } from '../../../../services/node-systems/src/modules/lb07/data/bugs.ts'
import { rootSpanIdOf } from '../../../../services/node-systems/src/modules/lb07/engine/trace.ts'

import { errorAnswer } from './lb01.ts'
import type { Answer } from './lb01.ts'
import type { Lb07Seed } from './lb07-seed.ts'
import { writeScript } from './lb07-script.ts'
import type { Frame, RunScript } from './lb07-script.ts'
import type { MockSpan } from './spans.ts'

/** What a test may choose about the mock's LB-07. */
export interface Lb07MockOptions {
  // Wall-clock milliseconds one beat of a run takes: fast by default, so a whole run takes a few seconds.
  tickMs?: number
  // How many runs the browser works on at once: one, as the service.
  concurrentRuns?: number
  // How many runs may be open, queued or running, before a new one is told the system is busy.
  maxQueued?: number
}

/**
 * The failures after which the service gives the visitor's run for the day back: the system's fault, not
 * the run's (services/node-systems/src/modules/lb07/engine/failures.ts, `REFUNDED`; a test of this package
 * checks the two agree).
 */
export const LB07_GIVEN_BACK: ReadonlySet<Lb07FailureCode> = new Set(['planning_unavailable', 'runner_unavailable', 'plan_invalid', 'internal'])

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
// Who another visitor's runs belong to: no visitor's token can carry it, since a session key is a hash.
const ANOTHER_VISITOR = '(another visitor)'
// How long another visitor's run holds the browser unless a test says otherwise.
const OTHER_RUN_MS = 20_000

/** A failure a test asked a run to end with: the next run, or the next run with this goal. */
interface ScriptedFailure {
  code: Lb07FailureCode
  goal: string | undefined
}

/** One run the mock holds. */
interface MockRun {
  id: string
  session: string
  origin: 'sample' | 'custom'
  sampleId: string | null
  goal: string
  bugs: Lb07BugId[]
  createdAt: number
  expiresAt: number
  script: RunScript
  deletedAt: number | undefined
}

/** When a run holds the browser, and whether it got to its own end or was deleted first. */
interface Slot {
  start: number
  end: number
  finished: boolean
}

/** The id of a span of a run, the same for the same run and key. */
function spanIdOf(runId: string, key: string): string {
  return createHash('sha256').update(`${runId}:${key}`).digest('hex').slice(0, 16)
}

/** The next midnight UTC after a moment, when the day's runs start again. */
function nextReset(moment: number): number {
  return Date.parse(`${new Date(moment).toISOString().slice(0, 10)}T00:00:00.000Z`) + DAY_MS
}

/** A script for another visitor's run: it holds the browser for a while and shows nobody anything. */
function otherScript(beats: number): RunScript {
  const frame: Frame = { beats, state: 'running', steps: [], modelCalls: 1, replans: 0, findings: 0, reading: null }
  return { frames: [frame], beats, ending: { state: 'failed', code: 'internal' }, evidence: [], spans: [] }
}

/** The mock's LB-07. */
export class Lb07Mock {
  readonly #seed: Lb07Seed
  readonly #now: () => number
  readonly #options: Required<Lb07MockOptions>
  readonly #runs: MockRun[] = []
  readonly #failures: ScriptedFailure[] = []

  /** Makes the mock's LB-07 from its seed, with its clock and its pace. */
  constructor(seed: Lb07Seed, now: () => number, options: Lb07MockOptions = {}) {
    this.#seed = seed
    this.#now = now
    this.#options = {
      tickMs: options.tickMs ?? 150,
      concurrentRuns: options.concurrentRuns ?? LB07_LIMITS.concurrentRuns,
      maxQueued: options.maxQueued ?? LB07_LIMITS.maxQueued,
    }
  }

  /** Forgets every run, every count of the day and every failure a test asked for. */
  reset(): void {
    this.#runs.length = 0
    this.#failures.length = 0
  }

  /** Makes the next run fail with a code where the real service would fail it; with a goal, the next run with that goal only. */
  failNext(code: Lb07FailureCode, goal?: string): void {
    this.#failures.push({ code, goal })
  }

  /** Puts runs of another visitor in the queue, each holding the browser for `ms`, as if others got there first. */
  occupy(count: number, ms = OTHER_RUN_MS): void {
    const beats = Math.max(1, Math.ceil(ms / this.#options.tickMs))
    for (let made = 0; made < count; made += 1) {
      const now = this.#now()
      this.#runs.push({ id: randomUUID(), session: ANOTHER_VISITOR, origin: 'sample', sampleId: null, goal: 'Another visitor\'s run.', bugs: [], createdAt: now, expiresAt: now + HOUR_MS, script: otherScript(beats), deletedAt: undefined })
    }
  }

  /** When every run holds the browser: in the order they were made, each as soon as a browser is free. */
  #schedule(): Map<string, Slot> {
    const free: number[] = Array.from({ length: this.#options.concurrentRuns }, () => Number.NEGATIVE_INFINITY)
    const slots = new Map<string, Slot>()
    for (const run of this.#runs) {
      const earliest = Math.min(...free)
      const start = Math.max(run.createdAt, earliest)
      if (run.deletedAt !== undefined && run.deletedAt <= start) {
        slots.set(run.id, { start: run.deletedAt, end: run.deletedAt, finished: false })
        continue
      }
      const natural = start + run.script.beats * this.#options.tickMs
      const end = run.deletedAt === undefined ? natural : Math.min(natural, run.deletedAt)
      slots.set(run.id, { start, end, finished: end === natural })
      free[free.indexOf(earliest)] = end
    }
    return slots
  }

  /** The runs still open at a moment: made, not over and not deleted. */
  #open(slots: Map<string, Slot>, now: number): MockRun[] {
    return this.#runs.filter((run) => {
      const slot = slots.get(run.id)
      return run.createdAt <= now && slot !== undefined && slot.end > now
    })
  }

  /** How many runs are ahead of a run that waits: the open ones made before it, as the service counts them. */
  #ahead(run: MockRun, slots: Map<string, Slot>, now: number): number {
    const before = this.#open(slots, now).filter(other => other.createdAt < run.createdAt || (other.createdAt === run.createdAt && this.#runs.indexOf(other) < this.#runs.indexOf(run)))
    return Math.min(before.length, LB07_LIMITS.maxQueued)
  }

  /** How many runs a visitor has started today, less the ones the system could not do and gave back. */
  #usedToday(session: string, slots: Map<string, Slot>, now: number): number {
    const day = new Date(now).toISOString().slice(0, 10)
    return this.#runs.filter((run) => {
      if (run.session !== session || new Date(run.createdAt).toISOString().slice(0, 10) !== day) return false
      const slot = slots.get(run.id)
      const ending = run.script.ending
      const givenBack = slot !== undefined && slot.finished && slot.end <= now && ending.state === 'failed' && LB07_GIVEN_BACK.has(ending.code)
      return !givenBack
    }).length
  }

  /** The visitor's day and the limits. */
  limits(session: string): Answer {
    const now = this.#now()
    const used = this.#usedToday(session, this.#schedule(), now)
    const limit = LB07_LIMITS.runsPerVisitorPerDay
    return { status: 200, body: {
      runs: { limit, used, remaining: Math.max(0, limit - used) },
      maxGoalLength: LB07_LIMITS.maxGoalLength,
      runTimeSeconds: LB07_LIMITS.runTimeMs / 1_000,
      keptMinutes: LB07_LIMITS.keptMinutes,
      maxBugs: LB07_LIMITS.maxBugsPerRun,
      maxQueued: this.#options.maxQueued,
      resetsAt: new Date(nextReset(now)).toISOString(),
    } }
  }

  /** The bugs on offer, as the service describes them. */
  bugs(): Answer {
    return { status: 200, body: bugViews(this.#seed.catalogue) }
  }

  /** The curated samples. */
  samples(): Answer {
    return { status: 200, body: this.#seed.samples.map(sample => ({ id: sample.id, title: sample.title, goal: sample.goal, bugs: sample.bugs })) }
  }

  /** Takes the failure a test asked for, if one is for this goal. */
  #takeFailure(goal: string): Lb07FailureCode | undefined {
    const index = this.#failures.findIndex(failure => failure.goal === undefined || failure.goal === goal)
    if (index < 0) return undefined
    return this.#failures.splice(index, 1)[0]?.code
  }

  /** Starts a run: 404 for a sample there is not, 503 when the system is busy, 429 when the visitor's day is used. */
  start(session: string, body: unknown): Answer {
    const request = lb07CreateRunRequestSchema.safeParse(body)
    if (!request.success) return errorAnswer(422, 'invalid_request', 'The request is not valid.')
    let asked: { origin: 'sample' | 'custom', sampleId: string | null, goal: string, bugs: Lb07BugId[] }
    if (request.data.from === 'sample') {
      const { sampleId } = request.data
      const sample = this.#seed.samples.find(candidate => candidate.id === sampleId)
      if (!sample) return errorAnswer(404, 'unknown_sample', 'There is no sample with that id.')
      asked = { origin: 'sample', sampleId: sample.id, goal: sample.goal, bugs: [...sample.bugs] }
    }
    else {
      asked = { origin: 'custom', sampleId: null, goal: request.data.goal, bugs: [...request.data.bugs] }
    }
    const now = this.#now()
    const slots = this.#schedule()
    if (this.#open(slots, now).length >= this.#options.maxQueued) {
      return { ...errorAnswer(503, 'busy', 'The browser is busy with other visitors\' runs right now. Try again in a minute.'), headers: { 'retry-after': '60' } }
    }
    if (this.#usedToday(session, slots, now) >= LB07_LIMITS.runsPerVisitorPerDay) {
      const reset = nextReset(now)
      return { status: 429, body: { error: { code: 'daily_limit', message: `You have started ${LB07_LIMITS.runsPerVisitorPerDay} test runs today, which is the limit. It starts again at 00:00 UTC.`, resets_at: new Date(reset).toISOString() } }, headers: { 'retry-after': String(Math.ceil((reset - now) / 1_000)) } }
    }
    const script = writeScript({ ...asked, failure: this.#takeFailure(asked.goal) }, this.#seed.golden)
    const run: MockRun = { id: randomUUID(), session, ...asked, createdAt: now, expiresAt: now + LB07_LIMITS.keptMinutes * 60_000, script, deletedAt: undefined }
    this.#runs.push(run)
    return { status: 201, body: this.#view(run, this.#schedule(), now) }
  }

  /** A visitor's own run that is still there: not someone else's, not deleted, not past its hour. */
  #own(session: string, id: string, now: number): MockRun | undefined {
    return this.#runs.find(run => run.id === id && run.session === session && run.deletedAt === undefined && run.expiresAt > now)
  }

  /** The frame a run that holds the browser is in, and the beats it has run for. */
  #frameAt(run: MockRun, slot: Slot, now: number): { frame: Frame | undefined, beats: number } {
    const beats = (now - slot.start) / this.#options.tickMs
    let passed = 0
    for (const frame of run.script.frames) {
      if (beats < passed + frame.beats) return { frame, beats }
      passed += frame.beats
    }
    return { frame: run.script.frames.at(-1), beats }
  }

  /** What the API shows of a run at a moment. */
  #view(run: MockRun, slots: Map<string, Slot>, now: number): Lb07RunView {
    const slot = slots.get(run.id) ?? { start: Number.POSITIVE_INFINITY, end: Number.POSITIVE_INFINITY, finished: false }
    const base = { id: run.id, runId: run.id, origin: run.origin, sampleId: run.sampleId, goal: run.goal, bugs: run.bugs, createdAt: new Date(run.createdAt).toISOString(), expiresAt: new Date(run.expiresAt).toISOString() }
    if (now < slot.start) {
      return lb07RunViewSchema.parse({ ...base, state: 'queued', failure: null, queuePosition: this.#ahead(run, slots, now), reading: null, steps: [], replans: 0, modelCalls: 0, findings: 0, startedAt: null, endedAt: null })
    }
    const { frame } = this.#frameAt(run, slot, now)
    const shown = { reading: frame?.reading ?? null, steps: frame?.steps ?? [], replans: frame?.replans ?? 0, modelCalls: frame?.modelCalls ?? 0, findings: frame?.findings ?? 0, startedAt: new Date(slot.start).toISOString() }
    if (now < slot.end || !slot.finished) {
      const state = frame?.state ?? 'queued'
      return lb07RunViewSchema.parse({ ...base, ...shown, state, failure: null, queuePosition: state === 'queued' ? this.#ahead(run, slots, now) : null, endedAt: null })
    }
    const ending = run.script.ending
    if (ending.state === 'failed') {
      return lb07RunViewSchema.parse({ ...base, ...shown, state: 'failed', failure: { code: ending.code, message: LB07_FAILURE_MESSAGES[ending.code] }, queuePosition: null, endedAt: new Date(slot.end).toISOString() })
    }
    return lb07RunViewSchema.parse({ ...base, ...shown, state: 'done', failure: null, queuePosition: null, modelCalls: ending.report.modelCalls, replans: ending.report.replans, findings: ending.report.findings.length, endedAt: new Date(slot.end).toISOString() })
  }

  /** The visitor's runs of the last hour, newest first, ten at most. */
  list(session: string): Answer {
    const now = this.#now()
    const slots = this.#schedule()
    const mine = this.#runs.filter(run => run.session === session && run.deletedAt === undefined && run.expiresAt > now).reverse().slice(0, 10)
    return { status: 200, body: mine.map(run => this.#view(run, slots, now)) }
  }

  /** One run of the visitor's. */
  get(session: string, id: string): Answer {
    const now = this.#now()
    const run = this.#own(session, id, now)
    return run ? { status: 200, body: this.#view(run, this.#schedule(), now) } : errorAnswer(404, 'run_not_found', 'There is no such run, or it has been deleted.')
  }

  /** How a finished run ended, or the refusal for one that has not: 404 when it is not the visitor's, 409 while it goes or when it failed. */
  #ended(session: string, id: string): { run: MockRun, slot: Slot } | Answer {
    const now = this.#now()
    const run = this.#own(session, id, now)
    if (!run) return errorAnswer(404, 'run_not_found', 'There is no such run, or it has been deleted.')
    const slot = this.#schedule().get(run.id)
    if (!slot || now < slot.end || !slot.finished) return errorAnswer(409, 'not_ready', 'This run is not finished yet.')
    if (run.script.ending.state === 'failed') return errorAnswer(409, 'run_failed', 'This run failed, so there is no report to show.')
    return { run, slot }
  }

  /** The report of a finished run. */
  report(session: string, id: string): Answer {
    const found = this.#ended(session, id)
    if ('status' in found) return found
    const { run } = found
    const ending = run.script.ending
    if (ending.state !== 'done') return errorAnswer(409, 'run_failed', 'This run failed, so there is no report to show.')
    return { status: 200, body: lb07ReportSchema.parse({ runId: run.id, goal: run.goal, bugs: run.bugs, ...ending.report }) }
  }

  /** The generated test of a finished run. */
  test(session: string, id: string): Answer {
    const found = this.#ended(session, id)
    if ('status' in found) return found
    const { run } = found
    const ending = run.script.ending
    if (ending.state !== 'done') return errorAnswer(409, 'run_failed', 'This run failed, so there is no report to show.')
    return { status: 200, body: lb07TestViewSchema.parse({ filename: testFilename(run.goal), language: 'typescript', source: ending.testSource, verdict: ending.verdict }) }
  }

  /** One piece of evidence of a run, once the run has made it. */
  evidence(session: string, id: string, evidenceId: string): Answer {
    const now = this.#now()
    const run = this.#own(session, id, now)
    if (!run) return errorAnswer(404, 'run_not_found', 'There is no such run, or it has been deleted.')
    const slot = this.#schedule().get(run.id)
    const beats = slot === undefined || now < slot.start ? -1 : (Math.min(now, slot.end) - slot.start) / this.#options.tickMs
    const piece = run.script.evidence.find(candidate => candidate.id === evidenceId && candidate.at <= beats)
    if (!piece) return errorAnswer(404, 'evidence_not_found', 'This run has no such evidence.')
    const view: Lb07EvidenceView = piece.kind === 'screenshot'
      ? { id: piece.id, kind: 'screenshot', contentType: 'image/png', base64: (piece.image ?? Buffer.alloc(0)).toString('base64'), stepIndex: piece.stepIndex, engine: piece.engine }
      : { id: piece.id, kind: 'snapshot', text: piece.text ?? '', stepIndex: piece.stepIndex, engine: piece.engine }
    return { status: 200, body: lb07EvidenceViewSchema.parse(view) }
  }

  /** Deletes a visitor's run now. It does not give back the day's run. */
  remove(session: string, id: string): Answer {
    const now = this.#now()
    const run = this.#own(session, id, now)
    if (!run) return errorAnswer(404, 'run_not_found', 'There is no such run, or it has been deleted.')
    run.deletedAt = now
    return { status: 204 }
  }

  /** The spans of a run's trace that have been written by now, for the Scope; undefined while there are none, as the gateway answers 404 then. */
  spansOf(runId: string): MockSpan[] | undefined {
    const run = this.#runs.find(candidate => candidate.id === runId && candidate.session !== ANOTHER_VISITOR)
    if (!run) return undefined
    const now = this.#now()
    const slot = this.#schedule().get(run.id)
    if (!slot || now < slot.start) return undefined
    const tick = this.#options.tickMs
    const written = run.script.spans
      .map(span => ({ span, endMs: Math.round(slot.start + span.to * tick) }))
      .filter(({ endMs }) => endMs <= Math.min(now, slot.end) && (slot.finished || endMs < slot.end))
      .sort((a, b) => a.endMs - b.endMs)
    if (written.length === 0) return undefined
    return written.map(({ span, endMs }): MockSpan => ({
      v: 1,
      runId: run.id,
      system: 'lb-07',
      spanId: span.parent === undefined ? rootSpanIdOf(run.id) : spanIdOf(run.id, span.key),
      ...(span.parent === undefined ? {} : { parentId: span.parent === 'run' ? rootSpanIdOf(run.id) : spanIdOf(run.id, span.parent) }),
      kind: span.kind,
      name: span.name,
      status: span.status,
      startMs: Math.round(slot.start + span.from * tick),
      endMs,
      attrs: span.attrs,
    }))
  }

  /** Answers one of the mock's controls for LB-07: `fail` (the next run, or the next with a goal, fails with a code), `occupy` (other visitors' runs fill the queue) and `reset`. */
  control(action: string, body: Record<string, unknown>): Answer {
    switch (action) {
      case 'fail': {
        const code = LB07_FAILURE_CODES.find(candidate => candidate === body.code)
        if (code === undefined) return errorAnswer(422, 'invalid_request', 'Name one of the failure codes.')
        this.failNext(code, typeof body.goal === 'string' ? body.goal : undefined)
        return { status: 200, body: { ok: true } }
      }
      case 'occupy': {
        const count = Number(body.runs)
        const ms = body.ms === undefined ? OTHER_RUN_MS : Number(body.ms)
        if (!Number.isInteger(count) || count < 1 || count > 8 || !Number.isFinite(ms) || ms < 1 || ms > 600_000) return errorAnswer(422, 'invalid_request', 'Say how many runs (1 to 8) and how long each holds the browser.')
        this.occupy(count, ms)
        return { status: 200, body: { ok: true } }
      }
      case 'reset':
        this.reset()
        return { status: 200, body: { ok: true } }
      default:
        return errorAnswer(404, 'not_found', 'There is no such control.')
    }
  }
}
