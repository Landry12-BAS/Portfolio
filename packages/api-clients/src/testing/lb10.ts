// LB-10 as the mock back end plays it, following services/flask-systems/lb10 (api.py, service.py, quota.py,
// pipeline.py, report.py) and openapi.json: a visitor picks a target, edits its prompt, starts a run (202),
// polls it as it goes (each poll moves it on, as LB-01's mock does: the cache read, the calls, the report),
// and reads the report. What the service does, the mock does: every problem of a refused prompt listed at
// once; one run a visitor a day, counted by a ledger that gives back a run the service failed (two a day at
// most) and refuses a second one as `daily_limit` with `resets_at`; one cache for every visitor, so the
// production baseline is computed once and the next visitor's run finds it; a cached result that keeps the
// latency and tokens of the call that made it; a finished run whose `calls_done` counts the fresh calls only;
// a `lab_busy` refusal that leaves a failed run behind and is given back; spans written as the calls end.
//
// Nothing here measures anything: the outputs are the story's (lb10-story.ts), the latencies and tokens are
// invented, and a recording made on this mock says `mock`. A test sets the scene with the controls
// (`/__mock/lb10/<action>`, `control` below): the next run fails with one of the service's failure codes,
// some of its calls fail, the lab is busy or has no gateway, the nightly results and baselines exist.
import { createHash, randomBytes } from 'node:crypto'

import type { Answer } from './lb01.ts'
import { errorAnswer } from './lb01.ts'
import type { Lb10CaseSeed, Lb10PackSeed, Lb10Seed } from './lb10-seed.ts'
import { lb10Trace } from './lb10-spans.ts'
import type { MockCallSpan, MockRunEnd, MockRunTrace } from './lb10-spans.ts'
import { bootstrapInterval, editedPasses, editStory, gradesFor, latencyOf, latencyPercentiles, pairedComparison, productionPasses, replyFor, tokensOf } from './lb10-story.ts'
import type { Lb10EditStory, Lb10Grade, Lb10Variant } from './lb10-story.ts'
import type { MockSpan } from './spans.ts'

/** The settings a test may give the mock. */
export interface Lb10MockOptions {
  // How many polls a run takes to finish (4 by default): the first reads the cache, the last writes the report.
  pollsToFinish?: number
}

// The limits, as the service enforces them (services/flask-systems/lb10/limits.py).
export const RUNS_PER_DAY = 1
export const CASES_PER_RUN = 10
export const MAX_PROMPT_CHARS = 8_000
export const MAX_PROVIDERS_PER_RUN = 2
const MAX_REFUNDS_PER_DAY = 2
const MAX_CALLS_PER_RUN = 40
const DAY_MS = 24 * 60 * 60 * 1000
// The failures a test may give the next run, which the service ends a run with, and those it gives back.
export const LB10_RUN_FAILURES = ['model_budget', 'no_answers', 'time_limit', 'interrupted'] as const
const REFUNDED = new Set<string>([...LB10_RUN_FAILURES, 'call_limit'])
// The gateway's codes for a call that got no answer, which a test may give some of the next run's calls.
// They are the gateway's own codes (lb_common.gateway.GatewayCode), and the pipeline's `model_failed` for a failure with none.
export const LB10_CALL_FAILURES = ['upstream_failed', 'upstream_timeout', 'upstream_rejected', 'quota_exceeded', 'budget_exhausted', 'input_too_large', 'model_failed'] as const

/** One of the service's failures of a whole run. */
export type Lb10RunFailure = (typeof LB10_RUN_FAILURES)[number]
/** One of the gateway's codes for a call that got no answer. */
export type Lb10CallFailure = (typeof LB10_CALL_FAILURES)[number]

/** A provider a visitor may pick, as lb10/providers.py offers it, with the alias and the model each class runs. */
interface Provider {
  id: string
  name: string
  note: string
  aliases: Record<Lb10PackSeed['modelClass'], string>
  models: Record<Lb10PackSeed['modelClass'], string>
}

