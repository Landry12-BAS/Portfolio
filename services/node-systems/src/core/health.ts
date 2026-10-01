// The two checks the container runtime polls: liveness (the process is up) and readiness
// (every system can reach what it depends on). Neither needs a visitor token.
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { RunningModule } from './module.ts'

// The readiness answer: each system's name, and whether it is ready.
const readiness = z.record(z.string(), z.boolean())

/** Names a module in the readiness answer by the last part of its API prefix, such as `lb08`. */
function readinessKey(module: RunningModule): string {
  return module.apiPrefix.split('/').filter(Boolean).at(-1) ?? module.part
}

/**
 * Registers GET /api/healthz and GET /api/readyz. Liveness checks nothing else, so a
 * database blip never restarts the process; readiness asks each system, and answers 503
 * when any of them can't reach its schema or its queue.
 */
export function registerHealth(app: FastifyInstance, modules: readonly RunningModule[]): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get('/api/healthz', {
    schema: { tags: ['health'], summary: 'Liveness', response: { 200: z.strictObject({ status: z.literal('ok') }) } },
  }, async () => ({ status: 'ok' as const }))

  typed.get('/api/readyz', {
    schema: { tags: ['health'], summary: 'Readiness of every system', response: { 200: readiness, 503: readiness } },
  }, async (_request, reply) => {
    const answers = await Promise.all(modules.map(async module => [readinessKey(module), await module.isReady().catch(() => false)] as const))
    const body = Object.fromEntries(answers)
    return reply.code(answers.every(([, ready]) => ready) ? 200 : 503).send(body)
  })
}
