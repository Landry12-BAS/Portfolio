// LB-10 as the mock back end plays it: a visitor picks a target, edits its prompt, starts a run,
// polls it as it goes (each poll moves it on, as LB-01's mock does), and reads the report: the
// production prompt and the edited one scored on ten cases with intervals, the paired verdict, the
// cases that changed with both outputs, the tokens and the calls. One run a visitor a day, the
// prompt checked for its variables, OpenRouter refused to visitors: the refusals follow
// services/flask-systems/lb10/api.py and openapi.json. Nothing here measures anything: the outputs
// are written here and not by a model, the scores are a fixed story (the edited prompt regresses
// one hard case and improves nothing, so the verdict is "no detectable difference"), and the
// spans' timings are invented, so a recording made on this mock says `mock`.
import { randomBytes } from 'node:crypto'

import type { Answer } from './lb01.ts'
import { errorAnswer } from './lb01.ts'
import type { Lb10CaseSeed, Lb10PackSeed, Lb10Seed } from './lb10-seed.ts'
import { lb10Spans } from './lb10-spans.ts'
import type { MockCallSpan } from './lb10-spans.ts'
import type { MockSpan } from './spans.ts'

/** The settings a test may give the mock. */
export interface Lb10MockOptions {
  // How many polls a run takes to finish (2 by default).
  pollsToFinish?: number
}

// The datasheet's limits, as the real API enforces them.
export const RUNS_PER_DAY = 1
export const CASES_PER_RUN = 10
export const MAX_PROMPT_CHARS = 4_000
export const MAX_PROVIDERS_PER_RUN = 2
const DAY_MS = 24 * 60 * 60 * 1000
// The providers a visitor may pick, as lb10/providers.py offers them, and the alias each gives a model class.
const PROVIDERS = [
  { id: 'groq', name: 'Groq', note: 'Fast hosted inference; does not train on inputs (abuse logs are kept up to 30 days).', trains_on_inputs: false, aliases: { fast: 'lb-eval-groq-20b', tools: 'lb-eval-groq-120b', reason: 'lb-eval-groq-120b' } },
  { id: 'workers-ai', name: 'Cloudflare Workers AI', note: 'Serverless inference at the edge; does not train on inputs.', trains_on_inputs: false, aliases: { fast: 'lb-eval-cf-20b', tools: 'lb-eval-cf-120b', reason: 'lb-eval-cf-120b' } },
] as const
const PLACEHOLDER = /\{\{([a-z][a-z0-9_]*)\}\}/g
const SAMPLE_NOTE = 'Ten cases is a small sample: the intervals are wide on purpose, and a difference whose interval spans zero is not a difference this run can show.'
const GRADER_KINDS = ['exact_match', 'contains_all', 'contains_none', 'json_schema', 'json_field_equals', 'json_field_one_of', 'json_path_contains_all', 'number_within', 'length_bounds', 'citation_present', 'sql_structural']

/** One run the mock holds. */
interface Run {
  runId: string
  session: string
  day: string
  pack: Lb10PackSeed
  prompt: string
  providers: string[]
  startedAt: number
  polls: number
  finishedAt: number | null
}

/** A grade, as the report writes it. */
interface Grade {
  kind: string
  passed: boolean
  detail: string
}

/** One case's outcome under one variant, as the report writes it. */
interface Outcome {
  case_id: string
  passed: boolean
  output: string
  grades: Grade[]
  error: string | null
  latency_ms: number
  model: string
  cached: boolean
}

/** Writes a day from a moment, in UTC. */
function dayOf(moment: number): string {
  return new Date(moment).toISOString().slice(0, 10)
}

/** Makes a run ID of the shape the real API gives. */
function newRunId(): string {
  return randomBytes(16).toString('base64url')
}

/** Lists the distinct placeholders of a prompt. */
function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map(match => match[1] ?? ''))]
}

/** The ten cases a run uses: the hard ones first, then the rest, in the pack's order. A fixture, not the real sampler. */
export function sampleOf(pack: Lb10PackSeed): Lb10CaseSeed[] {
  const hard = pack.cases.filter(entry => entry.difficulty === 'hard').slice(0, 4)
  const rest = pack.cases.filter(entry => !hard.includes(entry))
  const chosen = new Set([...hard, ...rest].slice(0, CASES_PER_RUN).map(entry => entry.id))
  return pack.cases.filter(entry => chosen.has(entry.id))
}

/** The limits as the real API lists them. */
function limits(): Record<string, unknown> {
  return { cases_per_run: CASES_PER_RUN, runs_per_day: RUNS_PER_DAY, max_prompt_chars: MAX_PROMPT_CHARS, max_providers_per_run: MAX_PROVIDERS_PER_RUN, max_model_calls_per_run: 40, concurrency: 4, run_deadline_seconds: 300, grader_kinds: GRADER_KINDS }
}