const PROVIDERS: readonly Provider[] = [
  {
    id: 'groq',
    name: 'Groq',
    note: 'Fast hosted inference; does not train on inputs (abuse logs are kept up to 30 days).',
    aliases: { fast: 'lb-eval-groq-20b', tools: 'lb-eval-groq-120b', reason: 'lb-eval-groq-120b' },
    models: { fast: 'openai/gpt-oss-20b', tools: 'openai/gpt-oss-120b', reason: 'openai/gpt-oss-120b' },
  },
  {
    id: 'workers-ai',
    name: 'Cloudflare Workers AI',
    note: 'Serverless inference at the edge; does not train on inputs.',
    aliases: { fast: 'lb-eval-cf-20b', tools: 'lb-eval-cf-120b', reason: 'lb-eval-cf-120b' },
    models: { fast: '@cf/openai/gpt-oss-20b', tools: '@cf/openai/gpt-oss-120b', reason: '@cf/openai/gpt-oss-120b' },
  },
]
// A placeholder in a prompt, as lb10/templates.py finds them.
const PLACEHOLDER = /\{\{([a-z][a-z0-9_]*)\}\}/g
// How many variable names a refusal lists before it says how many more (lb10/prompt_check.py).
const MAX_NAMED = 6
// A character a prompt may not hold: Python's `str.isprintable()` is false for these categories, and the space,
// the line breaks and the tab are the exceptions the service allows.
const NOT_PRINTABLE = /[\p{C}\p{Z}]/u
const ALLOWED_SPACES = new Set([' ', '\n', '\r', '\t'])
const SAMPLE_NOTE = 'Ten cases is a small sample: the intervals are wide on purpose, and a difference whose interval spans zero is not a difference this run can show.'
const GRADER_KINDS = ['exact_match', 'contains_all', 'contains_none', 'json_schema', 'json_field_equals', 'json_field_one_of', 'json_path_contains_all', 'number_within', 'length_bounds', 'citation_present', 'sql_structural']
// How much of an output the report shows, as the service cuts it.
const MAX_OUTPUT_CHARS = 2_000

/** One graded answer to one case under one prompt on one alias: what the cache holds and the report shows. */
interface CaseResult {
  case_id: string
  passed: boolean
  output: string
  grades: Lb10Grade[]
  error: string | null
  latency_ms: number
  model: string
  input_tokens: number
  output_tokens: number
}

/** One prompt on one provider: its results, and whether they came from the cache. */
interface PlannedVariant {
  variant: Lb10Variant
  provider: Provider
  alias: string
  cached: boolean
  results: CaseResult[]
}

/** One run the mock holds. */
interface Run {
  runId: string
  session: string
  day: string
  pack: Lb10PackSeed
  prompt: string
  providers: string[]
  story: Lb10EditStory
  plan: PlannedVariant[]
  startedAt: number
  polls: number
  state: 'running' | 'done' | 'failed'
  failure: string | null
  // The failure the run will end with, chosen by a test before it started.
  endsWith: Lb10RunFailure | null
  finishedAt: number | null
  trace: MockRunTrace | undefined
}

/** One visitor's count for one day, as the service's ledger keeps it. */
interface Usage {
  used: number
  refunds: number
  busy: boolean
}

/** One reason a prompt is refused, as the service lists it. */
interface PromptProblem {
  code: string
  message: string
}

/** Writes a day from a moment, in UTC. */
function dayOf(moment: number): string {
  return new Date(moment).toISOString().slice(0, 10)
}

/** Writes a moment as the service's JSON does (Pydantic): ISO 8601 in UTC, with microseconds unless there are none. */
function isoMoment(moment: number): string {
  const text = new Date(moment).toISOString()
  return text.endsWith('.000Z') ? text.replace('.000Z', 'Z') : text.replace(/Z$/, '000Z')
}

/** Writes midnight UTC after a day as the service's error does (Python's `isoformat`). */
function midnightAfter(moment: number): string {
  const midnight = new Date(moment).setUTCHours(0, 0, 0, 0) + DAY_MS
  return new Date(midnight).toISOString().replace('.000Z', '+00:00')
}

