// The numbers behind the dashboards: the ticks an incident's log holds, turned into the series a
// chart draws, the shape of its axes and its line, the facts its text alternative states, and the
// one-word health of each service. The drawing is done by the components; everything that can be
// wrong about it (a scale, a path, a threshold) is here, as plain functions with tests.
import { LB06_SERVICES } from '@lb/contracts'
import type { Lb06Event, Lb06Metric, Lb06MinuteMetrics, Lb06Service, Lb06Slo } from '@lb/contracts'

/** The metrics the dashboards draw, in the order the selector offers them. The service reports one more (the median latency) and the table can show it. */
export const CHART_METRICS = ['error_rate', 'latency_p95', 'saturation', 'memory_mb', 'request_rate'] as const satisfies readonly Lb06Metric[]

/** One metric the dashboards draw. */
export type ChartMetric = (typeof CHART_METRICS)[number]

/** One minute of the shop: the metrics of every service, and what the SLO said. */
export interface TickPoint {
  seq: number
  minute: number
  metrics: Lb06MinuteMetrics
  slo: Lb06Slo
}

/** The ticks of a log, in order. */
export function ticksOf(events: readonly Lb06Event[]): TickPoint[] {
  const ticks: TickPoint[] = []
  for (const event of events) {
    if (event.kind === 'tick') ticks.push({ seq: event.seq, minute: event.minute, metrics: event.data.metrics, slo: event.data.slo })
  }
  return ticks
}

/** One point of a series: a simulated minute and what a service reported at it. */
export interface Point {
  minute: number
  value: number
}

/** The series of one metric of one service. */
export function seriesOf(ticks: readonly TickPoint[], service: Lb06Service, metric: Lb06Metric): Point[] {
  return ticks.map(tick => ({ minute: tick.minute, value: tick.metrics[service][metric] }))
}

/** The part of the world a chart shows: from one minute to another, and from zero up to a value. */
export interface Domain {
  fromMinute: number
  toMinute: number
  top: number
}

/** The shortest stretch of simulated time a chart's axis spans, so the first minutes do not fill it. */
export const MIN_SPAN_MINUTES = 40

/** The smallest top of each chart's value axis, so a small wobble does not look like a failure: a metric must reach it before the axis grows. */
export const AXIS_FLOOR: Readonly<Record<ChartMetric, number>> = {
  error_rate: 0.05,
  latency_p95: 1_000,
  saturation: 1,
  memory_mb: 1_000,
  request_rate: 100,
}

/** Rounds a value up to the next 1, 2, 5 or 10 times a power of ten, which is where an axis ends. */
export function niceCeiling(value: number): number {
  if (!(value > 0)) return 1
  const base = 10 ** Math.floor(Math.log10(value))
  const fraction = value / base
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return step * base
}

/** The domain of a series: from its first minute to its last (at least a stretch wide), and up to the next round number over its peak or the floor. */
export function domainOf(points: readonly Point[], floor: number): Domain {
  const fromMinute = points[0]?.minute ?? 0
  const lastMinute = points.at(-1)?.minute ?? 0
  const peak = points.reduce((highest, point) => Math.max(highest, point.value), 0)
  return { fromMinute, toMinute: Math.max(lastMinute, fromMinute + MIN_SPAN_MINUTES), top: niceCeiling(Math.max(peak, floor)) }
}

/** The room a chart leaves around its plot, in drawing units, for the axes' labels. */
export interface Frame {
  width: number
  height: number
  left: number
  right: number
  top: number
  bottom: number
}

/** Where a minute lands on the horizontal axis. */
export function xOf(minute: number, domain: Domain, frame: Frame): number {
  const span = Math.max(domain.toMinute - domain.fromMinute, 1)
  return frame.left + ((minute - domain.fromMinute) / span) * (frame.width - frame.left - frame.right)
}

/** Where a value lands on the vertical axis, with zero at the bottom. */
export function yOf(value: number, domain: Domain, frame: Frame): number {
  const share = Math.min(Math.max(value / domain.top, 0), 1)
  return frame.top + (1 - share) * (frame.height - frame.top - frame.bottom)
}

/** The line of a series, as the path an SVG draws; empty for a series with no point. */
export function pathOf(points: readonly Point[], domain: Domain, frame: Frame): string {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${xOf(point.minute, domain, frame).toFixed(1)},${yOf(point.value, domain, frame).toFixed(1)}`)
    .join(' ')
}

/** The facts a chart's text alternative states: where the series started, where it peaked and when, and where it is now. */
export interface SeriesFacts {
  first: number
  last: number
  peak: number
  peakMinute: number
  lastMinute: number
}

/** Reads the facts out of a series, or undefined for one with no point. */
export function factsOf(points: readonly Point[]): SeriesFacts | undefined {
  const first = points[0]
  const last = points.at(-1)
  if (!first || !last) return undefined
  let peak = first
  for (const point of points) {
    if (point.value > peak.value) peak = point
  }
  return { first: first.value, last: last.value, peak: peak.value, peakMinute: peak.minute, lastMinute: last.minute }
}

/** How a service is doing, in a word the page also writes out and marks with an icon: colour never says it alone. */
export type Health = 'normal' | 'elevated' | 'failing'

/** How many of the first minutes are taken as the calm a service is compared with. */
const BASELINE_TICKS = 10

/** The mean of one metric of one service over the calm minutes. */
function baselineOf(ticks: readonly TickPoint[], service: Lb06Service, metric: Lb06Metric): number {
  const calm = ticks.slice(0, BASELINE_TICKS)
  return calm.reduce((sum, tick) => sum + tick.metrics[service][metric], 0) / Math.max(calm.length, 1)
}

/**
 * How a service is doing at the newest minute, judged against its own calm: failing when requests
 * mostly fail, or when its latency, its saturation or its memory has run away, elevated when they
 * have moved well off it or when the requests it handles have fallen to half of what they were (a
 * cache that has emptied looks like that: nothing fails in it, it has stopped serving). These are the
 * board's own display rules, drawn from the numbers on the charts; the service's alert and the SLO
 * are the authority on whether the shop is in trouble.
 */
export function healthOf(ticks: readonly TickPoint[], service: Lb06Service): Health | undefined {
  const latest = ticks.at(-1)
  if (!latest) return undefined
  const now = latest.metrics[service]
  const calmLatency = baselineOf(ticks, service, 'latency_p95')
  const calmMemory = baselineOf(ticks, service, 'memory_mb')
  const calmRate = baselineOf(ticks, service, 'request_rate')
  if (now.error_rate >= 0.05 || now.latency_p95 >= 4 * calmLatency || now.saturation >= 0.95 || now.memory_mb >= 2 * calmMemory) return 'failing'
  if (now.error_rate >= 0.01 || now.latency_p95 >= 2 * calmLatency || now.saturation >= 0.8 || now.memory_mb >= 1.4 * calmMemory || now.request_rate <= 0.5 * calmRate) return 'elevated'
  return 'normal'
}

/** The services of the shop, in the order the dashboards list them: from the edge to the data. */
export const SERVICES = LB06_SERVICES
