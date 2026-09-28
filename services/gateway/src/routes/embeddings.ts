import type { FastifyInstance } from 'fastify'

import { jsonAttempt, watchClient } from '../attempts.ts'
import { estimateEmbeddingInput } from '../budget/estimate.ts'
import { assertPlannable, ModelCall, readCallMeta, resolveAlias } from '../call.ts'
import type { GatewayContext } from '../call.ts'
import { GatewayError } from '../errors.ts'
import { planChain } from '../routing/plan.ts'
import type { Capability } from '../routing/schema.ts'
import { embeddingsRequestSchema, embeddingsResponseSchema } from '../schemas/embeddings.ts'
import { readUsage } from '../upstream/usage.ts'
import { parseBody } from './body.ts'

const MIB = 1_048_576
// 128 vectors of 1,024 floats serialise to a few megabytes of JSON.
const MAX_EMBEDDINGS_BYTES = 16 * MIB
const needs: ReadonlySet<Capability> = new Set(['embedding'])

export function registerEmbeddings(app: FastifyInstance, ctx: GatewayContext): void {
  app.post('/embeddings', { bodyLimit: 2 * MIB }, async (request, reply) => {
    const meta = readCallMeta(request, ctx.routing)
    const body = parseBody(embeddingsRequestSchema, request.body)
    const alias = resolveAlias(ctx.routing, meta.system, body.model, 'embedding')
    const inputs = typeof body.input === 'string' ? [body.input] : body.input
    const input = estimateEmbeddingInput(inputs)
    if (input > alias.maxInputTokens) {
      throw new GatewayError(413, 'input_too_large', `The input is about ${input} tokens; ${alias.name} takes up to ${alias.maxInputTokens} per call.`)
    }
    const plan = planChain(alias, meta.dataClass, ctx.profile, needs)
    assertPlannable(plan, alias, needs)

    const call = new ModelCall(ctx, meta, alias, plan, { input, output: 0 }, false)
    await call.admit()
    const served = await call.run(jsonAttempt(
      '/embeddings',
      model => ({ model: model.id, input: body.input }),
      (json) => {
        // One vector per input, or the caller would pair texts with the wrong vectors.
        const parsed = embeddingsResponseSchema.safeParse(json)
        return parsed.success && parsed.data.data.length === inputs.length
      },
      MAX_EMBEDDINGS_BYTES,
      watchClient(reply.raw),
      ctx.now,
    ))
    await call.finish(served, readUsage(served.value.json), { ok: true })
    return reply.headers(call.headers(served.model)).type('application/json').send(served.value.text)
  })
}