/** Writes the model's answer to a case, as a fixture: a JSON object that the pack's graders would read. */
function fixtureOutput(pack: Lb10PackSeed, entry: Lb10CaseSeed, passed: boolean): string {
  const expected = entry.expected
  if (pack.output === 'tool_calls') {
    const tools = (expected.tools as string[] | null) ?? []
    const calls = passed && tools.length > 0 ? [{ name: tools[0], arguments: (expected.args as Record<string, unknown> | undefined)?.[tools[0] ?? ''] ?? {} }] : []
    return JSON.stringify({ text: passed ? '' : 'I can help with bookings only.', tool_calls: calls, tool_call_count: calls.length })
  }
  if (pack.pack === 'lb05-sql-writer') {
    return JSON.stringify({ answerable: true, sql: passed ? expected.sql : 'SELECT COUNT(*) FROM customers' })
  }
  if (pack.pack === 'lb08-generator') {
    return JSON.stringify({ name: 'Fixture workflow', nodes: [{ id: 'start', type: 'trigger', event: passed ? expected.trigger : 'manual' }], edges: [] })
  }
  if (pack.pack === 'lb01-drafter') {
    const cites = (expected.cites as string[] | undefined) ?? []
    return JSON.stringify({ answerable: true, sentences: [{ text: 'Thank you for writing to us.', sources: passed ? cites.map(key => `passage:${key}`) : [] }] })
  }
  const categories = (expected.category as string[] | undefined) ?? ['other']
  return JSON.stringify({ category: passed ? categories[0] : 'other', order_number: expected.order_number ?? null, senior_agent: null, search_query: 'policy passages' })
}

/** The fixed story of a run: production passes every case but the last hard one; the edit also fails one more hard case. */
function passes(entry: Lb10CaseSeed, index: number, variant: 'production' | 'edited', sample: Lb10CaseSeed[]): boolean {
  const hardIndexes = sample.map((item, at) => (item.difficulty === 'hard' ? at : -1)).filter(at => at >= 0)
  if (index === hardIndexes.at(-1)) return false
  return !(variant === 'edited' && index === hardIndexes[0] && hardIndexes.length > 1)
}

/** Writes one case's outcome. */
function outcome(pack: Lb10PackSeed, entry: Lb10CaseSeed, passed: boolean, cached: boolean): Outcome {
  const grades = entry.graderKinds.map((kind, at) => ({ kind, passed: passed || at !== entry.graderKinds.length - 1, detail: passed ? 'as expected' : 'expected the golden answer, got another' }))
  return { case_id: entry.id, passed, output: fixtureOutput(pack, entry, passed), grades, error: null, latency_ms: cached ? 0 : 900, model: 'mock/gpt-oss-20b', cached }
}

/** The bootstrap interval of a fixed story, written here rather than computed: a fixture. */
function interval(passed: number, cases: number): Record<string, number> {
  const mean = passed / cases
  return { mean, low: Math.max(0, mean - 0.3), high: Math.min(1, mean + 0.2), cases }
}

/** Writes one variant of the report. */
function variantOut(run: Run, variant: 'production' | 'edited', providerId: string, sample: Lb10CaseSeed[]): Record<string, unknown> {
  const provider = PROVIDERS.find(entry => entry.id === providerId) ?? PROVIDERS[0]
  const cached = variant === 'production'
  const cases = sample.map((entry, index) => outcome(run.pack, entry, passes(entry, index, variant, sample), cached))
  const passed = cases.filter(entry => entry.passed).length
  return {
    variant,
    provider: provider.id,
    alias: provider.aliases[run.pack.modelClass],
    score: interval(passed, cases.length),
    latency_p50_ms: cached ? 0 : 900,
    latency_p95_ms: cached ? 0 : 900,
    input_tokens: cached ? 0 : 410 * cases.length,
    output_tokens: cached ? 0 : 52 * cases.length,
    model_calls: cached ? 0 : cases.length,
    cached_calls: cached ? cases.length : 0,
    failed_calls: 0,
    cases,
  }
}

/** Writes the comparison of the edited prompt with production on one provider, with the changed cases. */
function comparisonOut(run: Run, production: Record<string, unknown>, edited: Record<string, unknown>, sample: Lb10CaseSeed[]): Record<string, unknown> {
  const before = production.cases as Outcome[]
  const after = edited.cases as Outcome[]
  const changed = sample.flatMap((entry, index) => {
    const was = before[index]
    const now = after[index]
    if (!was || !now || was.passed === now.passed) return []
    return [{ case_id: entry.id, difficulty: entry.difficulty, change: now.passed ? 'improved' : 'regressed', inputs: entry.inputs, expected: entry.expected, production: was, edited: now }]
  })
  const regressed = changed.filter(entry => entry.change === 'regressed').length
  const improved = changed.length - regressed
  const difference = (improved - regressed) / sample.length
  return { provider: edited.provider, alias: edited.alias, difference, low: Math.min(difference - 0.2, 0), high: Math.max(difference + 0.2, 0), verdict: 'no_detectable_difference', improved, regressed, cases: sample.length, changed }
}

