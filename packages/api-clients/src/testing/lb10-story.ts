// The fixed story the mock's LB-10 tells about a run: which cases pass under which prompt, what the "model"
// wrote, what each grader said, how long each call took, and the statistics of the report. Nothing here is
// measured: the outputs are written here, the latencies and token counts are invented, and the bootstrap is
// the service's method (services/flask-systems/lb10/stats.py: a thousand resamples, seeded from the data, the
// 2.5th and 97.5th percentiles) on a generator of the mock's own, so its intervals are close to the service's
// and never the same numbers. A recording made on this mock says `mock`.
//
// The story follows the edit, so a test can choose what a run shows without a script:
// - production passes every case of the sample but its last hard case;
// - an edit that no longer asks for JSON (a JSON pack whose edited prompt never says "JSON") gets prose back,
//   which every grader fails: a malformed reply is a failed case, never repaired;
// - otherwise each line of production the edit removed costs one case that production passed (hard cases first),
//   and each line it added wins back one case that production failed: a one-line addition is a lucky
//   improvement that the paired interval calls no detectable difference.
import type { Lb10CaseSeed, Lb10PackSeed } from './lb10-seed.ts'

/** Which prompt a result belongs to. */
export type Lb10Variant = 'production' | 'edited'

/** What the paired comparison says in one word, as the service names it. */
export type Lb10Verdict = 'better' | 'worse' | 'no_detectable_difference' | 'not_comparable'

/** A share with its confidence interval, as the report writes it. */
export interface Lb10Interval {
  mean: number
  low: number
  high: number
  cases: number
}

/** The paired comparison of the edited prompt with production on the same cases. */
export interface Lb10Paired {
  difference: number
  low: number
  high: number
  verdict: Lb10Verdict
  improved: number
  regressed: number
  cases: number
}

/** One grader's verdict on one case, as the report writes it. */
export interface Lb10Grade {
  kind: string
  passed: boolean
  detail: string
}

/** How an edit differs from production, which is all the story reads. */
export interface Lb10EditStory {
  // The edited prompt is production's, character for character: it runs once.
  same: boolean
  // A JSON pack's edit that no longer asks for JSON: every reply comes back as prose.
  dropsJson: boolean
  // Lines of production the edit no longer has, and lines it has that production does not.
  removed: number
  added: number
}

// How many resamples the bootstrap draws, and the confidence level, as the service's limits say.
const RESAMPLES = 1_000
const CONFIDENCE = 0.95
// What a reply that holds no JSON object fails with, in the service's words (core/structured.py).
const NO_JSON = 'The reply holds no JSON object.'

