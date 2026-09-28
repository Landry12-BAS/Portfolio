// POST /v1/chat/completions: the OpenAI chat endpoint, answered by whichever model on the
// requested alias's chain can serve the call, as one JSON answer or as a stream.
import { Readable } from 'node:stream'

import type { FastifyInstance } from 'fastify'

import { jsonAttempt, relay, streamAttempt, watchClient } from '../attempts.ts'
import { estimateChatInput } from '../budget/estimate.ts'
import { assertPlannable, ModelCall, readCallMeta, resolveAlias } from '../call.ts'
import type { GatewayContext } from '../call.ts'
import { GatewayError } from '../errors.ts'
import type { Alias, Model } from '../routing/load.ts'
import { planChain } from '../routing/plan.ts'
import type { Capability } from '../routing/schema.ts'
import { chatCompletionSchema, chatRequestSchema } from '../schemas/chat.ts'
import type { ChatRequest } from '../schemas/chat.ts'
import { readUsage } from '../upstream/usage.ts'
import { parseBody } from './body.ts'

const MIB = 1_048_576
// The largest non-streamed answer the gateway will buffer.
const MAX_COMPLETION_BYTES = 8 * MIB

/** Works out what a model must support to take this request: tools, images or a JSON schema. */
export function requiredCapabilities(request: ChatRequest): Set<Capability> {
  const needs = new Set<Capability>(['chat'])
  const usesTools = request.tools !== undefined
    || request.messages.some(message => message.role === 'tool' || (message.role === 'assistant' && message.tool_calls !== undefined))
  if (usesTools) needs.add('tools')
  const hasImages = request.messages.some(message => message.role === 'user' && Array.isArray(message.content)
    && message.content.some(part => part.type === 'image_url'))
  if (hasImages) needs.add('vision')
  if (request.response_format?.type === 'json_schema') needs.add('json_schema')
  return needs
}

/**
 * Returns the answer's token cap: the caller's own, or the alias's default. A cap
 * above the alias's limit is refused rather than quietly lowered.
 */
export function outputLimit(request: ChatRequest, alias: Alias): number {
  const requested = request.max_completion_tokens ?? request.max_tokens
  if (requested !== undefined && requested > alias.maxOutputTokens) {
    throw new GatewayError(400, 'invalid_request', `max_tokens is above ${alias.name}'s limit of ${alias.maxOutputTokens}.`)
  }
  return requested ?? alias.maxOutputTokens
}

/**
 * Rewrites the validated request for one model: the provider's model ID, the provider's
 * name for the token cap, reasoning effort only for models that reason, and a request
 * for token usage on streams.
 */
export function upstreamChatBody(request: ChatRequest, model: Model, maxOutput: number, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { ...request, model: model.id }
  delete body.max_tokens
  delete body.max_completion_tokens
  delete body.reasoning_effort
  delete body.stream
  delete body.stream_options
  body[model.provider.maxTokensParam] = maxOutput
  if (request.reasoning_effort && model.capabilities.has('reasoning')) body.reasoning_effort = request.reasoning_effort
  if (stream) {
    body.stream = true
    // The gateway needs the provider's token count to settle the budget.
    if (model.provider.streamUsage) body.stream_options = { include_usage: true }
  }
  return body
}

/** Registers the chat completions route on the /v1 scope. */
export function registerChat(app: FastifyInstance, ctx: GatewayContext): void {
  // 10 MB leaves room for a few inline images.
  app.post('/chat/completions', { bodyLimit: 10 * MIB }, async (request, reply) => {
    // 1. Check everything before spending anything: headers, body, alias, sizes.
    const meta = readCallMeta(request, ctx.routing)
    const body = parseBody(chatRequestSchema, request.body)
    const alias = resolveAlias(ctx.routing, meta.system, body.model, 'chat')
    const maxOutput = outputLimit(body, alias)
    const input = estimateChatInput(body)
    if (input > alias.maxInputTokens) {
      throw new GatewayError(413, 'input_too_large', `The prompt is about ${input} tokens; ${alias.name} takes up to ${alias.maxInputTokens}.`)
    }
    const needs = requiredCapabilities(body)
    const plan = planChain(alias, meta.dataClass, ctx.profile, needs)
    assertPlannable(plan, alias, needs)

    // 2. Count the call against its quotas.
    const stream = body.stream === true
    const call = new ModelCall(ctx, meta, alias, plan, { input, output: maxOutput }, stream)
    await call.admit()
    const clientGone = watchClient(reply.raw)

    // 3a. A JSON answer: wait for it, settle the budget, relay it as the provider sent it.
    if (!stream) {
      const served = await call.run(jsonAttempt(
        '/chat/completions',
        model => upstreamChatBody(body, model, maxOutput, false),
        json => chatCompletionSchema.safeParse(json).success,
        MAX_COMPLETION_BYTES,
        clientGone,
        ctx.now,
      ))
      await call.finish(served, readUsage(served.value.json), { ok: true })
      return reply.headers(call.headers(served.model)).type('application/json').send(served.value.text)
    }

    // 3b. A stream: once a model's first event arrives, relay the rest as it comes.
    const served = await call.run(streamAttempt(model => upstreamChatBody(body, model, maxOutput, true), clientGone, ctx.now))
    return reply
      .headers(call.headers(served.model))
      .type('text/event-stream; charset=utf-8')
      .send(Readable.from(relay(ctx, call, served), { objectMode: false }))
  })
}
