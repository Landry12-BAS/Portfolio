// The replay player's plan and its clock. A recording (docs/PLAYBOOK.md, principle 5) holds what a
// board asked for, what it was answered and the spans of the run. Playing it back means handing the
// board those answers and those spans again, spread over a few seconds so a visitor can watch the
// run happen, and always labelled as a replay. The plan is worked out first, as plain data, and a
// small runner follows it with timers, so the arithmetic can be tested without waiting.
import type { Recording, Span } from '@lb/contracts'

/** The longest a replay takes, however long the recorded run did. */
export const MAX_REPLAY_MS = 8_000
/** The shortest a replay takes, so even a quick run can be followed. */
export const MIN_REPLAY_MS = 1_500

/** The state of a replay at one moment: how many answers have been handed over and how many spans are showing. */
export interface ReplayStep {
  // Milliseconds after the replay started.
  atMs: number
  exchangesApplied: number
  spansShown: number
  finished: boolean
}

/** The spans of a recording in the order they ended, which is the order the gateway's stream holds them. */
export function spansInOrder(recording: Recording): Span[] {
  return recording.trace.spans.map((span, index) => ({ span, index }))
    .sort((a, b) => a.span.endMs - b.span.endMs || a.index - b.index)
    .map(({ span }) => span)
}

/** The moment the recorded run began: its root span's start, or the earliest start. */
function runStart(spans: readonly Span[]): number {
  const root = spans.find(span => span.kind === 'system.run' && span.parentId === undefined)
  return root?.startMs ?? Math.min(...spans.map(span => span.startMs))
}

/**
 * Plans how a recording plays: when each recorded answer is handed over and when each span
 * appears. A recorded run is shown at its own pace, compressed to fit the limits above. With
 * reduced motion preferred there is no pacing: the whole run is shown at once.
 */
export function planReplay(recording: Recording, reducedMotion: boolean): ReplayStep[] {
  const exchangeCount = recording.exchanges.length
  const spans = spansInOrder(recording)
  const everything: ReplayStep = { atMs: 0, exchangesApplied: exchangeCount, spansShown: spans.length, finished: true }
  if (reducedMotion) return [everything]

  const start = runStart(spans)
  const recordedMs = Math.max(recording.stats.durationMs, 1)
  const playMs = Math.min(Math.max(recordedMs, MIN_REPLAY_MS), MAX_REPLAY_MS)
  const scale = playMs / recordedMs

  // Every moment something changes: each answer's, each span's, and the end.
  const exchangeTimes = recording.exchanges.map((_, index) => (exchangeCount === 1 ? 0 : Math.round(playMs * index / (exchangeCount - 1))))
  const spanTimes = spans.map(span => Math.min(Math.round(Math.max(span.endMs - start, 0) * scale), playMs))
  const moments = [...new Set([...exchangeTimes, ...spanTimes, playMs])].sort((a, b) => a - b)

  return moments.map((atMs): ReplayStep => ({
    atMs,
    exchangesApplied: exchangeTimes.filter(time => time <= atMs).length,
    spansShown: spanTimes.filter(time => time <= atMs).length,
    finished: atMs === playMs,
  }))
}

/** What a replay tells the board as it plays. */
export interface ReplayHandlers {
  // The recorded answer at this position in the recording has been reached: apply it as if the API had just said it.
  applyExchange: (index: number) => void
  // This many of the run's first spans are showing, and the run is over when `finished`.
  showSpans: (count: number, finished: boolean) => void
}

/** A replay in progress, which can be stopped. */
export interface ReplayRun {
  stop: () => void
}

/** Plays a plan: calls the handlers at each step's moment, the first one at once. */
export function playReplay(plan: readonly ReplayStep[], handlers: ReplayHandlers): ReplayRun {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let applied = 0

  const runStep = (position: number): void => {
    const step = plan[position]
    if (stopped || step === undefined) return
    while (applied < step.exchangesApplied) {
      handlers.applyExchange(applied)
      applied += 1
    }
    handlers.showSpans(step.spansShown, step.finished)
    const next = plan[position + 1]
    if (next !== undefined) timer = setTimeout(() => runStep(position + 1), next.atMs - step.atMs)
  }

  runStep(0)
  return {
    stop: () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}
