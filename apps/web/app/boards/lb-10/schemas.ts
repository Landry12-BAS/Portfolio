// What LB-10's API says, checked before the board uses any of it (docs/STACK.md: Zod at every boundary). The
// targets carry the other systems' production prompts and their golden cases; a run's report carries what models
// wrote and what the graders said, which are untrusted text and are only ever shown as text. Every field is
// bounded: an answer that does not fit is treated as the system failing and is never drawn. The service counts
// characters as Python does (code points), and a JavaScript string counts a letter outside the basic plane twice,
// so a bound on text the service cuts is twice its limit here. Each shape is also checked against the type
// generated from the service's OpenAPI document, so a field the service adds or renames is a type error here and
// not a blank on the page.
import type { FlaskComponents } from '@lb/api-clients'
import { z } from 'zod'

/** The states a run passes through: it runs, then it is done (with its report) or failed (with a code). */
export const RUN_STATES = ['running', 'done', 'failed'] as const
/** What the paired comparison says in one word. */
export const VERDICTS = ['better', 'worse', 'no_detectable_difference', 'not_comparable'] as const
/** Which prompt a result belongs to. */
export const VARIANTS = ['production', 'edited'] as const
/** How hard a case is, which the fixed sample is stratified by. */
export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const

/** A share from 0 to 1, such as a score or one end of its interval. */
const share = z.number().min(0).max(1)
/** A difference of two shares, from -1 to 1. */
const difference = z.number().min(-1).max(1)
/** A whole count that can't be negative, with a ceiling no honest answer reaches. */
const count = (ceiling: number) => z.int().min(0).max(ceiling)
/** A moment, as ISO 8601 text: the service writes `...Z` in its models and `...+00:00` in an error. */
const moment = z.string().min(10).max(40).refine(text => !Number.isNaN(Date.parse(text)), 'a moment')
/** A run's own ID: the service makes it from random bytes, so it is a short word of URL-safe characters. */
export const runIdSchema = z.string().regex(/^[\w-]{8,64}$/)
/** A pack's name, as the service's target names are written. */
const packName = z.string().max(80).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
/** A pack's version: a short hash of its content. */
const packVersion = z.string().regex(/^[0-9a-f]{1,64}$/)
/** A provider's ID, as the service's request names one. */
const providerId = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/)
/** A pinned eval alias, such as `lb-eval-groq-120b`. */
const alias = z.string().min(1).max(40)
/** A grader's kind, one of the service's closed set (the board has words for each, and says the name of one it does not know). */
const graderKind = z.string().min(1).max(40)
/** A case's inputs: the text each placeholder of the templates is filled with, at most 8,000 characters each. */
const inputs = z.record(z.string().max(40), z.string().max(16_000))
/** What a case expects, in the golden set's own words: JSON for people to read, never anything else. */
const expected = z.record(z.string().max(60), z.json())

/** A provider a visitor may pick for a target, with the pinned alias its model class maps to. */
export const providerSchema = z.object({
  id: providerId,
  name: z.string().min(1).max(80),
  // An English sentence on what the provider does with inputs: the board has its own words for the providers it knows.
  note: z.string().max(400),
  trains_on_inputs: z.boolean(),
  alias,
})

/** One case of a target's fixed sample: its inputs, what it expects and the graders that decide it. */
export const targetCaseSchema = z.object({
  id: z.string().min(1).max(80),
  difficulty: z.enum(DIFFICULTIES),
  inputs,
  expected,
  grader_kinds: z.array(graderKind).max(20),
})

/** One target: a pack with its production prompt, the variables an edit must keep, its tools and its sample. */
export const targetSchema = z.object({
  pack: packName,
  version: packVersion,
  system: z.string().regex(/^lb-\d{2}$/),
  name: z.string().min(1).max(80),
  // An English sentence from the pack: the board has its own words for the packs it knows.
  description: z.string().max(1_200),
  source: z.string().max(400),
  alias: z.string().min(1).max(40),
  model_class: z.enum(['fast', 'tools', 'reason']),
  output: z.enum(['json', 'text', 'tool_calls']),
  system_prompt: z.string().min(1).max(24_000),
  user_template: z.string().min(1).max(24_000),
  variables: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/).max(40)).max(30),
  tool_names: z.array(z.string().max(64)).max(20),
  case_count: count(1_000),
  hard_count: count(1_000),
  common_grader_kinds: z.array(graderKind).max(10),
  sample: z.array(targetCaseSchema).max(20),
  providers: z.array(providerSchema).max(5),
})

/** The limits LB-10 enforces, which are the ones its datasheet promises. */
export const labLimitsSchema = z.object({
  cases_per_run: z.int().positive().max(100),
  runs_per_day: z.int().positive().max(100),
  max_prompt_chars: z.int().positive().max(100_000),
  max_providers_per_run: z.int().positive().max(10),
  max_model_calls_per_run: z.int().positive().max(1_000),
  concurrency: z.int().positive().max(100),
  run_deadline_seconds: z.number().positive().max(86_400),
  grader_kinds: z.array(graderKind).max(30),
})

