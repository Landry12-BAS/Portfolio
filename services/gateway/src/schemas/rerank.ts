// The rerank request a caller sends, in the shape Cohere and Jina made common, and the
// answer Workers AI's reranker gives on its own /ai/run endpoint.
import { z } from 'zod'

// Caps per field; the alias's per-document token limit usually binds first.
const MAX_QUERY = 4_096
const MAX_DOCUMENT = 16_384
/** The most documents one call may rank. */
export const MAX_DOCUMENTS = 64

/** The rerank request: a query, the documents to rank against it, and how many to return. */
export const rerankRequestSchema = z.object({
  model: z.string().min(1).max(64),
  query: z.string().min(1).max(MAX_QUERY),
  documents: z.array(z.string().min(1).max(MAX_DOCUMENT)).min(1).max(MAX_DOCUMENTS),
  top_n: z.int().min(1).max(MAX_DOCUMENTS).optional(),
})

/** A validated rerank request. */
export type RerankRequest = z.infer<typeof rerankRequestSchema>

/**
 * Workers AI's answer from a reranker: a score for each context, by the context's index
 * in the request, inside Cloudflare's success envelope.
 */
export const workersRerankSchema = z.looseObject({
  success: z.literal(true),
  result: z.looseObject({
    response: z.array(z.looseObject({ id: z.int().min(0), score: z.number() })),
  }),
})
