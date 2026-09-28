// The OpenAI embeddings request and the parts of the answer the gateway checks.
import { z } from 'zod'

// The longest single text accepted; the alias's token limit usually binds first.
const MAX_INPUT = 262_144

/**
 * The embeddings request a caller may send: one text or up to 128. `encoding_format`
 * and `dimensions` are dropped: embedding aliases are pinned to one model and always
 * return its full float vectors.
 */
export const embeddingsRequestSchema = z.object({
  model: z.string().min(1).max(64),
  input: z.union([
    z.string().min(1).max(MAX_INPUT),
    z.array(z.string().min(1).max(MAX_INPUT)).min(1).max(128),
  ]),
})

/** The shape a provider's embeddings answer must have: a list of numeric vectors with indexes. */
export const embeddingsResponseSchema = z.looseObject({
  data: z.array(z.looseObject({ embedding: z.array(z.number()).min(1), index: z.int().min(0) })).min(1),
})
