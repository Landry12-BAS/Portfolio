// The chart the mock's LB-05 builds from a result, by the same rules as the real one
// (services/flask-systems/lb05/chart.py): a date and a number make a line, a label and a number make
// bars (coloured by a second label when it has few values), a period in whole numbers is a label in
// order, two numbers make a scatter, and anything else has no honest chart. The spec is the closed
// subset of Vega-Lite 5 the real service writes, with the generated field names `x`, `y` and `series`.

/** The kinds of value a result column holds. */
export type ColumnKind = 'text' | 'integer' | 'number' | 'date' | 'boolean' | 'other'

/** One column of a result. */
export interface MockColumn {
  name: string
  kind: ColumnKind
}

/** One cell of a result. */
export type MockCell = string | number | boolean | null

/** A chart as the API describes it. */
export interface MockChart {
  kind: 'bar' | 'line' | 'point'
  spec: Record<string, unknown>
  omitted_rows: number
}

/** The kinds of axis a chart has. */
type AxisType = 'nominal' | 'ordinal' | 'quantitative' | 'temporal'

// The most points a chart draws, and the most colours it uses (chart.py).
const MAX_POINTS = 200
const MAX_SERIES = 8
const MAX_LABEL = 60
const CHART_HEIGHT = 280
const SCHEMA_URL = 'https://vega.github.io/schema/vega-lite/v5.json'
const PERIOD_NAMES = new Set(['year', 'quarter', 'month', 'week', 'day', 'weekday'])
const PERIOD_ENDINGS = ['_year', '_quarter', '_month', '_week']
const PERIOD_BEGINNINGS = ['year_', 'quarter_', 'month_', 'week_']

/** Which columns of a result can be drawn, by what they hold. */
interface Groups {
  text: number[]
  date: number[]
  number: number[]
}

/** Which columns a chart draws. */
interface Axes {
  x: number
  y: number
  series: number | undefined
  xType: AxisType
}

/** Groups a result's columns by what can be drawn. */
function groupColumns(columns: readonly MockColumn[]): Groups {
  const groups: Groups = { text: [], date: [], number: [] }
  columns.forEach((column, position) => {
    if (column.kind === 'text') groups.text.push(position)
    else if (column.kind === 'date') groups.date.push(position)
    else if (column.kind === 'integer' || column.kind === 'number') groups.number.push(position)
  })
  return groups
}

/** Tells whether a whole-number column is named for a period, such as `year`. */
function namesAPeriod(column: MockColumn): boolean {
  if (column.kind !== 'integer') return false
  const name = column.name.toLowerCase()
  return PERIOD_NAMES.has(name) || PERIOD_ENDINGS.some(ending => name.endsWith(ending)) || PERIOD_BEGINNINGS.some(start => name.startsWith(start))
}

/** Makes a column's name a short axis title. */
function titleOf(column: MockColumn | undefined): string {
  return (column?.name ?? '').replaceAll('_', ' ').slice(0, MAX_LABEL)
}

/** Picks a text column to colour the series by, when it has few enough different values to tell apart. */
function seriesPosition(rows: readonly MockCell[][], candidates: readonly number[], taken: readonly number[]): number | undefined {
  return candidates.find((position) => {
    if (taken.includes(position)) return false
    const distinct = new Set(rows.map(row => row[position])).size
    return distinct > 1 && distinct <= MAX_SERIES
  })
}

/** Writes an x value for the spec: labels as bounded text, numbers and dates as they are. */
function xValue(cell: MockCell | undefined, axis: AxisType): string | number | null {
  if (axis === 'nominal') return String(cell).slice(0, MAX_LABEL)
  return typeof cell === 'string' || typeof cell === 'number' ? cell : null
}

/** Keeps a cell that is a number, and turns anything else into nothing. */
function numberOrNull(cell: MockCell | undefined): number | null {
  return typeof cell === 'number' ? cell : null
}

/** Writes the chart's data: one entry per row, with generated field names and bounded values. */
function pointsOf(rows: readonly MockCell[][], axes: Axes): Record<string, string | number | null>[] {
  return rows.slice(0, MAX_POINTS).map((row) => {
    const point: Record<string, string | number | null> = { x: xValue(row[axes.x], axes.xType), y: numberOrNull(row[axes.y]) }
    if (axes.series !== undefined) point.series = String(row[axes.series]).slice(0, MAX_LABEL)
    return point
  })
}

/** Builds the spec for one chart over the given columns of a result. */
function makeChart(kind: MockChart['kind'], columns: readonly MockColumn[], rows: readonly MockCell[][], axes: Axes): MockChart {
  const values = pointsOf(rows, axes)
  const labels = [...new Set(values.map(point => String(point.x)))]
  const xColumn = columns[axes.x]
  const yColumn = columns[axes.y]
  const encoding: Record<string, unknown> = {
    x: { field: 'x', type: axes.xType, title: titleOf(xColumn), ...(axes.xType === 'nominal' ? { sort: labels } : {}) },
    y: { field: 'y', type: 'quantitative', title: titleOf(yColumn) },
  }
  if (axes.series !== undefined) encoding.color = { field: 'series', type: 'nominal', title: titleOf(columns[axes.series]) }
  return {
    kind,
    omitted_rows: Math.max(rows.length - MAX_POINTS, 0),
    spec: {
      $schema: SCHEMA_URL,
      description: `A ${kind} chart of ${titleOf(yColumn)} by ${titleOf(xColumn)}.`.slice(0, 200),
      data: { values },
      mark: { type: kind, tooltip: true },
      encoding,
      width: 'container',
      height: CHART_HEIGHT,
    },
  }
}

/** Chooses a chart for a result from its shape, or returns undefined when it has no honest chart. */
export function buildChart(columns: readonly MockColumn[], rows: readonly MockCell[][]): MockChart | undefined {
  if (rows.length < 2) return undefined
  const found = groupColumns(columns)
  const firstDate = found.date[0]
  const firstText = found.text[0]
  const firstNumber = found.number[0]
  if (firstDate !== undefined && firstNumber !== undefined) {
    return makeChart('line', columns, rows, { x: firstDate, y: firstNumber, series: seriesPosition(rows, found.text, [firstDate, firstNumber]), xType: 'temporal' })
  }
  if (firstText !== undefined && firstNumber !== undefined) {
    return makeChart('bar', columns, rows, { x: firstText, y: firstNumber, series: seriesPosition(rows, found.text.slice(1), [firstText, firstNumber]), xType: 'nominal' })
  }
  const periods = found.number.filter(position => namesAPeriod(columns[position] ?? { name: '', kind: 'other' }))
  const quantities = found.number.filter(position => !periods.includes(position))
  const period = periods[0]
  const quantity = quantities[0]
  if (period !== undefined && quantity !== undefined) return makeChart('bar', columns, rows, { x: period, y: quantity, series: undefined, xType: 'ordinal' })
  const [first, second] = found.number
  if (first !== undefined && second !== undefined) return makeChart('point', columns, rows, { x: first, y: second, series: undefined, xType: 'quantitative' })
  return undefined
}
