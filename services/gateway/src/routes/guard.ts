// POST /v1/guard: says whether a text looks like a prompt injection, before it reaches
// a model that can call tools (docs/STACK.md, Routing rule 8). The classifiers behind
// it (Prompt Guard 2) read 512 tokens at most and may cut the rest without saying so,
// so the gateway reads a long text in overlapping segments and flags it when any
// segment scores at or above the alias's threshold. Anything it can't read with
// certainty fails the call: the caller must then treat the text as unchecked.
import type { FastifyInstance } from 'fastify'

import { jsonBatchAttempt, watchClient } from '../attempts.ts'
import { estimateGuardInput, textTokens } from '../budget/estimate.ts'
import type { TokenEstimate } from '../budget/estimate.ts'
import { assertPlannable, ModelCall, readCallMeta, resolveAlias } from '../call.ts'
import type { GatewayContext } from '../call.ts'
import { GatewayError } from '../errors.ts'
import type { Alias, Model } from '../routing/load.ts'
import { planChain } from '../routing/plan.ts'
import type { Capability } from '../routing/schema.ts'
import { guardAnswerSchema, guardRequestSchema } from '../schemas/guard.ts'
import { readUsage } from '../upstream/usage.ts'
import { parseBody } from './body.ts'

const MIB = 1_048_576
// A classifier answers with a number or a word; anything this big isn't that.
const MAX_GUARD_ANSWER_BYTES = 65_536
// The tokens one answer takes, for the budget.
const ANSWER_TOKENS = 8
// Segments are sized for the worst case of one token per character, less this margin
// for the model's own markers, so no segment can run past the model's window.
const SEGMENT_MARGIN_TOKENS = 32
// Neighbouring segments share this many characters, so a phrase cut at one boundary
// still appears whole in the next segment.
const SEGMENT_OVERLAP_CHARS = 100
const needs: ReadonlySet<Capability> = new Set(['guard'])

// A probability as a classifier writes it, such as 0.9995 or 1e-05.
const probability = /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i

/** The guard's answer: whether the text is flagged, its highest injection probability, and how it was read. */
export interface GuardVerdict {
  object: 'guard.verdict'
  model: string
  flagged: boolean
  score: number
  threshold: number
  segments: number
}

/** One segment's reading: its injection probability, and the tokens it used when the provider said. */
interface SegmentScore {
  score: number
  usage: TokenEstimate | undefined
}

/**
 * Splits a text into segments of at most `size` characters, each starting `size -
 * overlap` characters after the one before, the last ending where the text ends.
 * Characters are counted as code points, so no emoji or accented letter is cut in two.
 */
export function segmentsOf(text: string, size: number, overlap: number): string[] {
  if (overlap >= size) throw new Error('The overlap must be smaller than the segment size.')
  const characters = Array.from(text)
  const segments: string[] = []
  for (let start = 0; ; start += size - overlap) {
    const end = Math.min(start + size, characters.length)
    segments.push(characters.slice(start, end).join(''))
    if (end === characters.length) return segments
  }
}

/** Returns the segment size that fits every model on the alias's chain. */
export function segmentSize(alias: Alias): number {
  return Math.min(...alias.chain.map(model => model.context)) - SEGMENT_MARGIN_TOKENS
}

/**
 * Reads a Prompt Guard answer as the probability that the text is an injection. Groq
 * doesn't document the format, so exactly two readings are accepted: a probability
 * from 0 to 1, or Meta's labels BENIGN and MALICIOUS. Anything else is refused, and the
 * guard fails closed rather than guess.
 */
export function readGuardScore(content: string): number | undefined {
  const text = content.trim()
  if (probability.test(text)) {
    const score = Number(text)
    return score >= 0 && score <= 1 ? score : undefined
  }
  if (text.toUpperCase() === 'MALICIOUS') return 1
  if (text.toUpperCase() === 'BENIGN') return 0
  return undefined
}

/**
 * Reads one segment's answer. A provider report of a full window means the model may
 * have cut the segment short, so that answer is refused too.
 */
function readSegment(json: unknown, model: Model): SegmentScore | undefined {
  const parsed = guardAnswerSchema.safeParse(json)
  if (!parsed.success) return undefined
  const [choice] = parsed.data.choices
  const score = choice === undefined ? undefined : readGuardScore(choice.message.content)
  if (score === undefined) return undefined
  const usage = readUsage(json)
  if (usage && usage.input >= model.context) return undefined
  return { score, usage }
}

/** Adds up the segments' token usage, or returns undefined unless every segment reported it. */
function totalUsage(readings: readonly SegmentScore[]): TokenEstimate | undefined {
  const total = { input: 0, output: 0 }
  for (const { usage } of readings) {
    if (!usage) return undefined
    total.input += usage.input
    total.output += usage.output
  }
  return total
}

/** Builds the verdict from every segment's score: the text is as suspicious as its worst segment. */
export function verdictOf(scores: readonly number[], alias: Alias): GuardVerdict {
  // The loader refuses a guard alias without a threshold; this check only satisfies the type.
  const threshold = alias.threshold
  if (threshold === undefined) throw new Error(`${alias.name} has no threshold.`)
  const score = Math.max(...scores)
  return { object: 'guard.verdict', model: alias.name, flagged: score >= threshold, score, threshold, segments: scores.length }
}

/** Registers the guard route on the /v1 scope. */
export function registerGuard(app: FastifyInstance, ctx: GatewayContext): void {
  app.post('/guard', { bodyLimit: MIB }, async (request, reply) => {
    // 1. Check the headers, the body, the alias and the size before spending anything.
    const meta = readCallMeta(request, ctx.routing)
    const body = parseBody(guardRequestSchema, request.body)
    const alias = resolveAlias(ctx.routing, meta.system, body.model, 'guard')
    const input = textTokens(body.input)
    if (input > alias.maxInputTokens) {
      throw new GatewayError(413, 'input_too_large', `The text is about ${input} tokens; ${alias.name} checks up to ${alias.maxInputTokens}.`)
    }
    const plan = planChain(alias, meta.dataClass, ctx.profile, needs)
    assertPlannable(plan, alias, needs)

    // 2. Split the text so that no part of it falls outside the classifier's window.
    //    Every segment goes to the same model, one request each.
    const segments = segmentsOf(body.input, segmentSize(alias), SEGMENT_OVERLAP_CHARS)
    const estimate = { input: estimateGuardInput(segments), output: ANSWER_TOKENS * segments.length, requests: segments.length }

    // 3. Count the call, score every segment, settle the budget and answer.
    const call = new ModelCall(ctx, meta, alias, plan, estimate, false)
    await call.admit()
    const served = await call.run(jsonBatchAttempt(
      'chat',
      model => segments.map(segment => ({ model: model.id, messages: [{ role: 'user', content: segment }] })),
      readSegment,
      MAX_GUARD_ANSWER_BYTES,
      watchClient(reply.raw),
      ctx.now,
    ))
    const readings = served.value.map(answer => answer.parsed)
    const verdict = verdictOf(readings.map(reading => reading.score), alias)
    await call.finish(served, totalUsage(readings), {
      ok: true,
      attrs: { flagged: verdict.flagged, score: verdict.score, segments: verdict.segments },
    })
    return reply.headers(call.headers(served.model)).send(verdict)
  })
}
