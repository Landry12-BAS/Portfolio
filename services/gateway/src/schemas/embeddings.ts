import { z } from 'zod'

const MAX_INPUT = 262_144

// `encoding_format` and `dimensions` are dropped: embedding aliases are pinned to one
// model and always return its full float vectors.
export const embeddingsRequestSchema = z.object({
  model: z.string().min(1).max(64),
  input: z.union([
    z.string().min(1).max(MAX_INPUT),
    z.array(z.string().min(1).max(MAX_INPUT)).min(1).max(128),
  ]),
})

export type EmbeddingsRequest = z.infer<typeof embeddingsRequestSchema>

export const embeddingsResponseSchema = z.looseObject({
  data: z.array(z.looseObject({ embedding: z.array(z.number()).min(1), index: z.int().min(0) })).min(1),
})