/** Makes a run ID of the shape the service gives: 22 URL-safe characters. */
function newRunId(): string {
  return randomBytes(16).toString('base64url')
}

/** Names a prompt by its hash, as the service's cache does. */
function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Lists the distinct placeholders of a prompt, in the order they first appear. */
function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map(match => match[1] ?? ''))]
}

/** Lists variable names for a message as `{{name}}`, at most a few, as the service does. */
function names(variables: readonly string[]): string {
  const shown = variables.slice(0, MAX_NAMED).map(name => `{{${name}}}`).join(', ')
  return variables.length > MAX_NAMED ? `${shown} and ${variables.length - MAX_NAMED} more` : shown
}

/** Tells whether a prompt holds a character the service does not take as plain text. */
function holdsControl(text: string): boolean {
  return [...text].some(character => NOT_PRINTABLE.test(character) && !ALLOWED_SPACES.has(character))
}

/** Lists every reason a prompt can't run on a pack, as lb10/prompt_check.py does, in its order. */
function promptProblems(pack: Lb10PackSeed, prompt: string): PromptProblem[] {
  const problems: PromptProblem[] = []
  const length = [...prompt].length
  if (prompt.trim() === '') problems.push({ code: 'empty', message: 'The prompt is empty.' })
  if (length > MAX_PROMPT_CHARS) problems.push({ code: 'too_long', message: `The prompt is ${length.toLocaleString('en')} characters; at most ${MAX_PROMPT_CHARS.toLocaleString('en')} are allowed.` })
  if (holdsControl(prompt)) problems.push({ code: 'not_text', message: 'The prompt holds control characters; it must be plain text.' })
  const found = placeholders(prompt)
  const missing = pack.variables.filter(name => !found.includes(name))
  const unknown = found.filter(name => !pack.variables.includes(name))
  if (missing.length > 0) problems.push({ code: 'missing_variables', message: `The prompt dropped a variable the cases fill: ${names(missing)}.` })
  if (unknown.length > 0) problems.push({ code: 'unknown_variables', message: `The prompt names a variable this pack does not have: ${names(unknown)}.` })
  return problems
}

/** The ten cases a run uses: the hard ones first, then the rest, in the pack's order. A fixture, not the service's seeded sampler. */
export function sampleOf(pack: Lb10PackSeed): Lb10CaseSeed[] {
  const hard = pack.cases.filter(entry => entry.difficulty === 'hard').slice(0, 4)
  const rest = pack.cases.filter(entry => !hard.includes(entry))
  const chosen = new Set([...hard, ...rest].slice(0, CASES_PER_RUN).map(entry => entry.id))
  return pack.cases.filter(entry => chosen.has(entry.id))
}

/** The limits as the service lists them. */
function limits(): Record<string, unknown> {
  return { cases_per_run: CASES_PER_RUN, runs_per_day: RUNS_PER_DAY, max_prompt_chars: MAX_PROMPT_CHARS, max_providers_per_run: MAX_PROVIDERS_PER_RUN, max_model_calls_per_run: MAX_CALLS_PER_RUN, concurrency: 4, run_deadline_seconds: 300, grader_kinds: GRADER_KINDS }
}

/** Writes one case's result under one prompt, by the story. */
function resultOf(pack: Lb10PackSeed, entry: Lb10CaseSeed, index: number, variant: Lb10Variant, provider: Provider, passed: boolean, story: Lb10EditStory, prompt: string): CaseResult {
  const prose = variant === 'edited' && story.dropsJson
  const output = replyFor(pack, entry, passed, prose)
  const tokens = tokensOf(prompt, entry, output)
  return {
    case_id: entry.id,
    passed,
    output,
    grades: gradesFor(entry, passed, prose),
    error: null,
    latency_ms: latencyOf(provider.id, variant, index),
    model: provider.models[pack.modelClass],
    input_tokens: tokens.input,
    output_tokens: tokens.output,
  }
}

