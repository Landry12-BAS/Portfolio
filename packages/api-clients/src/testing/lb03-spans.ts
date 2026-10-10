// The spans of a mock LB-03 run, in the format the gateway's Scope route returns and the real pipeline
// writes (services/flask-systems/lb03/pipeline.py): `read pages` (the caged OCR), `injection check` with
// the guard's call under it, `extract` with the model's call under it, `validate`, `repair` when a check
// the model may fix failed, `place fields`, `check duplicates` and `journal entry`, and the root span
// `invoice reading` written last. They are fixtures: the names, the nesting and the attributes are the
// pipeline's (metadata only, never a word of the document), and every timing and token count is made up,
// so no test or page may show them as a measurement.
import { createHash } from 'node:crypto'

import type { MockSpan } from './spans.ts'

/** How a mock document's run went, which decides the spans it leaves. */
export interface Lb03Flow {
  kind: string
  // Whether the run ended with a reading (`ready`), or the failure code it stopped with.
  failure: string | undefined
  // Where a failed run stopped: the step that ended in error.
  stoppedAt: 'ocr' | 'extract' | undefined
  // Whether the model was shown the picture too (a photo), which sends the call to lb-vision.
  picture: boolean
  repair: boolean
  repairAdopted: boolean
  failedChecks: number
  placed: number
  expected: number
  compared: number
  duplicate: boolean
  journalLines: number | undefined
  pages: number
  words: number
}

/** A span before it has its run, its place in time and its ID. */
interface Plan {
  key: string
  parent: string | undefined
  kind: MockSpan['kind']
  name: string
  from: number
  to: number
  status: MockSpan['status']
  attrs: Record<string, string | number | boolean>
}

/** Makes a span ID of 16 hex digits that is the same for the same run and key. */
function spanId(runId: string, key: string): string {
  return createHash('sha256').update(`${runId}:${key}`).digest('hex').slice(0, 16)
}

/** Writes the plans of a run, one step at a time along a clock that only moves forward. */
class Planner {
  readonly plans: Plan[] = []
  calls = 0
  #clock = 0

  /** Adds a step that takes `duration` milliseconds. */
  step(key: string, name: string, duration: number, attrs: Plan['attrs'], options: { kind?: MockSpan['kind'], status?: MockSpan['status'] } = {}): void {
    const from = this.#clock
    this.#clock += duration
    this.plans.push({ key, parent: 'run', kind: options.kind ?? 'system.step', name, from, to: this.#clock, status: options.status ?? 'ok', attrs })
  }

  /** Adds a step that makes a model call through the gateway, with the call and its attempt nested under it. */
  modelStep(key: string, name: string, alias: 'lb-fast' | 'lb-vision' | 'lb-guard', duration: number, attrs: Plan['attrs'], options: { kind?: MockSpan['kind'], status?: MockSpan['status'] } = {}): void {
    const from = this.#clock
    this.step(key, name, duration, attrs, options)
    const status = options.status ?? 'ok'
    const model = alias === 'lb-guard' ? 'groq/llama-prompt-guard-2-86m' : alias === 'lb-vision' ? 'openrouter/qwen2.5-vl-32b-instruct:free' : 'groq/gpt-oss-20b'
    const provider = model.split('/')[0] ?? ''
    const inputTokens = alias === 'lb-guard' ? 640 : alias === 'lb-vision' ? 3_400 : 1_150
    const outputTokens = alias === 'lb-guard' ? 1 : 420
    const call = { alias, dataClass: 'visitor', stream: false, attempts: 1, provider, model, inputTokens, outputTokens, usage: 'reported' }
    this.plans.push({ key: `${key}.call`, parent: key, kind: 'gateway.call', name: alias, from: from + 2, to: from + duration - 2, status, attrs: call })
    this.plans.push({ key: `${key}.attempt`, parent: `${key}.call`, kind: 'gateway.attempt', name: model, from: from + 4, to: from + duration - 4, status, attrs: { provider, model, inputTokens, outputTokens } })
    this.calls += 1
  }

  /** Adds the root span, which covers everything and is written last. */
  root(attrs: Plan['attrs']): void {
    this.plans.push({ key: 'run', parent: undefined, kind: 'system.run', name: 'invoice reading', from: 0, to: this.#clock + 5, status: 'ok', attrs: { ...attrs, model_calls: this.calls } })
  }
}

/** Plans the spans of a run that went the way `flow` says. */
function plan(flow: Lb03Flow): Plan[] {
  const planner = new Planner()
  const ocrFailed = flow.stoppedAt === 'ocr'
  planner.step('ocr', 'read pages', ocrFailed ? 900 : 3_200, ocrFailed ? { code: flow.failure ?? 'ocr_failed' } : { pages: flow.pages, words: flow.words, worker_ms: 2_900, wall_ms: 3_150, rlimits: true, no_new_privileges: true, seccomp: true, landlock_abi: 3 }, { kind: 'system.tool', status: ocrFailed ? 'error' : 'ok' })
  if (!ocrFailed) {
    const flagged = flow.failure === 'injection_suspected'
    planner.modelStep('guard', 'injection check', 'lb-guard', 190, { segments: 1, flagged, score: flagged ? 0.99 : 0.01 }, { kind: 'system.tool', status: flagged ? 'error' : 'ok' })
    if (!flagged) {
      planner.modelStep('extract', 'extract', flow.picture ? 'lb-vision' : 'lb-fast', flow.picture ? 5_200 : 1_900, { alias: flow.picture ? 'lb-vision' : 'lb-fast', picture: flow.picture, attempts: 1, text_cut: false, text_chars: 900 })
      planner.step('validate', 'validate', 2, { failed: flow.failedChecks })
      if (flow.repair) {
        planner.modelStep('repair', 'repair', flow.picture ? 'lb-vision' : 'lb-fast', flow.picture ? 5_200 : 1_900, { checks: flow.failedChecks, adopted: flow.repairAdopted, failed_before: flow.failedChecks, failed_after: flow.repairAdopted ? 0 : flow.failedChecks })
      }
      planner.step('place', 'place fields', 6, { found: flow.placed, expected: flow.expected })
      planner.step('duplicates', 'check duplicates', 3, { compared: flow.compared, duplicate: flow.duplicate })
      planner.step('journal', 'journal entry', 2, flow.journalLines === undefined ? { reason: 'checks_failed' } : { lines: flow.journalLines }, { status: flow.journalLines === undefined ? 'skipped' : 'ok' })
    }
  }
  planner.root({ kind: flow.kind, outcome: flow.failure === undefined ? 'ready' : 'failed', ...(flow.failure === undefined ? {} : { failure: flow.failure }) })
  return planner.plans
}

/**
 * Makes the spans of one document's run that started at `startedAt` (Unix milliseconds) and went the way
 * `flow` says. They are in the order a stream holds them, which is the order they ended, so the root span
 * comes last.
 */
export function lb03Spans(runId: string, startedAt: number, flow: Lb03Flow): MockSpan[] {
  return plan(flow)
    .toSorted((a, b) => a.to - b.to)
    .map((item): MockSpan => ({
      v: 1,
      runId,
      system: 'lb-03',
      spanId: spanId(runId, item.key),
      ...(item.parent === undefined ? {} : { parentId: spanId(runId, item.parent) }),
      kind: item.kind,
      name: item.name,
      status: item.status,
      startMs: startedAt + item.from,
      endMs: startedAt + item.to,
      attrs: item.attrs,
    }))
}
