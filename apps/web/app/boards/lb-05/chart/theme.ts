// How a chart is dressed: its colours and type come from the design system's tokens
// (packages/ui/app/assets/css/tokens.css) as they are on the page right now, in the light theme or the
// dark one, and nothing here is a colour of its own. A drawing on a canvas cannot read CSS variables,
// so the tokens are read off the page when the chart is drawn, and the chart is drawn again when the
// theme changes. Marks are thin, grid lines are hairlines one step off the sheet, and text wears the
// ink tokens and never a series colour.
import type { Config } from 'vega-lite'

/** The tokens a chart needs, as the page has them now. */
export interface ChartTokens {
  sheet: string
  ink: string
  graphite: string
  rule: string
  fontSans: string
  fontMono: string
  // The eight series colours in the order a chart gives them out.
  series: readonly string[]
}

/** How many series colours the design system has. */
export const SERIES_COUNT = 8

/** Reads one token off an element's computed style. */
function token(style: CSSStyleDeclaration, name: string): string {
  return style.getPropertyValue(name).trim()
}

/** The names of the series tokens, in order. */
function seriesNames(): string[] {
  return Array.from({ length: SERIES_COUNT }, (_, index) => `--lb-series-${index + 1}`)
}

/** Reads the chart's tokens off an element, or returns undefined when the page has none of them (a page without the design system). */
export function readChartTokens(element: Element): ChartTokens | undefined {
  const style = getComputedStyle(element)
  const series = seriesNames().map(name => token(style, name))
  const tokens: ChartTokens = {
    sheet: token(style, '--lb-sheet'),
    ink: token(style, '--lb-ink'),
    graphite: token(style, '--lb-graphite'),
    rule: token(style, '--lb-rule'),
    fontSans: token(style, '--lb-font-sans'),
    fontMono: token(style, '--lb-font-mono'),
    series,
  }
  const missing = [tokens.sheet, tokens.ink, tokens.graphite, tokens.rule, tokens.fontSans, tokens.fontMono, ...series].some(value => value === '')
  return missing ? undefined : tokens
}

/** The size of text on a chart, in pixels. */
const LABEL_SIZE = 11
const TITLE_SIZE = 12

/** How the labels along a chart's horizontal axis are set: flat, with those that would overlap left out, or tilted so that every one is shown. */
export type LabelLayout = 'flat' | 'tilted'

/** Writes how the horizontal axis sets its labels. */
function horizontalAxis(tokens: ChartTokens, labels: LabelLayout): NonNullable<Config['axisX']> {
  const base = { grid: false, domain: true, domainColor: tokens.rule }
  if (labels === 'tilted') return { ...base, labelAngle: -40, labelAlign: 'right', labelBaseline: 'middle', labelOverlap: false, labelLimit: 160 }
  return { ...base, labelAngle: 0, labelOverlap: 'greedy', labelLimit: 120 }
}

/** Builds the Vega-Lite configuration that dresses a chart in the tokens. */
export function chartConfig(tokens: ChartTokens, labels: LabelLayout = 'flat'): Config {
  const first = tokens.series[0] ?? tokens.ink
  return {
    background: tokens.sheet,
    font: tokens.fontSans,
    padding: { left: 6, right: 14, top: 10, bottom: 6 },
    view: { stroke: null },
    range: { category: [...tokens.series] },
    axis: {
      domain: false,
      grid: true,
      gridColor: tokens.rule,
      gridWidth: 1,
      tickColor: tokens.rule,
      labelColor: tokens.graphite,
      labelFont: tokens.fontMono,
      labelFontSize: LABEL_SIZE,
      labelPadding: 6,
      titleColor: tokens.graphite,
      titleFont: tokens.fontSans,
      titleFontSize: TITLE_SIZE,
      titleFontWeight: 'normal',
      titlePadding: 10,
    },
    axisX: horizontalAxis(tokens, labels),
    legend: {
      orient: 'bottom',
      labelColor: tokens.ink,
      labelFont: tokens.fontSans,
      labelFontSize: LABEL_SIZE,
      titleColor: tokens.graphite,
      titleFont: tokens.fontSans,
      titleFontSize: TITLE_SIZE,
      titleFontWeight: 'normal',
      symbolType: 'square',
      symbolSize: 90,
    },
    bar: { fill: first, cornerRadiusEnd: 3, stroke: tokens.sheet, strokeWidth: 2 },
    line: { stroke: first, strokeWidth: 2, strokeJoin: 'round', strokeCap: 'round' },
    point: { fill: first, stroke: tokens.sheet, strokeWidth: 2, size: 80, filled: true },
  }
}