/** Writes a call that got no answer: a failed case naming the gateway's code, with nothing written and no tokens. */
function failedResult(result: CaseResult, code: string): CaseResult {
  return { ...result, passed: false, output: '', grades: [], error: code, model: '', input_tokens: 0, output_tokens: 0 }
}

/** Writes one case's outcome for the report: the result as it is, the output cut as the service cuts it. */
function outcomeOut(result: CaseResult, cached: boolean): Record<string, unknown> {
  return { case_id: result.case_id, passed: result.passed, output: result.output.slice(0, MAX_OUTPUT_CHARS), grades: result.grades, error: result.error, latency_ms: result.latency_ms, model: result.model, cached }
}

/** Writes one variant of the report from its results, as lb10/report.py does. */
function variantOut(planned: PlannedVariant): Record<string, unknown> {
  const answered = planned.results.filter(result => result.error === null)
  const latency = latencyPercentiles(answered.map(result => result.latency_ms))
  const count = planned.results.length
  return {
    variant: planned.variant,
    provider: planned.provider.id,
    alias: planned.alias,
    score: bootstrapInterval(planned.results.map(result => result.passed)),
    latency_p50_ms: latency.p50,
    latency_p95_ms: latency.p95,
    input_tokens: planned.results.reduce((sum, result) => sum + result.input_tokens, 0),
    output_tokens: planned.results.reduce((sum, result) => sum + result.output_tokens, 0),
    model_calls: planned.cached ? 0 : count,
    cached_calls: planned.cached ? count : 0,
    failed_calls: planned.results.filter(result => result.error !== null).length,
    cases: planned.results.map(result => outcomeOut(result, planned.cached)),
  }
}

/** Writes the comparison of the edited prompt with production on one provider, with every case that changed. */
function comparisonOut(sample: readonly Lb10CaseSeed[], production: PlannedVariant, edited: PlannedVariant): Record<string, unknown> {
  const paired = pairedComparison(edited.results.map(result => result.passed), production.results.map(result => result.passed))
  const changed = sample.flatMap((entry, index) => {
    const was = production.results[index]
    const now = edited.results[index]
    if (!was || !now || was.passed === now.passed) return []
    return [{ case_id: entry.id, difficulty: entry.difficulty, change: now.passed ? 'improved' : 'regressed', inputs: entry.inputs, expected: entry.expected, production: outcomeOut(was, production.cached), edited: outcomeOut(now, edited.cached) }]
  })
  return { provider: edited.provider.id, alias: edited.alias, ...paired, changed }
}

/** Writes the whole report of a finished run. */
function reportOf(run: Run): Record<string, unknown> {
  const sample = sampleOf(run.pack)
  const variants = run.plan.map(variantOut)
  const comparisons = run.plan.flatMap((planned) => {
    if (planned.variant !== 'edited') return []
    const production = run.plan.find(candidate => candidate.variant === 'production' && candidate.alias === planned.alias)
    return production ? [comparisonOut(sample, production, planned)] : []
  })
  const total = (field: string) => variants.reduce((sum, variant) => sum + Number(variant[field]), 0)
  return {
    pack: run.pack.pack,
    pack_version: run.pack.version,
    sample_size: sample.length,
    case_ids: sample.map(entry => entry.id),
    edited_is_production: run.story.same,
    variants,
    comparisons,
    total_model_calls: total('model_calls'),
    total_cached_calls: total('cached_calls'),
    total_input_tokens: total('input_tokens'),
    total_output_tokens: total('output_tokens'),
    sample_note: SAMPLE_NOTE,
  }
}

/** The mock's LB-10. */
export class Lb10Mock {
  readonly #seed: Lb10Seed
  readonly #now: () => number
  readonly #pollsToFinish: number
  readonly #runs = new Map<string, Run>()
  readonly #ledger = new Map<string, Usage>()
  // Results by pack, alias and prompt hash: one cache for every visitor, as the service's.
  readonly #cache = new Map<string, CaseResult[]>()
  #nextFailure: Lb10RunFailure | null = null
  #nextCallFailure: { code: Lb10CallFailure, count: number } | null = null
  #busyNext = false
  #canRun = true
  #nightly: unknown[] = []
  #baselines: unknown[] = []