/** Every target, the limits, and whether the lab can run at all (it has a gateway). */
export const targetsSchema = z.object({
  targets: z.array(targetSchema).max(20),
  limits: labLimitsSchema,
  can_run: z.boolean(),
})

/** One grader's verdict on one case: its kind, whether it passed, and an English sentence on what it compared. */
export const gradeSchema = z.object({
  kind: graderKind,
  passed: z.boolean(),
  detail: z.string().max(800),
})

/** One case under one prompt: whether it passed, what the model wrote (cut at 2,000 characters), and what each grader said. */
export const outcomeSchema = z.object({
  case_id: z.string().min(1).max(80),
  passed: z.boolean(),
  output: z.string().max(4_000),
  grades: z.array(gradeSchema).max(20),
  // The gateway's code when the call got no answer.
  error: z.string().max(40).nullable(),
  latency_ms: count(10_000_000),
  model: z.string().max(120),
  cached: z.boolean(),
})

/** A share with its 95% confidence interval. */
export const intervalSchema = z.object({
  mean: share,
  low: share,
  high: share,
  cases: count(200),
})

/** One prompt on one provider: its score, its cost and every case. */
export const variantSchema = z.object({
  variant: z.enum(VARIANTS),
  provider: providerId,
  alias,
  score: intervalSchema,
  latency_p50_ms: count(10_000_000),
  latency_p95_ms: count(10_000_000),
  input_tokens: count(100_000_000),
  output_tokens: count(100_000_000),
  model_calls: count(200),
  cached_calls: count(200),
  failed_calls: count(200),
  cases: z.array(outcomeSchema).max(20),
})

/** A case whose grade changed between production and the edited prompt, with both outputs. */
export const changedCaseSchema = z.object({
  case_id: z.string().min(1).max(80),
  difficulty: z.enum(DIFFICULTIES),
  change: z.enum(['improved', 'regressed']),
  inputs,
  expected,
  production: outcomeSchema,
  edited: outcomeSchema,
})

/** The edited prompt against production on one provider, on the same cases: the paired difference and its verdict. */
export const comparisonSchema = z.object({
  provider: providerId,
  alias,
  difference,
  low: difference,
  high: difference,
  verdict: z.enum(VERDICTS),
  improved: count(200),
  regressed: count(200),
  cases: count(200),
  changed: z.array(changedCaseSchema).max(20),
})

/** The whole report of a finished run. */
export const reportSchema = z.object({
  pack: packName,
  pack_version: packVersion,
  sample_size: count(100),
  case_ids: z.array(z.string().max(80)).max(20),
  edited_is_production: z.boolean(),
  variants: z.array(variantSchema).max(4),
  comparisons: z.array(comparisonSchema).max(2),
  total_model_calls: count(1_000),
  total_cached_calls: count(1_000),
  total_input_tokens: count(1_000_000_000),
  total_output_tokens: count(1_000_000_000),
  // The service's English sentence on the small sample: the board says it in the visitor's language.
  sample_note: z.string().max(600),
})

/** A run's state: how far it has got, and its report once it is done or its failure's code once it has failed. */
export const runSchema = z.object({
  run_id: runIdSchema,
  state: z.enum(RUN_STATES),
  pack: packName,
  pack_version: packVersion,
  providers: z.array(providerId).max(5),
  calls_done: count(1_000),
  calls_total: count(1_000),
  cached_calls: count(1_000),
  started_at: moment,
  finished_at: moment.nullable(),
  failure: z.string().max(40).nullable(),
  report: reportSchema.nullable(),
})

/** The answer to a run that was taken: the run, and the runs the visitor has left today. */
export const startedSchema = z.object({
  run: runSchema,
  remaining_runs: count(100),
})

/** The visitor's runs of today, newest first. */
export const runsSchema = z.object({
  runs: z.array(runSchema).max(20),
})

/** The visitor's runs today, and the limits. */
export const quotaSchema = z.object({
  used: count(1_000),
  remaining: count(1_000),
  resets_at: moment,
  limits: labLimitsSchema,
})

/** One committed baseline: a pack's score on an alias, with its interval, and when and how it was measured. */
export const baselineSchema = z.object({
  pack: packName,
  pack_version: packVersion,
  alias,
  score: share,
  low: share,
  high: share,
  cases: z.int().positive().max(1_000),
  measured_on: z.string().max(40),
  source: z.enum(['live', 'offline']),
})

/** The committed baselines the CI gate compares fresh scores with. */
export const baselinesSchema = z.object({
  baselines: z.array(baselineSchema).max(200),
})

/** One stored nightly result: an eval of a pack on an alias, or the judge's scores on it. Its report is read by kind below. */
export const nightlyRowSchema = z.object({
  run_on: z.string().max(40),
  kind: z.enum(['eval', 'judge']),
  pack: packName,
  pack_version: packVersion,
  alias,
  report: z.record(z.string().max(60), z.json()),
})

/** The stored nightly results, newest first. */
export const nightlySchema = z.object({
  results: z.array(nightlyRowSchema).max(400),
})

