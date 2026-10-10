// The Scope's timeline: a run's flat list of spans, arranged the way a person reads a trace.
// The steps sit under the run and each model call under the step that made it, in the order they
// started, with where each one falls in the run's time. These are plain functions, so the
// component that draws the timeline has no logic of its own to get wrong.
import { summariseTrace } from '@lb/contracts'
import type { Span, TraceSummary } from '@lb/contracts'

/** What a span is, in the words the Scope's legend uses. The interface text for each is in the locale files. */
export type SpanKind = 'run' | 'step' | 'tool' | 'model' | 'attempt' | 'other'

/** One line of the timeline: a span, how deep it sits, and where its bar goes. */
export interface TimelineRow {
  span: Span
  // 0 for the run and for anything whose parent has not arrived yet; one more for each level below.
  depth: number
  kind: SpanKind
  // Milliseconds from the start of the run to the start of this span, and how long it took.
  offsetMs: number
  durationMs: number
  // Where the bar starts and how wide it is, as fractions of the whole run from 0 to 1.
  left: number
  width: number
  // What a model call or attempt says about itself, when it says it.
  alias: string | undefined
  provider: string | undefined
  model: string | undefined
  inputTokens: number | undefined
  outputTokens: number | undefined
  // The name of the span this one sits under, for people who hear the rows read out.
  parentName: string | undefined
}

/** A whole trace, ready to draw. */
export interface Timeline {
  rows: TimelineRow[]
  // How long the run took, or how long it has taken so far while it is still going.
  totalMs: number
  summary: TraceSummary
  // True until the run's root span arrives: the run is still going, or its end was not seen.
  open: boolean
}

// A bar is never thinner than this, so a step that took a millisecond can still be seen.
const MIN_BAR = 0.006

/** Maps a span's kind, as the gateway names it, to the legend's. */
export function kindOf(span: Span): SpanKind {
  switch (span.kind) {
    case 'system.run': return 'run'
    case 'system.step': return 'step'
    case 'system.tool': return 'tool'
    case 'gateway.call': return 'model'
    case 'gateway.attempt': return 'attempt'
    default: return 'other'
  }
}

/** Tells whether a span is the root of a run: the one for the whole run, with no parent. */
function isRoot(span: Span): boolean {
  return span.kind === 'system.run' && span.parentId === undefined
}

/** Reads a text detail off a span, or undefined when it is missing or is not text. */
function textAttr(span: Span, name: string): string | undefined {
  const value = span.attrs[name]
  return typeof value === 'string' ? value : undefined
}

/** Reads a number detail off a span, or undefined when it is missing or is not a number. */
function numberAttr(span: Span, name: string): number | undefined {
  const value = span.attrs[name]
  return typeof value === 'number' ? value : undefined
}

/** Orders spans by when they started, then the longer one first, so a parent comes before its first child. */
function byStart(a: Span, b: Span): number {
  return a.startMs - b.startMs || b.endMs - a.endMs
}

/** Finds where a run began and ended: its root span's times, or the first start and last end seen so far. */
function runBounds(spans: readonly Span[]): { start: number, end: number } {
  const root = spans.find(isRoot)
  if (root) return { start: root.startMs, end: root.endMs }
  return {
    start: Math.min(...spans.map(span => span.startMs)),
    end: Math.max(...spans.map(span => span.endMs)),
  }
}

/** Groups spans by the span they sit under. Spans whose parent is not in the list go under `undefined`. */
function groupByParent(spans: readonly Span[]): Map<string | undefined, Span[]> {
  const known = new Set(spans.map(span => span.spanId))
  const groups = new Map<string | undefined, Span[]>()
  for (const span of spans) {
    // While a run is going its steps arrive before the root, so their parent is not here yet: show them at the top.
    const key = span.parentId !== undefined && known.has(span.parentId) ? span.parentId : undefined
    groups.set(key, [...(groups.get(key) ?? []), span])
  }
  for (const group of groups.values()) group.sort(byStart)
  return groups
}

/** Walks the tree from the top, parents before children, and lists each span with its depth. */
function flatten(groups: Map<string | undefined, Span[]>, spans: readonly Span[]): { span: Span, depth: number, parent: Span | undefined }[] {
  const listed: { span: Span, depth: number, parent: Span | undefined }[] = []
  const seen = new Set<string>()
  const visit = (span: Span, depth: number, parent: Span | undefined): void => {
    if (seen.has(span.spanId)) return
    seen.add(span.spanId)
    listed.push({ span, depth, parent })
    for (const child of groups.get(span.spanId) ?? []) visit(child, depth + 1, span)
  }
  for (const span of groups.get(undefined) ?? []) visit(span, 0, undefined)
  // A malformed trace whose spans point at each other would otherwise vanish: show what was left over.
  for (const span of [...spans].sort(byStart)) visit(span, 0, undefined)
  return listed
}

/** Arranges a run's spans into the rows of the Scope's timeline. An empty list is an open timeline with no rows. */
export function buildTimeline(spans: readonly Span[]): Timeline {
  if (spans.length === 0) return { rows: [], totalMs: 0, summary: summariseTrace(spans), open: true }
  const { start, end } = runBounds(spans)
  const totalMs = Math.max(end - start, 0)
  const scale = Math.max(totalMs, 1)
  const rows = flatten(groupByParent(spans), spans).map(({ span, depth, parent }): TimelineRow => {
    const durationMs = Math.max(span.endMs - span.startMs, 0)
    // Keep room at the right edge for the thinnest bar, so a span at the very end is still drawn.
    const left = Math.min(Math.max((span.startMs - start) / scale, 0), 1 - MIN_BAR)
    return {
      span,
      depth,
      kind: kindOf(span),
      offsetMs: Math.max(span.startMs - start, 0),
      durationMs,
      left,
      width: Math.min(Math.max(durationMs / scale, MIN_BAR), 1 - left),
      alias: textAttr(span, 'alias'),
      provider: textAttr(span, 'provider'),
      model: textAttr(span, 'model'),
      inputTokens: numberAttr(span, 'inputTokens'),
      outputTokens: numberAttr(span, 'outputTokens'),
      parentName: parent?.name,
    }
  })
  return { rows, totalMs, summary: summariseTrace(spans), open: !spans.some(isRoot) }
}