  /** Starts with no runs, an empty cache and nothing stored. */
  constructor(seed: Lb10Seed, now: () => number, options: Lb10MockOptions = {}) {
    this.#seed = seed
    this.#now = now
    this.#pollsToFinish = Math.max(1, options.pollsToFinish ?? 4)
  }

  /** Forgets every run, count, cached result, stored result and control. */
  reset(): void {
    this.#runs.clear()
    this.#ledger.clear()
    this.#cache.clear()
    this.#nextFailure = null
    this.#nextCallFailure = null
    this.#busyNext = false
    this.#canRun = true
    this.#nightly = []
    this.#baselines = []
  }

  /** Lists the targets, as the service does once it has started. */
  targets(): Answer {
    return {
      status: 200,
      body: {
        can_run: this.#canRun,
        limits: limits(),
        targets: this.#seed.packs.map(pack => ({
          pack: pack.pack,
          version: pack.version,
          system: pack.system,
          name: pack.name,
          description: pack.description,
          source: pack.source,
          alias: pack.alias,
          model_class: pack.modelClass,
          output: pack.output,
          system_prompt: pack.systemPrompt,
          user_template: pack.userTemplate,
          variables: pack.variables,
          tool_names: pack.toolNames,
          case_count: pack.cases.length,
          hard_count: pack.cases.filter(entry => entry.difficulty === 'hard').length,
          common_grader_kinds: pack.commonGraderKinds,
          sample: sampleOf(pack).map(entry => ({ id: entry.id, difficulty: entry.difficulty, inputs: entry.inputs, expected: entry.expected, grader_kinds: entry.graderKinds })),
          providers: PROVIDERS.map(provider => ({ id: provider.id, name: provider.name, note: provider.note, trains_on_inputs: false, alias: provider.aliases[pack.modelClass] })),
        })),
      },
    }
  }

  /** Starts a run, or refuses it the way the service does, in the service's order: the target, the prompt, the providers, the gateway, the count. */
  start(session: string, request: { target: string, prompt: string, providers: string[] }): Answer {
    const pack = this.#seed.packs.find(entry => entry.pack === request.target)
    if (!pack) return errorAnswer(404, 'unknown_target', 'There is no target of that name.')
    const problems = promptProblems(pack, request.prompt)
    const first = problems[0]
    if (first) return { status: 422, body: { error: { code: 'invalid_prompt', message: first.message }, problems } }
    const providers = [...new Set(request.providers)]
    if (providers.length === 0 || providers.length > MAX_PROVIDERS_PER_RUN) return errorAnswer(422, 'invalid_providers', `Choose one or ${MAX_PROVIDERS_PER_RUN} providers.`)
    if (!providers.every(id => PROVIDERS.some(provider => provider.id === id))) return errorAnswer(422, 'invalid_providers', 'A visitor\'s prompt may run only on the providers offered.')
    if (!this.#canRun) return errorAnswer(503, 'unavailable', 'The lab is not available right now.')
    const refusal = this.#admit(session)
    if (refusal) return refusal
    const run = this.#newRun(session, pack, request.prompt, providers)
    this.#runs.set(run.runId, run)
    if (this.#busyNext) {
      // The runner is full: the service ends the run it had just written as "busy" and hands the place back, spending
      // none of the day's refunds, since nothing ran (lb10/quota.py, `release`).
      this.#busyNext = false
      this.#end(run, 'failed', 'busy', false)
      const usage = this.#usage(session)
      usage.used = Math.max(usage.used - 1, 0)
      return errorAnswer(503, 'lab_busy', 'The lab is running as many evals as it can; try again in a minute.')
    }
    return { status: 202, body: { run: this.#runOut(run), remaining_runs: this.#remaining(session) } }
  }

  /** Reads one of the visitor's runs, moving it on by one poll. */
  run(session: string, runId: string): Answer {
    const run = this.#runs.get(runId)
    if (!run || run.session !== session) return errorAnswer(404, 'not_found', 'There is no run of yours with that ID.')
    if (run.state === 'running') {
      run.polls += 1
      if (run.polls >= this.#pollsToFinish) this.#finish(run)
    }
    return { status: 200, body: this.#runOut(run) }
  }

  /** Lists the visitor's runs of today, newest first. */
  runsToday(session: string): Answer {
    const today = dayOf(this.#now())
    const runs = [...this.#runs.values()].filter(run => run.session === session && run.day === today).sort((a, b) => b.startedAt - a.startedAt)
    return { status: 200, body: { runs: runs.map(run => this.#runOut(run)) } }
  }

  /** Reads the visitor's count for today. */
  quota(session: string): Answer {
    const usage = this.#usage(session)
    return { status: 200, body: { used: usage.used, remaining: Math.max(RUNS_PER_DAY - usage.used, 0), resets_at: isoMoment(Date.parse(midnightAfter(this.#now()))), limits: limits() } }
  }

  /** The committed baselines: none, unless a test has stored some. */
  baselines(): Answer {
    return { status: 200, body: { baselines: this.#baselines } }
  }

  /** The stored nightly results: none, unless a test has stored some. */
  nightly(): Answer {
    return { status: 200, body: { results: this.#nightly } }
  }

  /** Returns the spans a run has written so far, for the Scope; undefined before the first. */
  spansOf(runId: string): MockSpan[] | undefined {
    const run = this.#runs.get(runId)
    if (!run?.trace || run.polls === 0) return undefined
    const freshDone = run.state === 'running' ? this.#freshDone(run) : run.trace.calls.length
    const spans = [run.trace.cache, ...run.trace.calls.slice(0, freshDone).flat()]
    if (run.state !== 'running' && run.trace.root) spans.push(run.trace.root)
    return spans
  }

  /**
   * The controls of a test: `fail` ends the next run with a failure code ({"code": "no_answers"}), `fail-calls` makes the
   * next run's first fresh calls fail with a gateway code ({"code": "upstream_failed", "count": 3}), `busy` refuses the next
   * run as the full runner does, `unavailable` takes the gateway away or gives it back ({"on": true}), `nightly` and
   * `baselines` store what the commands would have ({"results": [...]}, {"baselines": [...]}), `reset` forgets everything.
   */
  control(action: string, body: Record<string, unknown>): Answer {
    const done: Answer = { status: 200, body: { ok: true } }
    switch (action) {
      case 'fail': {
        const code = LB10_RUN_FAILURES.find(candidate => candidate === body.code)
        if (code === undefined) return errorAnswer(422, 'invalid_request', `Name one of: ${LB10_RUN_FAILURES.join(', ')}.`)
        this.#nextFailure = code
        return done
      }
      case 'fail-calls': {
        const code = LB10_CALL_FAILURES.find(candidate => candidate === body.code)
        const count = Number(body.count ?? 1)
        if (code === undefined || !Number.isInteger(count) || count < 1 || count > MAX_CALLS_PER_RUN) return errorAnswer(422, 'invalid_request', 'Name a gateway code and how many calls (1 to 40).')
        this.#nextCallFailure = { code, count }
        return done
      }
      case 'busy':
        this.#busyNext = true
        return done
      case 'unavailable':
        this.#canRun = body.on !== true
        return done
      case 'nightly':
        if (!Array.isArray(body.results)) return errorAnswer(422, 'invalid_request', 'Send the results as a list.')
        this.#nightly = body.results
        return done
      case 'baselines':
        if (!Array.isArray(body.baselines)) return errorAnswer(422, 'invalid_request', 'Send the baselines as a list.')
        this.#baselines = body.baselines
        return done
      case 'reset':
        this.reset()
        return done
      default:
        return errorAnswer(404, 'not_found', 'There is no such control.')
    }
  }

  /** Reads a visitor's count for today, starting one at nothing. */
  #usage(session: string): Usage {
    const key = `${session}|${dayOf(this.#now())}`
    let usage = this.#ledger.get(key)
    if (!usage) {
      usage = { used: 0, refunds: 0, busy: false }
      this.#ledger.set(key, usage)
    }
    return usage
  }

  /** How many runs a visitor has left today. */
  #remaining(session: string): number {
    return Math.max(RUNS_PER_DAY - this.#usage(session).used, 0)
  }

  /** Admits a run as the service's ledger does: the day's runs first, then one at a time. Returns the refusal, or nothing. */
  #admit(session: string): Answer | undefined {
    const usage = this.#usage(session)
    if (usage.used >= RUNS_PER_DAY) {
      return { status: 429, body: { error: { code: 'daily_limit', message: 'You have started today\'s run. The count starts again at midnight UTC.', resets_at: midnightAfter(this.#now()) } } }
    }
    if (usage.busy) return errorAnswer(429, 'run_running', 'Your run is still going. Wait for it, then start another.')
    usage.used += 1
    usage.busy = true
    return undefined
  }

  /** Plans a run: production and, when it differs, the edited prompt on each provider, read from the cache where it can be. */
  #newRun(session: string, pack: Lb10PackSeed, prompt: string, providers: string[]): Run {
    const sample = sampleOf(pack)
    const story = editStory(pack, prompt)
    const production = productionPasses(sample)
    const edited = editedPasses(sample, production, story)
    const plan: PlannedVariant[] = []
    for (const id of providers) {
      const provider = PROVIDERS.find(candidate => candidate.id === id) ?? PROVIDERS[0]!
      plan.push(this.#planVariant(pack, sample, 'production', provider, pack.systemPrompt, production, story))
      if (!story.same) plan.push(this.#planVariant(pack, sample, 'edited', provider, prompt, edited, story))
    }
    this.#failSomeCalls(plan)
    const run: Run = {
      runId: newRunId(),
      session,
      day: dayOf(this.#now()),
      pack,
      prompt,
      providers,
      story,
      plan,
      startedAt: this.#now(),
      polls: 0,
      state: 'running',
      failure: null,
      endsWith: this.#nextFailure,
      finishedAt: null,
      trace: undefined,
    }
    this.#nextFailure = null
    run.trace = this.#traceOf(run)
    return run
  }

  /** Plans one prompt on one provider: the cache's results when it has them, fresh ones by the story otherwise. */
  #planVariant(pack: Lb10PackSeed, sample: Lb10CaseSeed[], variant: Lb10Variant, provider: Provider, prompt: string, passes: boolean[], story: Lb10EditStory): PlannedVariant {
    const alias = provider.aliases[pack.modelClass]
    const cached = this.#cache.get(`${pack.pack}|${alias}|${hashOf(prompt)}`)
    if (cached) return { variant, provider, alias, cached: true, results: cached }
    const results = sample.map((entry, index) => resultOf(pack, entry, index, variant, provider, passes[index] ?? false, story, prompt))
    return { variant, provider, alias, cached: false, results }
  }

  /** Makes the first fresh calls of the edited prompt fail with a gateway code, when a test asked for it. */
  #failSomeCalls(plan: PlannedVariant[]): void {
    const failing = this.#nextCallFailure
    if (!failing) return
    this.#nextCallFailure = null
    let left = failing.count
    for (const planned of plan.filter(candidate => !candidate.cached && candidate.variant === 'edited')) {
      planned.results = planned.results.map((result) => {
        if (left <= 0) return result
        left -= 1
        return failedResult(result, failing.code)
      })
    }
  }

  /** How the run's trace will end, from the failure chosen for it. */
  #endOf(run: Run): MockRunEnd {
    switch (run.endsWith) {
      case null: return { kind: 'done' }
      case 'time_limit': return { kind: 'timed_out' }
      case 'interrupted': return { kind: 'no_root' }
      default: return { kind: 'failed', outcome: run.endsWith }
    }
  }

  /** Writes the run's spans: the fresh calls only, each failed when the run fails for want of answers. */
  #traceOf(run: Run): MockRunTrace {
    const sample = sampleOf(run.pack)
    const nothingAnswers = run.endsWith === 'model_budget' || run.endsWith === 'no_answers'
    const gatewayCode = run.endsWith === 'model_budget' ? 'quota_exceeded' : 'upstream_failed'
    const calls: MockCallSpan[] = run.plan.filter(planned => !planned.cached).flatMap(planned => planned.results.map((result, index) => ({
      alias: planned.alias,
      provider: planned.provider.id,
      variant: planned.variant,
      caseId: result.case_id,
      difficulty: sample[index]?.difficulty ?? 'easy',
      passed: nothingAnswers ? false : result.passed,
      latencyMs: result.latency_ms,
      inputTokens: nothingAnswers ? 0 : result.input_tokens,
      outputTokens: nothingAnswers ? 0 : result.output_tokens,
      model: nothingAnswers ? '' : result.model,
      errorCode: nothingAnswers ? gatewayCode : result.error,
    })))
    const wanted = run.plan.length * sample.length
    const found = run.plan.filter(planned => planned.cached).length * sample.length
    const facts = { pack: run.pack.pack, packVersion: run.pack.version, cases: sample.length, providers: run.providers.length, wanted, found, calls }
    return lb10Trace(run.runId, run.startedAt, facts, this.#endOf(run))
  }

  /** How many of the run's fresh calls have ended, as far as its polls have got. */
  #freshDone(run: Run): number {
    const fresh = run.trace?.calls.length ?? 0
    if (run.polls <= 1 || this.#pollsToFinish <= 1) return 0
    return Math.min(fresh, Math.round((fresh * (run.polls - 1)) / (this.#pollsToFinish - 1)))
  }

  /** Ends a run as the chosen failure says, or with its report, keeping its fresh answers in the cache. */
  #finish(run: Run): void {
    if (run.endsWith !== null) {
      this.#end(run, 'failed', run.endsWith, REFUNDED.has(run.endsWith))
      return
    }
    for (const planned of run.plan) {
      if (planned.cached || planned.results.some(result => result.error !== null)) continue
      this.#cache.set(`${run.pack.pack}|${planned.alias}|${hashOf(planned.variant === 'production' ? run.pack.systemPrompt : run.prompt)}`, planned.results)
    }
    this.#end(run, 'done', null, false)
  }

  /** Ends a run, frees the visitor's place, and gives the run back when asked and allowed (two a day). */
  #end(run: Run, state: 'done' | 'failed', failure: string | null, refund: boolean): void {
    run.state = state
    run.failure = failure
    run.finishedAt = this.#now()
    const usage = this.#usage(run.session)
    usage.busy = false
    if (refund && usage.refunds < MAX_REFUNDS_PER_DAY) {
      usage.used = Math.max(usage.used - 1, 0)
      usage.refunds += 1
    }
  }

  /** Writes a run as the API does: its progress while it goes, its report once it is done. */
  #runOut(run: Run): Record<string, unknown> {
    const sampleSize = sampleOf(run.pack).length
    const total = sampleSize * run.providers.length * (run.story.same ? 1 : 2)
    const cached = run.plan.filter(planned => planned.cached).length * sampleSize
    const fresh = run.trace?.calls.length ?? 0
    let done = 0
    if (run.state === 'running' && run.polls >= 1) done = cached + this.#freshDone(run)
    else if (run.state === 'done') done = fresh
    else if (run.state === 'failed' && run.failure !== 'busy') done = cached + fresh
    return {
      run_id: run.runId,
      state: run.state,
      pack: run.pack.pack,
      pack_version: run.pack.version,
      providers: run.providers,
      calls_done: done,
      calls_total: total,
      cached_calls: run.polls >= 1 || run.state === 'done' ? cached : 0,
      started_at: isoMoment(run.startedAt),
      finished_at: run.finishedAt === null ? null : isoMoment(run.finishedAt),
      failure: run.failure,
      report: run.state === 'done' ? reportOf(run) : null,
    }
  }
}
