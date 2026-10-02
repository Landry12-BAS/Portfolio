// What LB-05's API says, checked before the board uses any of it. An answer carries the output of a
// model (the SQL it wrote, the explanation) and of a database (every cell of a table), so each field
// is bounded and typed here (docs/STACK.md: Zod at every boundary), and an answer that does not fit,
// or contradicts itself, is treated as the system failing and never shown. The chart's spec is the
// one thing only half-checked here: its envelope is, and the spec itself is held to the strict
// Vega-Lite subset in chart/spec.ts at the moment it is drawn, so a refused chart never costs the
// visitor the rest of the answer. Each schema is also checked against the type generated from the
// back end's OpenAPI document, so a field the back end adds or renames is a type error here.
import type { FlaskComponents } from '@lb/api-clients'
import { z } from 'zod'

import { COLUMN_KINDS, QUESTION_OUTCOMES, SQL_LAYERS, SQL_RULES } from '#shared/data/sql-safety'

/** The longest checked SQL text the back end renders (lb05/safety.py: MAX_RENDERED_CHARS), with room to spare. */
const MAX_SQL_TEXT = 13_000
/** The most rows and columns a result can have (lb05/safety.py: MAX_ROWS and MAX_COLUMNS). */
const MAX_ROWS = 1_000
const MAX_COLUMNS = 12
/** The most queries a question can try: one, and one correction. */
const MAX_ATTEMPTS = 5
/** The longest sentence the back end sends about an outcome. */
const MAX_SENTENCE = 1_000

/** The layers and rules, the ways a question ends and the kinds of column, as the back end names them. */
export const layerSchema = z.enum(SQL_LAYERS)
export const ruleSchema = z.enum(SQL_RULES)
export const outcomeSchema = z.enum(QUESTION_OUTCOMES)
export const columnKindSchema = z.enum(COLUMN_KINDS)

/** A day, such as `2026-09-30`. */
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** A run's ID, which the Scope reads the trace by. Empty if the back end could not name it. */
const runIdSchema = z.union([z.literal(''), z.string().regex(/^[\w-]{8,64}$/)])

/** One cell of a result: text, a number, a yes or no, or nothing. */
export const cellSchema = z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()])

/** One column of a result. */
export const columnSchema = z.object({
  name: z.string().min(1).max(100),
  kind: columnKindSchema,
})

/** The table a query returned, and the checked SQL that produced it. */
export const resultSchema = z.object({
  sql: z.string().max(MAX_SQL_TEXT),
  columns: z.array(columnSchema).max(MAX_COLUMNS),
  rows: z.array(z.array(cellSchema).max(MAX_COLUMNS)).max(MAX_ROWS),
  row_count: z.int().min(0).max(MAX_ROWS),
  truncated: z.boolean(),
  elapsed_ms: z.int().min(0).max(600_000),
  tables: z.array(z.string().max(63)).max(10),
  joins: z.int().min(0).max(20),
}).refine(
  result => result.rows.every(row => row.length === result.columns.length) && result.row_count === result.rows.length,
  'every row has a cell for every column, and the count is the rows\'',
)

/** One query the model wrote, and the layer and rule that stopped it, or neither when it ran. */
export const attemptSchema = z.object({
  sql: z.string().max(MAX_SQL_TEXT),
  stopped_by: layerSchema.nullable(),
  rule: ruleSchema.nullable(),
  message: z.string().max(MAX_SENTENCE).nullable(),
}).refine(attempt => (attempt.stopped_by === null) === (attempt.rule === null), 'a layer and a rule come together')

/**
 * A chart as the back end sends it: its kind, and the spec as a JSON object. The envelope is bounded
 * here; the spec is checked against the strict subset of Vega-Lite when the chart is drawn.
 */
export const chartEnvelopeSchema = z.object({
  kind: z.enum(['bar', 'line', 'point']),
  spec: z.record(z.string().max(40), z.json()).refine(spec => JSON.stringify(spec).length <= 200_000, 'a spec is small'),
  omitted_rows: z.int().min(0).max(MAX_ROWS),
})

/** How a question ended, with everything it made. */
export const answerSchema = z.object({
  run_id: runIdSchema,
  outcome: outcomeSchema,
  as_of: daySchema,
  model_calls: z.int().min(0).max(10),
  elapsed_ms: z.int().min(0).max(600_000),
  attempts: z.array(attemptSchema).max(MAX_ATTEMPTS),
  message: z.string().max(MAX_SENTENCE).nullable(),
  result: resultSchema.nullable(),
  chart: chartEnvelopeSchema.nullable(),
  explanation: z.string().max(2_000).nullable(),
  explanation_source: z.enum(['model', 'fallback']).nullable(),
  remaining_questions: z.int().min(0).max(1_000),
}).superRefine((answer, context) => {
  const problem = contradiction(answer)
  if (problem !== undefined) context.addIssue({ code: 'custom', message: problem })
})

/** The limits the back end enforces, which are the datasheet's. */
export const limitsSchema = z.object({
  questions_per_day: z.int().min(1).max(1_000),
  query_timeout_seconds: z.number().positive().max(600),
  row_cap: z.int().min(1).max(MAX_ROWS),
  max_model_calls_per_question: z.int().min(1).max(20),
  question_deadline_seconds: z.number().positive().max(600),
})

/** A visitor's questions today, and the limits. */
export const quotaSchema = z.object({
  used: z.int().min(0).max(1_000),
  remaining: z.int().min(0).max(1_000),
  resets_at: z.iso.datetime({ offset: true }),
  limits: limitsSchema,
})

