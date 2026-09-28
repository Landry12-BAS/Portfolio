import { z } from 'zod'

import type { TokenEstimate } from '../budget/estimate.ts'

const usageSchema = z.looseObject({
  prompt_tokens: z.int().min(0),
  completion_tokens: z.int().min(0).optional(),
})

const payloadSchema = z.looseObject({
  usage: usageSchema.nullish(),
  // Groq reports streaming usage here, in the final chunk.
  x_groq: z.looseObject({ usage: usageSchema.nullish() }).nullish(),
})

/** Token usage reported in a completion, a stream chunk or an embeddings response. */
export function readUsage(payload: unknown): TokenEstimate | undefined {
  const parsed = payloadSchema.safeParse(payload)
  if (!parsed.success) return undefined
  const usage = parsed.data.usage ?? parsed.data.x_groq?.usage
  if (!usage) return undefined
  return { input: usage.prompt_tokens, output: usage.completion_tokens ?? 0 }
}