/** The lines of a prompt that hold something, trimmed: what the story compares. */
function linesOf(prompt: string): string[] {
  return prompt.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/** Tells how an edited prompt differs from production. */
export function editStory(pack: Lb10PackSeed, edited: string): Lb10EditStory {
  const production = pack.systemPrompt
  if (edited === production) return { same: true, dropsJson: false, removed: 0, added: 0 }
  const before = new Set(linesOf(production))
  const after = new Set(linesOf(edited))
  const removed = [...before].filter(line => !after.has(line)).length
  const added = [...after].filter(line => !before.has(line)).length
  const asksForJson = (text: string) => text.toLowerCase().includes('json')
  const dropsJson = pack.output === 'json' && asksForJson(production) && !asksForJson(edited)
  return { same: false, dropsJson, removed, added }
}

/** Which cases of the sample production passes: all but the last hard one. */
export function productionPasses(sample: readonly Lb10CaseSeed[]): boolean[] {
  const lastHard = sample.map(entry => entry.difficulty).lastIndexOf('hard')
  return sample.map((_entry, index) => index !== lastHard)
}

/** The order in which an edit loses the cases production passed: hard ones first, then medium, then easy. */
function losingOrder(sample: readonly Lb10CaseSeed[], production: readonly boolean[]): number[] {
  const rank = { hard: 0, medium: 1, easy: 2 } as const
  return sample
    .map((entry, index) => ({ index, rank: rank[entry.difficulty] }))
    .filter(item => production[item.index] === true)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(item => item.index)
}

/** Which cases of the sample the edited prompt passes, by the story above. */
export function editedPasses(sample: readonly Lb10CaseSeed[], production: readonly boolean[], story: Lb10EditStory): boolean[] {
  if (story.dropsJson) return sample.map(() => false)
  const passes = [...production]
  for (const index of losingOrder(sample, production).slice(0, story.removed)) passes[index] = false
  const failing = production.map((passed, index) => (passed ? -1 : index)).filter(index => index >= 0)
  for (const index of failing.slice(0, story.added)) passes[index] = true
  return passes
}

/** Writes the reply a case gets: JSON (or the JSON of tool calls) that its graders read, or prose when the edit dropped JSON. */
export function replyFor(pack: Lb10PackSeed, entry: Lb10CaseSeed, passed: boolean, prose: boolean): string {
  const expected = entry.expected
  if (prose) return `The ticket ${entry.id.replaceAll('-', ' ')} is about an order. A colleague should look at it today.`
  if (pack.output === 'tool_calls') {
    const tools = (expected.tools as string[] | null | undefined) ?? []
    const first = tools[0]
    const calls = passed && first !== undefined ? [{ name: first, arguments: (expected.args as Record<string, unknown> | undefined)?.[first] ?? {} }] : []
    return JSON.stringify({ text: passed ? '' : 'I can help with bookings only.', tool_calls: calls, tool_call_count: calls.length })
  }
  if (pack.pack === 'lb05-sql-writer') {
    return JSON.stringify({ answerable: true, sql: passed ? expected.sql : 'SELECT COUNT(customers.customer_id) AS customers FROM customers' })
  }
  if (pack.pack === 'lb08-generator') {
    return JSON.stringify({ name: 'Workflow', nodes: [{ id: 'start', type: 'trigger', label: 'Start', event: passed ? expected.trigger : 'manual' }], edges: [] })
  }
  if (pack.pack === 'lb01-drafter') {
    const cites = (expected.cites as string[] | undefined) ?? []
    return JSON.stringify({ answerable: true, sentences: [{ text: 'Thank you for writing to us.', sources: [] }, { text: 'We will put this right.', sources: passed ? cites.map(key => `passage:${key}`) : [] }] })
  }
  const categories = (expected.category as string[] | undefined) ?? ['other']
  return JSON.stringify({ category: passed ? categories[0] : 'other', order_number: expected.order_number ?? null, senior_agent: null, search_query: 'policy passages for the ticket' })
}

/** Writes what each grader said about a reply: all pass, the last one fails on a wrong answer, or every one fails on prose. */
export function gradesFor(entry: Lb10CaseSeed, passed: boolean, prose: boolean): Lb10Grade[] {
  return entry.graderKinds.map((kind, index) => {
    if (prose) return { kind, passed: false, detail: kind === 'json_schema' ? `no JSON object: ${NO_JSON}` : NO_JSON }
    const failed = !passed && index === entry.graderKinds.length - 1
    return { kind, passed: !failed, detail: failed ? 'expected the golden answer, got another' : 'as the golden set expects' }
  })
}

/** An invented latency for one call, in milliseconds: the same call always takes the same time, Workers AI a little longer. */
export function latencyOf(provider: string, variant: Lb10Variant, index: number): number {
  const base = provider === 'workers-ai' ? 1_100 : 640
  return base + ((index * 97 + (variant === 'edited' ? 41 : 0)) % 380)
}

/** Invented token counts for one call: about 3.5 characters a token, as the gateway estimates. */
export function tokensOf(prompt: string, entry: Lb10CaseSeed, reply: string): { input: number, output: number } {
  const inputs = Object.values(entry.inputs).reduce((sum, value) => sum + value.length, 0)
  return { input: Math.ceil((prompt.length + inputs) / 3.5), output: Math.ceil(reply.length / 3.5) }
}

/** Makes the bootstrap's seed from the data, so the same results always give the same interval (FNV-1a over the values). */
function seedFrom(values: readonly number[]): number {
  let hash = 0x811C9DC5
  for (const character of values.join(',')) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** A small seeded generator of numbers from 0 to 1 (mulberry32): the mock's own, not Python's. */
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** Returns the mean, or 0 for no values. */
function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Returns the value at a share of a sorted list, between neighbours, as the service's percentile does. */
function percentile(sorted: readonly number[], share: number): number {
  if (sorted.length === 0) return 0
  const position = share * (sorted.length - 1)
  const below = Math.floor(position)
  const above = Math.min(below + 1, sorted.length - 1)
  const weight = position - below
  return (sorted[below] ?? 0) * (1 - weight) + (sorted[above] ?? 0) * weight
}

/** Draws the means of resamples with replacement, sorted. */
function resampledMeans(values: readonly number[]): number[] {
  const next = generator(seedFrom(values))
  const means: number[] = []
  for (let round = 0; round < RESAMPLES; round += 1) {
    let sum = 0
    for (let draw = 0; draw < values.length; draw += 1) sum += values[Math.floor(next() * values.length)] ?? 0
    means.push(sum / values.length)
  }
  return means.sort((a, b) => a - b)
}

/** Rounds a share as the service's floats print, so a mean of 0.7 is 0.7 and not 0.7000000000000001. */
function tidy(value: number): number {
  return Math.round(value * 1e9) / 1e9
}

/** The share of passing cases with its bootstrap interval. */
export function bootstrapInterval(passes: readonly boolean[]): Lb10Interval {
  const values = passes.map(passed => (passed ? 1 : 0))
  if (values.length === 0) return { mean: 0, low: 0, high: 0, cases: 0 }
  const means = resampledMeans(values)
  const tail = (1 - CONFIDENCE) / 2
  return { mean: tidy(mean(values)), low: tidy(percentile(means, tail)), high: tidy(percentile(means, 1 - tail)), cases: values.length }
}

/** The paired comparison: the bootstrap of the per-case differences, and a verdict only when the interval leaves zero out. */
export function pairedComparison(edited: readonly boolean[], production: readonly boolean[]): Lb10Paired {
  if (edited.length !== production.length || edited.length === 0) return { difference: 0, low: 0, high: 0, verdict: 'not_comparable', improved: 0, regressed: 0, cases: 0 }
  const differences = edited.map((after, index) => Number(after) - Number(production[index]))
  const means = resampledMeans(differences)
  const tail = (1 - CONFIDENCE) / 2
  const low = tidy(percentile(means, tail))
  const high = tidy(percentile(means, 1 - tail))
  const verdict: Lb10Verdict = low > 0 ? 'better' : high < 0 ? 'worse' : 'no_detectable_difference'
  return {
    difference: tidy(mean(differences)),
    low,
    high,
    verdict,
    improved: differences.filter(difference => difference > 0).length,
    regressed: differences.filter(difference => difference < 0).length,
    cases: differences.length,
  }
}

/** The median and the 95th percentile of some latencies, in whole milliseconds, as the service works them out. */
export function latencyPercentiles(latencies: readonly number[]): { p50: number, p95: number } {
  const sorted = [...latencies].sort((a, b) => a - b)
  return { p50: Math.round(percentile(sorted, 0.5)), p95: Math.round(percentile(sorted, 0.95)) }
}