/** Writes the whole report of a finished run. */
function report(run: Run): Record<string, unknown> {
  const sample = sampleOf(run.pack)
  const same = run.prompt === run.pack.systemPrompt
  const variants: Record<string, unknown>[] = []
  const comparisons: Record<string, unknown>[] = []
  for (const provider of run.providers) {
    const production = variantOut(run, 'production', provider, sample)
    variants.push(production)
    if (!same) {
      const edited = variantOut(run, 'edited', provider, sample)
      variants.push(edited)
      comparisons.push(comparisonOut(run, production, edited, sample))
    }
  }
  return {
    pack: run.pack.pack,
    pack_version: '0000000000000000',
    sample_size: sample.length,
    case_ids: sample.map(entry => entry.id),
    edited_is_production: same,
    variants,
    comparisons,
    total_model_calls: variants.reduce((sum, variant) => sum + Number(variant.model_calls), 0),
    total_cached_calls: variants.reduce((sum, variant) => sum + Number(variant.cached_calls), 0),
    total_input_tokens: variants.reduce((sum, variant) => sum + Number(variant.input_tokens), 0),
    total_output_tokens: variants.reduce((sum, variant) => sum + Number(variant.output_tokens), 0),
    sample_note: SAMPLE_NOTE,
  }
}

/** The mock's LB-10. */
export class Lb10Mock {
  readonly #seed: Lb10Seed
  readonly #now: () => number
  readonly #pollsToFinish: number
  readonly #runs = new Map<string, Run>()
  readonly #spans = new Map<string, MockSpan[]>()

  /** Starts with no runs. */
  constructor(seed: Lb10Seed, now: () => number, options: Lb10MockOptions = {}) {
    this.#seed = seed
    this.#now = now
    this.#pollsToFinish = options.pollsToFinish ?? 2
  }

  /** Forgets every run. */
  reset(): void {
    this.#runs.clear()
    this.#spans.clear()
  }