/** The report of a nightly eval row: the production prompt's score on one alias, and what it cost (lb10/evals.py, `VariantRecord` without its cases). */
export const nightlyEvalSchema = z.object({
  provider: providerId,
  score: intervalSchema,
  latency_p50_ms: count(10_000_000),
  model_calls: count(10_000),
  cached_calls: count(10_000),
  failed_calls: count(10_000),
})

/** The report of a nightly judge row: whether its scores count tonight, and how it graded (lb10/evals.py, `judge_record` without its verdicts). */
export const nightlyJudgeSchema = z.object({
  counts: z.boolean(),
  judged: count(10_000),
  unreadable_verdicts: count(10_000),
  judge_pass_rate: share,
  judge_low: share,
  judge_high: share,
  rule_pass_rate: share,
  agreement_with_rules: share,
})

/** One target, as the board reads it. */
export type Lb10Target = z.infer<typeof targetSchema>
/** One case of a target's sample. */
export type Lb10TargetCase = z.infer<typeof targetCaseSchema>
/** A provider a visitor may pick. */
export type Lb10Provider = z.infer<typeof providerSchema>
/** Every target and the limits. */
export type Lb10Targets = z.infer<typeof targetsSchema>
/** The limits LB-10 enforces. */
export type Lb10Limits = z.infer<typeof labLimitsSchema>
/** One grader's verdict. */
export type Lb10Grade = z.infer<typeof gradeSchema>
/** One case under one prompt. */
export type Lb10Outcome = z.infer<typeof outcomeSchema>
/** A share with its interval. */
export type Lb10Interval = z.infer<typeof intervalSchema>
/** One prompt on one provider. */
export type Lb10VariantReport = z.infer<typeof variantSchema>
/** A case that changed, with both outputs. */
export type Lb10ChangedCase = z.infer<typeof changedCaseSchema>
/** The paired comparison on one provider. */
export type Lb10Comparison = z.infer<typeof comparisonSchema>
/** The report of a finished run. */
export type Lb10Report = z.infer<typeof reportSchema>
/** A run's state. */
export type Lb10Run = z.infer<typeof runSchema>
/** The answer to a run that was taken. */
export type Lb10Started = z.infer<typeof startedSchema>
/** The visitor's count for today. */
export type Lb10Quota = z.infer<typeof quotaSchema>
/** One committed baseline. */
export type Lb10Baseline = z.infer<typeof baselineSchema>
/** One stored nightly row. */
export type Lb10NightlyRow = z.infer<typeof nightlyRowSchema>
/** The report of a nightly eval row. */
export type Lb10NightlyEval = z.infer<typeof nightlyEvalSchema>
/** The report of a nightly judge row. */
export type Lb10NightlyJudge = z.infer<typeof nightlyJudgeSchema>
/** What the paired comparison says. */
export type Lb10Verdict = (typeof VERDICTS)[number]
/** Which prompt a result belongs to. */
export type Lb10Variant = (typeof VARIANTS)[number]

// The checks against the back end's own document: each one compiles only while what a schema produces has every
// field the document requires (and a compatible type for it). They exist for the type checker and cost nothing at
// run time.
/** The shapes the back end's OpenAPI document defines. */
type Schemas = FlaskComponents['schemas']
/** Fails to compile unless its argument is `true`. */
type Assert<T extends true> = T
/** The agreements between these schemas and the OpenAPI document, one for each shape the board reads. */
export type OpenApiChecks = [
  Assert<Lb10Targets extends Schemas['TargetsOut'] ? true : false>,
  Assert<Lb10Target extends Schemas['TargetOut'] ? true : false>,
  Assert<Lb10TargetCase extends Schemas['TargetCaseOut'] ? true : false>,
  Assert<Lb10Provider extends Schemas['ProviderOut'] ? true : false>,
  Assert<Lb10Limits extends Schemas['LabLimitsOut'] ? true : false>,
  Assert<Lb10Run extends Schemas['RunOut'] ? true : false>,
  Assert<Lb10Started extends Schemas['StartedOut'] ? true : false>,
  Assert<Lb10Report extends Schemas['ReportOut'] ? true : false>,
  Assert<Lb10VariantReport extends Schemas['VariantOut'] ? true : false>,
  Assert<Lb10Outcome extends Schemas['CaseOutcomeOut'] ? true : false>,
  Assert<Lb10Comparison extends Schemas['ComparisonOut'] ? true : false>,
  Assert<Lb10ChangedCase extends Schemas['ChangedCaseOut'] ? true : false>,
  Assert<Lb10Quota extends Schemas['LabQuotaOut'] ? true : false>,
  Assert<Lb10Baseline extends Schemas['BaselineOut'] ? true : false>,
  Assert<Lb10NightlyRow extends Schemas['NightlyOut'] ? true : false>,
  Assert<z.infer<typeof runsSchema> extends Schemas['RunsOut'] ? true : false>,
  Assert<z.infer<typeof baselinesSchema> extends Schemas['BaselinesOut'] ? true : false>,
  Assert<z.infer<typeof nightlySchema> extends Schemas['NightlyListOut'] ? true : false>,
]
