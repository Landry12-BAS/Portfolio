import { z } from 'zod'

// The OpenAI chat-completions request, reduced to what the gateway forwards. Unknown
// fields are dropped, not passed on: `n` would multiply the cost of a call, `user`
// would hand providers an identifier, and `logit_bias` or `store` have no use here.

const MAX_TEXT = 262_144
const MAX_IMAGE_URL = 8_388_608

const toolName = z.string().regex(/^[\w-]{1,64}$/, 'letters, digits, underscores and hyphens, up to 64')

const textPart = z.object({
  type: z.literal('text'),
  text: z.string().max(MAX_TEXT),
})

// Images travel inline as data URLs. A remote URL would make the provider fetch a page
// the visitor chose, so it is refused.
const imagePart = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string().max(MAX_IMAGE_URL).regex(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/, 'an inline base64 PNG, JPEG, WebP or GIF data URL'),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
})

const textContent = z.union([z.string().max(MAX_TEXT), z.array(textPart).min(1).max(64)])
const userContent = z.union([
  z.string().max(MAX_TEXT),
  z.array(z.discriminatedUnion('type', [textPart, imagePart])).min(1).max(64),
])

const toolCall = z.object({
  id: z.string().min(1).max(128),
  type: z.literal('function'),
  function: z.object({ name: toolName, arguments: z.string().max(MAX_TEXT) }),
})

const message = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: textContent, name: toolName.optional() }),
  z.object({ role: z.literal('user'), content: userContent, name: toolName.optional() }),
  z.object({
    role: z.literal('assistant'),
    content: textContent.nullable().optional(),
    tool_calls: z.array(toolCall).min(1).max(32).optional(),
    name: toolName.optional(),
  }),
  z.object({ role: z.literal('tool'), content: textContent, tool_call_id: z.string().min(1).max(128) }),
])

const jsonObject = z.record(z.string(), z.unknown())

const tool = z.object({
  type: z.literal('function'),
  function: z.object({
    name: toolName,
    description: z.string().max(4096).optional(),
    parameters: jsonObject.optional(),
    strict: z.boolean().optional(),
  }),
})

const toolChoice = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({ type: z.literal('function'), function: z.object({ name: toolName }) }),
])

const responseFormat = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    json_schema: z.object({
      name: toolName,
      description: z.string().max(4096).optional(),
      schema: jsonObject,
      strict: z.boolean().optional(),
    }),
  }),
])

const outputTokens = z.int().min(1).max(131_072)

export const chatRequestSchema = z.object({
  model: z.string().min(1).max(64),
  messages: z.array(message).min(1).max(256),
  tools: z.array(tool).min(1).max(32).optional(),
  tool_choice: toolChoice.optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: responseFormat.optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().gt(0).max(1).optional(),
  max_tokens: outputTokens.optional(),
  max_completion_tokens: outputTokens.optional(),
  stop: z.union([z.string().min(1).max(64), z.array(z.string().min(1).max(64)).min(1).max(4)]).optional(),
  seed: z.int().optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  // Forwarded only to models that reason; dropped for the rest.
  reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
  stream: z.boolean().optional(),
  // Accepted for client compatibility: the gateway always asks providers for usage.
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
})

export type ChatRequest = z.infer<typeof chatRequestSchema>

// The parts of a completion the gateway relies on; everything else passes through.
export const chatCompletionSchema = z.looseObject({
  choices: z.array(z.looseObject({ message: z.looseObject({ role: z.string() }) })).min(1),
})