/** A column of the semantic layer, as the model is told of it. */
export const layerColumnSchema = z.object({
  name: z.string().max(63),
  type: z.string().max(40),
  description: z.string().max(400),
  values: z.array(z.union([z.string().max(100), z.number()])).max(60),
  nullable: z.boolean(),
})

/** A table of the semantic layer. */
export const layerTableSchema = z.object({
  name: z.string().max(63),
  description: z.string().max(400),
  columns: z.array(layerColumnSchema).max(40),
})

/** An allowed join: two columns that may be set equal. */
export const layerJoinSchema = z.object({ left: z.string().max(130), right: z.string().max(130) })

/** A metric, with the exact definition a question that names it is given. */
export const layerMetricSchema = z.object({
  name: z.string().max(63),
  label: z.string().max(100),
  description: z.string().max(500),
  kind: z.enum(['expression', 'worked_example']),
  definition: z.string().max(4_000),
  needs: z.array(z.string().max(63)).max(10),
  synonyms: z.array(z.string().max(100)).max(40),
})

/** A way to slice a metric, with its exact definition. */
export const layerDimensionSchema = z.object({
  name: z.string().max(63),
  description: z.string().max(500),
  expression: z.string().max(500),
  needs: z.array(z.string().max(63)).max(10),
  synonyms: z.array(z.string().max(100)).max(40),
})

/** A date phrase the question resolver understands, and the dates it means counted from the data's last day. */
export const layerRangeSchema = z.object({
  name: z.string().max(63),
  label: z.string().max(100),
  start: daySchema,
  end: daySchema,
})

/** The semantic layer: everything the model is told about the data, and so everything a query may use. */
export const semanticLayerSchema = z.object({
  version: z.int().min(1).max(1_000),
  as_of: daySchema,
  tables: z.array(layerTableSchema).max(20),
  joins: z.array(layerJoinSchema).max(40),
  metrics: z.array(layerMetricSchema).max(60),
  dimensions: z.array(layerDimensionSchema).max(60),
  ranges: z.array(layerRangeSchema).max(60),
})

/** The outcome of a question, with all it made. */
export type Answer = z.infer<typeof answerSchema>
/** One query the model wrote, and what became of it. */
export type Attempt = z.infer<typeof attemptSchema>
/** The table a query returned. */
export type QueryResult = z.infer<typeof resultSchema>
/** One cell of a result. */
export type Cell = z.infer<typeof cellSchema>
/** One column of a result. */
export type ResultColumn = z.infer<typeof columnSchema>
/** A chart as the back end sends it. */
export type ChartEnvelope = z.infer<typeof chartEnvelopeSchema>
/** The limits the back end enforces. */
export type Limits = z.infer<typeof limitsSchema>
/** A visitor's questions today, and the limits. */
export type QuotaAnswer = z.infer<typeof quotaSchema>
/** The semantic layer. */
export type SemanticLayer = z.infer<typeof semanticLayerSchema>
/** A metric of the semantic layer. */
export type LayerMetric = z.infer<typeof layerMetricSchema>
/** A way to slice a metric. */
export type LayerDimension = z.infer<typeof layerDimensionSchema>
/** A table of the semantic layer. */
export type LayerTable = z.infer<typeof layerTableSchema>

/**
 * Finds what is wrong when an answer contradicts itself, or undefined when it is consistent. The back
 * end keeps these promises (lb05/pipeline.py), and the board relies on them to know what to show, so an
 * answer that breaks one is not shown: an answered question has its table and a last query that ran, a
 * refused one has the query a layer stopped, and a question that did not run has no table or chart.
 */
export function contradiction(answer: Pick<Answer, 'outcome' | 'attempts' | 'result' | 'chart' | 'explanation'>): string | undefined {
  const last = answer.attempts.at(-1)
  if (answer.outcome === 'answered') {
    if (answer.result === null) return 'an answered question has its table'
    if (last === undefined || last.stopped_by !== null) return 'an answered question ends with a query that ran'
    return undefined
  }
  if (answer.result !== null || answer.chart !== null || answer.explanation !== null) return 'only an answered question has a table, a chart and an explanation'
  if (answer.outcome === 'refused' && (last === undefined || last.stopped_by === null)) return 'a refused question ends with a query a layer stopped'
  return undefined
}

// The checks against the back end's own document: each one compiles only while what a schema
// produces fits the shape the document describes (so a field the back end adds as required, or
// retypes, is a type error here). They exist for the type checker and cost nothing at run time.
/** The shapes the back end's OpenAPI document defines. */
type Schemas = FlaskComponents['schemas']
/** Fails to compile unless its argument is `true`. */
type Assert<T extends true> = T
/** The agreements between these schemas and the OpenAPI document, one for each shape the board reads. */
export type OpenApiChecks = [
  Assert<Answer extends Schemas['AnswerOut'] ? true : false>,
  Assert<Attempt extends Schemas['AttemptOut'] ? true : false>,
  Assert<QueryResult extends Schemas['ResultOut'] ? true : false>,
  Assert<ChartEnvelope extends Schemas['ChartOut'] ? true : false>,
  Assert<Limits extends Schemas['LimitsOut'] ? true : false>,
  Assert<QuotaAnswer extends Schemas['QuotaOut'] ? true : false>,
  Assert<SemanticLayer extends Schemas['SemanticLayerOut'] ? true : false>,
  Assert<LayerMetric extends Schemas['MetricOut'] ? true : false>,
  Assert<LayerDimension extends Schemas['DimensionOut'] ? true : false>,
  Assert<LayerTable extends Schemas['TableOut'] ? true : false>,
]
