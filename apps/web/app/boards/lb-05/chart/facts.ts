// What a chart says in words and in a table, worked out from its data alone, so a visitor who cannot
// see the drawing (or who would rather read the numbers) gets everything the drawing shows: how many
// points there are, how many series, which point is highest and which lowest, and the points
// themselves in the order the chart draws them.
import type { ChartPoint, ChartSpec } from './spec'

/** One point a chart draws, with the series it belongs to when the chart has them. */
export type ChartRow = ChartPoint

/** The extreme points of a chart's quantity. */
export interface ChartExtremes {
  highest: ChartRow
  lowest: ChartRow
}

/** What a chart is about, in values a sentence can be built from. */
export interface ChartFacts {
  kind: ChartSpec['mark']['type']
  count: number
  seriesCount: number
  xTitle: string
  yTitle: string
  // The title of the colour channel, when the chart tells series apart.
  seriesTitle: string | undefined
  // The highest and lowest points, when at least one point has a quantity.
  extremes: ChartExtremes | undefined
}

/** Picks the points that have a quantity, which are the ones that can be compared. */
function measured(rows: readonly ChartRow[]): ChartRow[] {
  return rows.filter(row => typeof row.y === 'number')
}

/** Finds the highest and the lowest point, or undefined when no point has a quantity. */
function extremesOf(rows: readonly ChartRow[]): ChartExtremes | undefined {
  const comparable = measured(rows).toSorted((a, b) => Number(a.y) - Number(b.y))
  const lowest = comparable.at(0)
  const highest = comparable.at(-1)
  return lowest && highest ? { highest, lowest } : undefined
}

/** Works out what a chart is about. */
export function chartFacts(spec: ChartSpec): ChartFacts {
  const rows = spec.data.values
  return {
    kind: spec.mark.type,
    count: rows.length,
    seriesCount: spec.encoding.color === undefined ? 0 : new Set(rows.map(row => row.series)).size,
    xTitle: spec.encoding.x.title,
    yTitle: spec.encoding.y.title,
    seriesTitle: spec.encoding.color?.title,
    extremes: extremesOf(rows),
  }
}

/** Lists a chart's points as a table's rows: the horizontal value, the quantity and the series, in the order the chart has them. */
export function chartRows(spec: ChartSpec): readonly ChartRow[] {
  return spec.data.values
}
