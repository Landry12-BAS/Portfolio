// The only chart the board will draw: the small subset of Vega-Lite 5 that LB-05's back end writes
// (services/flask-systems/lb05/chart.py), described as a strict Zod schema. A Vega-Lite spec can carry
// a `url` to fetch, expressions, signals, transforms and selections, and nothing of the sort is
// accepted here: one mark (bar, line or point), the data written into the spec, up to three encoded
// fields with the generated names `x`, `y` and `series`, and the few settings the back end sets. Every
// key not listed is refused, so a spec that came from anywhere else, or was changed on the way, is not
// drawn at all; the answer still shows its table. The spec is data for the board to draw, never code.
import { z } from 'zod'

import type { ChartEnvelope } from '../schemas'
import { plainText } from '../text'

/** The one schema address the back end writes. */
export const VEGA_LITE_SCHEMA_URL = 'https://vega.github.io/schema/vega-lite/v5.json'
/** The most points a chart draws (lb05/chart.py: MAX_POINTS). */
export const MAX_POINTS = 200
/** The most series a chart tells apart (lb05/chart.py: MAX_SERIES). */
export const MAX_SERIES = 8
/** The longest title or label (lb05/chart.py: MAX_LABEL_CHARS). */
const MAX_LABEL = 60

/** A title or label: short text with anything that cannot be shown taken out. */
const labelSchema = z.string().max(MAX_LABEL).transform(plainText)

/** A day or a moment as ISO 8601 text, which is how the back end writes a date cell. */
const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]{1,20}(?:Z|[+-]\d{2}:\d{2})?)?$/

/** One value of a point: text, a number or nothing. */
const datumSchema = z.union([labelSchema, z.number().refine(Number.isFinite, 'a number is finite'), z.null()])

/** One point: the generated names `x` and `y`, and `series` when the chart tells series apart. */
const pointSchema = z.strictObject({ x: datumSchema, y: datumSchema, series: datumSchema.optional() })

/** The kinds of axis the back end writes. */
const axisTypeSchema = z.enum(['nominal', 'ordinal', 'quantitative', 'temporal'])

/** The horizontal channel: a title, the kind of axis and, for labels, the order they came in. */
const xChannelSchema = z.strictObject({
  field: z.literal('x'),
  type: axisTypeSchema,
  title: labelSchema,
  sort: z.array(labelSchema).max(MAX_POINTS).optional(),
})

/** The vertical channel: always a quantity. */
const yChannelSchema = z.strictObject({
  field: z.literal('y'),
  type: z.literal('quantitative'),
  title: labelSchema,
})

/** The colour channel, which tells series apart by name. */
const colorChannelSchema = z.strictObject({
  field: z.literal('series'),
  type: z.literal('nominal'),
  title: labelSchema,
})

/** The parts of a chart as the back end writes them, before they are compared with each other. */
const chartSpecShape = z.strictObject({
  $schema: z.literal(VEGA_LITE_SCHEMA_URL),
  description: z.string().max(200).transform(plainText),
  data: z.strictObject({ values: z.array(pointSchema).max(MAX_POINTS) }),
  mark: z.strictObject({ type: z.enum(['bar', 'line', 'point']), tooltip: z.boolean().optional() }),
  encoding: z.strictObject({ x: xChannelSchema, y: yChannelSchema, color: colorChannelSchema.optional() }),
  width: z.literal('container'),
  height: z.int().min(100).max(600),
})

/** The parts of a chart, each accepted on its own. */
type ChartShape = z.infer<typeof chartSpecShape>

/** The kinds of axis. */
type AxisType = z.infer<typeof axisTypeSchema>

/** One point of an accepted chart. */
export type ChartPoint = z.infer<typeof pointSchema>

/** Tells whether a value fits the kind of axis it sits on. */
function fitsAxis(value: ChartPoint['x'], axis: AxisType): boolean {
  if (value === null) return true
  if (axis === 'temporal') return typeof value === 'string' && ISO_MOMENT.test(value)
  if (axis === 'quantitative') return typeof value === 'number'
  return typeof value === 'string' || typeof value === 'number'
}

/**
 * Finds what is wrong when a chart's parts do not agree with each other, or undefined when they do:
 * a colour channel needs a series in every point and a point carries a series only when there is one,
 * values must fit their axes, there are at most eight series, and a label order lists only labels
 * the chart has.
 */
function inconsistency(spec: ChartShape): string | undefined {
  const { values } = spec.data
  const hasSeries = spec.encoding.color !== undefined
  if (values.some(point => (point.series !== undefined) !== hasSeries)) return 'series only where the chart has a colour channel'
  if (!values.every(point => fitsAxis(point.x, spec.encoding.x.type) && fitsAxis(point.y, 'quantitative'))) return 'values fit their axes'
  if (new Set(values.map(point => point.series)).size > MAX_SERIES) return 'at most eight series'
  const sort = spec.encoding.x.sort
  if (sort !== undefined) {
    const labels = new Set(values.map(point => String(point.x)))
    if (!sort.every(label => labels.has(label))) return 'a label order lists only labels the chart has'
  }
  return undefined
}

/** The chart as the back end writes it, and nothing more. */
export const chartSpecSchema = chartSpecShape.superRefine((spec, context) => {
  const problem = inconsistency(spec)
  if (problem !== undefined) context.addIssue({ code: 'custom', message: problem })
})

/** A chart the board accepted. */
export type ChartSpec = z.infer<typeof chartSpecSchema>

/** What a check of a chart found: the chart, or the reason it was refused. */
export type ChartCheck = { ok: true, spec: ChartSpec } | { ok: false, reason: string }

/** Says why a spec was refused in a few words that never repeat what the spec held: what kind of problem, and where. */
function describeRefusal(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return 'not a chart the board draws'
  const where = issue.path.map(String).join('.')
  return where === '' ? issue.code : `${issue.code} at ${where}`
}

/**
 * Checks a chart envelope from the back end: its spec must be the strict subset above and its mark must
 * be the kind the envelope names. Anything else is refused, with a reason that names no value from the spec.
 */
export function checkChart(chart: ChartEnvelope): ChartCheck {
  const parsed = chartSpecSchema.safeParse(chart.spec)
  if (!parsed.success) return { ok: false, reason: describeRefusal(parsed.error) }
  if (parsed.data.mark.type !== chart.kind) return { ok: false, reason: 'custom at mark.type' }
  return { ok: true, spec: parsed.data }
}
