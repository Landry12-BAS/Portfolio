// Reads the token usage a provider reports, so budgets can be settled with real counts.
import { z } from 'zod'

import type { TokenEstimate } from '../budget/estimate.ts'

// The OpenAI usage object; only the counts the gateway needs are checked.
const usageSchema = z.looseObject({
  prompt_tokens: z.int().min(0),
  completion_tokens: z.int().min(0).optional(),
})

// Where usage can appear in a payload.
const payloadSchema = z.looseObject({
  usage: usageSchema.nullish(),
  // Groq reports streaming usage here, in the final chunk.
  x_groq: z.looseObject({ usage: usageSchema.nullish() }).nullish(),
})

/**
 * Returns the token usage reported in a completion, a stream chunk or an embeddings
 * response, or undefined when there is none (or it doesn't make sense).
 */
export function readUsage(payload: unknown): TokenEstimate | undefined {
  const parsed = payloadSchema.safeParse(payload)
  if (!parsed.success) return undefined
  const usage = parsed.data.usage ?? parsed.data.x_groq?.usage
  if (!usage) return undefined
  return { input: usage.prompt_tokens, output: usage.completion_tokens ?? 0 }
}
