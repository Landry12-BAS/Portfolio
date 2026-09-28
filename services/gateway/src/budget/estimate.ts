import type { ChatRequest } from '../schemas/chat.ts'

// Token estimates for budgets, made before a call. Current tokenizers average about
// four characters per token in English; 3.5 leaves a margin for code, JSON and other
// languages. Settlement replaces the estimate with the provider's count afterwards.
const CHARS_PER_TOKEN = 3.5
// Role markers and separators each message adds.
const MESSAGE_OVERHEAD = 4
const REPLY_PRIMING = 3
// A generous figure for one image: the vision models on the chains tile large images
// into roughly a thousand to fifteen hundred tokens.
const IMAGE_TOKENS = 1600

export interface TokenEstimate {
  input: number
  output: number
}

export function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

type Content = ChatRequest['messages'][number]['content']

function contentTokens(content: Content): number {
  if (content === undefined || content === null) return 0
  if (typeof content === 'string') return textTokens(content)
  let tokens = 0
  for (const part of content) {
    tokens += part.type === 'text' ? textTokens(part.text) : IMAGE_TOKENS
  }
  return tokens
}

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

export function estimateEmbeddingInput(inputs: readonly string[]): number {
  return inputs.reduce((total, input) => total + textTokens(input), 0)
}
