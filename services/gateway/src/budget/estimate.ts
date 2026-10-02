// Token estimates for budgets, made before a call. Current tokenizers average about
// four characters per token in English; 3.5 leaves a margin for code, JSON and other
// languages. Settlement replaces the estimate with the provider's count afterwards.
import type { ChatRequest } from '../schemas/chat.ts'

const CHARS_PER_TOKEN = 3.5
// Role markers and separators each message adds.
const MESSAGE_OVERHEAD = 4
// Tokens every reply starts with, before the model writes anything.
const REPLY_PRIMING = 3
// A generous figure for one image: the vision models on the chains tile large images
// into roughly a thousand to fifteen hundred tokens.
const IMAGE_TOKENS = 1600

/** Tokens a call is expected to use: the prompt it sends and the most it may get back. */
export interface TokenEstimate {
  input: number
  output: number
  // Requests the call sends to the provider: one, unless said otherwise. The guard
  // sends one per segment of its text.
  requests?: number
  // Speech-to-text only: the seconds of audio the provider will bill, counted from the
  // recording itself. Such a call has no tokens, so `input` and `output` are zero.
  audioSeconds?: number
}

/** Estimates how many tokens a piece of text becomes, erring on the high side. */
export function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Whatever a chat message's `content` may hold: text, parts with images, or nothing. */
type Content = ChatRequest['messages'][number]['content']

/** Estimates the tokens in one message's content, counting each image at a flat rate. */
function contentTokens(content: Content): number {
  if (content === undefined || content === null) return 0
  if (typeof content === 'string') return textTokens(content)
  let tokens = 0
  for (const part of content) {
    tokens += part.type === 'text' ? textTokens(part.text) : IMAGE_TOKENS
  }
  return tokens
}

/**
 * Estimates the prompt tokens of a chat request: every message, earlier tool calls,
 * the tool definitions and any JSON schema, since providers count all of them.
 */
export function estimateChatInput(request: ChatRequest): number {
  let tokens = REPLY_PRIMING
  for (const message of request.messages) {
    tokens += MESSAGE_OVERHEAD + contentTokens(message.content)
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) tokens += textTokens(call.function.name + call.function.arguments)
    }
  }
  if (request.tools) tokens += textTokens(JSON.stringify(request.tools))
  if (request.response_format?.type === 'json_schema') tokens += textTokens(JSON.stringify(request.response_format.json_schema))
  return tokens
}

/** Estimates the tokens in a batch of texts to embed. */
export function estimateEmbeddingInput(inputs: readonly string[]): number {
  return inputs.reduce((total, input) => total + textTokens(input), 0)
}

/** Estimates the prompt tokens of a guard check: one single-message request per segment. */
export function estimateGuardInput(segments: readonly string[]): number {
  return segments.reduce((total, segment) => total + REPLY_PRIMING + MESSAGE_OVERHEAD + textTokens(segment), 0)
}

/**
 * Estimates the tokens a rerank reads. A reranker scores each document paired with the
 * query, so the query is counted once per document.
 */
export function estimateRerankInput(query: string, documents: readonly string[]): number {
  return documents.reduce((total, document) => total + textTokens(query) + textTokens(document), 0)
}
