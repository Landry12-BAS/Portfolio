// Plain functions over a run and its report, so the components that draw them have no logic of their own to get
// wrong: where a run stands, how far its calls have got, the report's prompts grouped by provider, how many cases
// each passed, whether two intervals overlap, where a mark goes on a figure, and whether a reply holds the JSON
// object the service's graders look for.
import type { Lb10Comparison, Lb10Outcome, Lb10Report, Lb10Run, Lb10VariantReport } from './schemas'

/** Where a run stands, in the words the board has for it. */
export type RunStage = 'starting' | 'calling' | 'writing' | 'done' | 'failed'

/** How far a run's calls have got, for its progress bar. */
export interface CallProgress {
  done: number
  total: number
  cached: number
}

/** The report's prompts on one provider: production's, the edited one when there is one, and their comparison. */
export interface ProviderReport {
  provider: string
  alias: string
  production: Lb10VariantReport | undefined
  edited: Lb10VariantReport | undefined
  comparison: Lb10Comparison | undefined
}

// The failures the service gives a run back for: the service, not the prompt, is what failed (lb10/runner.py, and a
// run the full runner never started).
const GIVEN_BACK = new Set(['model_budget', 'no_answers', 'time_limit', 'interrupted', 'call_limit', 'busy'])
// The mark a code fence opens and closes with.
const FENCE = '```'

/** Says where a run stands. */
export function stageOf(run: Lb10Run): RunStage {
  if (run.state === 'done') return 'done'
  if (run.state === 'failed') return 'failed'
  if (run.calls_done === 0 && run.cached_calls === 0) return 'starting'
  return run.calls_done < run.calls_total ? 'calling' : 'writing'
}

/**
 * Says how far a run's calls have got. While it runs, the service counts the cached results and the calls made; once
 * it is done it counts the calls made alone, so a finished run is shown with every call accounted for.
 */
export function progressOf(run: Lb10Run): CallProgress {
  const total = run.calls_total
  if (run.state === 'done') return { done: total, total, cached: run.cached_calls }
  return { done: Math.min(run.calls_done, total), total, cached: Math.min(run.cached_calls, total) }
}

/** Tells whether the service gives a run back for a failure. */
export function isGivenBack(failure: string | null): boolean {
  return failure !== null && GIVEN_BACK.has(failure)
}

/** Groups the report's prompts by provider, in the order the run had them. */
export function byProvider(report: Lb10Report): ProviderReport[] {
  const groups: ProviderReport[] = []
  for (const variant of report.variants) {
    let group = groups.find(candidate => candidate.provider === variant.provider)
    if (!group) {
      group = { provider: variant.provider, alias: variant.alias, production: undefined, edited: undefined, comparison: undefined }
      groups.push(group)
    }
    if (variant.variant === 'production') group.production = variant
    else group.edited = variant
  }
  for (const group of groups) group.comparison = report.comparisons.find(comparison => comparison.provider === group.provider)
  return groups
}

/** Counts the cases a prompt passed. */
export function passedCount(variant: Lb10VariantReport): number {
  return variant.cases.filter(outcome => outcome.passed).length
}

/** Tells whether two intervals share any part. */
export function intervalsOverlap(a: { low: number, high: number }, b: { low: number, high: number }): boolean {
  return a.low <= b.high && b.low <= a.high
}

/** Where a share from 0 to 1 sits on the score figure, as a percentage of its width. */
export function scoreAt(share: number): number {
  return Math.min(Math.max(share, 0), 1) * 100
}

/** Where a difference from -1 to 1 sits on the difference figure, as a percentage of its width. */
export function differenceAt(difference: number): number {
  return ((Math.min(Math.max(difference, -1), 1) + 1) / 2) * 100
}

/** Takes the inside of the first code fence of a reply, as the service's reader does (core/structured.py), or the reply when it has none. */
function unfenced(text: string): string {
  const open = text.indexOf(FENCE)
  const close = open < 0 ? -1 : text.indexOf(FENCE, open + FENCE.length)
  if (close < 0) return text
  const inside = text.slice(open + FENCE.length, close)
  return (inside.startsWith('json') ? inside.slice('json'.length) : inside).trim()
}

/** Tells whether a reply holds a JSON object the way the service's graders look for one: from its first brace to its last, fenced or not. */
export function holdsJsonObject(output: string): boolean {
  const text = unfenced(output.trim())
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return false
  try {
    JSON.parse(text.slice(start, end + 1))
    return true
  }
  catch {
    return false
  }
}

/** Tells whether a case failed for want of the JSON object its graders read: a malformed reply, which is never repaired. */
export function isMalformed(outcome: Lb10Outcome, output: 'json' | 'text' | 'tool_calls'): boolean {
  return output === 'json' && outcome.error === null && !outcome.passed && outcome.output.trim() !== '' && !holdsJsonObject(outcome.output)
}

/** The outcome of a case under a prompt, by the case's ID. */
export function outcomeOf(variant: Lb10VariantReport | undefined, caseId: string): Lb10Outcome | undefined {
  return variant?.cases.find(outcome => outcome.case_id === caseId)
}