  /** Lists the targets. */
  targets(): Answer {
    return {
      status: 200,
      body: {
        can_run: true,
        limits: limits(),
        targets: this.#seed.packs.map(pack => ({
          pack: pack.pack,
          version: '0000000000000000',
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
          providers: PROVIDERS.map(provider => ({ id: provider.id, name: provider.name, note: provider.note, trains_on_inputs: provider.trains_on_inputs, alias: provider.aliases[pack.modelClass] })),
        })),
      },
    }
  }

  /** Starts a run, or refuses it the way the real API does. */
  start(session: string, request: { target: string, prompt: string, providers: string[] }): Answer {
    const pack = this.#seed.packs.find(entry => entry.pack === request.target)
    if (!pack) return errorAnswer(404, 'unknown_target', 'There is no target of that name.')
    const problem = this.#promptProblem(pack, request.prompt)
    if (problem) return { status: 422, body: { error: { code: 'invalid_prompt', message: problem.message }, problems: [problem] } }
    const providers = [...new Set(request.providers)]
    if (providers.length === 0 || providers.length > MAX_PROVIDERS_PER_RUN) return errorAnswer(422, 'invalid_providers', `Choose one or ${MAX_PROVIDERS_PER_RUN} providers.`)
    if (!providers.every(id => PROVIDERS.some(provider => provider.id === id))) return errorAnswer(422, 'invalid_providers', 'A visitor\'s prompt may run only on the providers offered.')
    const today = dayOf(this.#now())
    const mine = [...this.#runs.values()].filter(run => run.session === session && run.day === today)
    if (mine.some(run => run.finishedAt === null)) return errorAnswer(429, 'run_running', 'Your run is still going. Wait for it, then start another.')
    if (mine.length >= RUNS_PER_DAY) {
      const midnight = new Date(this.#now()).setUTCHours(0, 0, 0, 0) + DAY_MS
      return { status: 429, body: { error: { code: 'daily_limit', message: 'You have started today\'s run. The count starts again at midnight UTC.', resets_at: new Date(midnight).toISOString() } } }
    }
    const run: Run = { runId: newRunId(), session, day: today, pack, prompt: request.prompt, providers, startedAt: this.#now(), polls: 0, finishedAt: null }
    this.#runs.set(run.runId, run)
    return { status: 202, body: { run: this.#runOut(run), remaining_runs: 0 } }
  }

  /** Reads one of the visitor's runs, moving it on by one poll. */
  run(session: string, runId: string): Answer {
    const run = this.#runs.get(runId)
    if (!run || run.session !== session) return errorAnswer(404, 'not_found', 'There is no run of yours with that ID.')
    if (run.finishedAt === null) {
      run.polls += 1
      if (run.polls >= this.#pollsToFinish) this.#finish(run)
    }
    return { status: 200, body: this.#runOut(run) }
  }

  /** Lists the visitor's runs of today. */
  runsToday(session: string): Answer {
    const today = dayOf(this.#now())
    const runs = [...this.#runs.values()].filter(run => run.session === session && run.day === today).sort((a, b) => b.startedAt - a.startedAt)
    return { status: 200, body: { runs: runs.map(run => this.#runOut(run)) } }
  }

  /** Reads the visitor's quota. */
  quota(session: string): Answer {
    const today = dayOf(this.#now())
    const used = [...this.#runs.values()].filter(run => run.session === session && run.day === today).length
    const midnight = new Date(this.#now()).setUTCHours(0, 0, 0, 0) + DAY_MS
    return { status: 200, body: { used, remaining: Math.max(RUNS_PER_DAY - used, 0), resets_at: new Date(midnight).toISOString(), limits: limits() } }
  }

  /** The committed baselines: none yet, as the repository has none measured. */
  baselines(): Answer {
    return { status: 200, body: { baselines: [] } }
  }

  /** The stored nightly results: none, as the mock stores nothing. */
  nightly(): Answer {
    return { status: 200, body: { results: [] } }
  }

  /** Returns the spans of a finished run, for the Scope. */
  spansOf(runId: string): MockSpan[] | undefined {
    return this.#spans.get(runId)
  }

  /** Says what is wrong with a prompt, as lb10/prompt_check.py does, or nothing. */
  #promptProblem(pack: Lb10PackSeed, prompt: string): { code: string, message: string } | undefined {
    if (prompt.trim() === '') return { code: 'empty', message: 'The prompt is empty.' }
    if (prompt.length > MAX_PROMPT_CHARS) return { code: 'too_long', message: `The prompt is ${prompt.length.toLocaleString('en')} characters; at most ${MAX_PROMPT_CHARS.toLocaleString('en')} are allowed.` }
    const found = placeholders(prompt)
    const missing = pack.variables.filter(name => !found.includes(name))
    const unknown = found.filter(name => !pack.variables.includes(name))
    if (missing.length > 0) return { code: 'missing_variables', message: `The prompt dropped a variable the cases fill: ${missing.map(name => `{{${name}}}`).join(', ')}.` }
    if (unknown.length > 0) return { code: 'unknown_variables', message: `The prompt names a variable this pack does not have: ${unknown.map(name => `{{${name}}}`).join(', ')}.` }
    return undefined
  }

  /** Ends a run: writes its spans and marks it finished. */
  #finish(run: Run): void {
    run.finishedAt = this.#now()
    const sample = sampleOf(run.pack)
    const calls: MockCallSpan[] = []
    for (const provider of run.providers) {
      const alias = (PROVIDERS.find(entry => entry.id === provider) ?? PROVIDERS[0]).aliases[run.pack.modelClass]
      sample.forEach((entry, index) => calls.push({ alias, variant: 'production', caseId: entry.id, difficulty: entry.difficulty, passed: passes(entry, index, 'production', sample), cached: true }))
      if (run.prompt !== run.pack.systemPrompt) sample.forEach((entry, index) => calls.push({ alias, variant: 'edited', caseId: entry.id, difficulty: entry.difficulty, passed: passes(entry, index, 'edited', sample), cached: false }))
    }
    this.#spans.set(run.runId, lb10Spans(run.runId, run.startedAt, run.pack.pack, calls))
  }

  /** Writes a run as the API does: its progress while it goes, its report once it is done. */
  #runOut(run: Run): Record<string, unknown> {
    const same = run.prompt === run.pack.systemPrompt
    const total = CASES_PER_RUN * run.providers.length * (same ? 1 : 2)
    const done = run.finishedAt !== null
    const progress = done ? total : Math.min(total, Math.round((total * run.polls) / this.#pollsToFinish))
    return {
      run_id: run.runId,
      state: done ? 'done' : 'running',
      pack: run.pack.pack,
      pack_version: '0000000000000000',
      providers: run.providers,
      calls_done: progress,
      calls_total: total,
      cached_calls: CASES_PER_RUN * run.providers.length,
      started_at: new Date(run.startedAt).toISOString(),
      finished_at: run.finishedAt === null ? null : new Date(run.finishedAt).toISOString(),
      failure: null,
      report: done ? report(run) : null,
    }
  }
}
