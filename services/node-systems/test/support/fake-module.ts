// A stand-in system for the tests of the shared HTTP layer: a module with a few routes that
// are behind visitor authentication, and a few ways to fail, so headers, error shapes and
// authentication can be tested without any database or queue.
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { AppError } from '../../src/core/errors.ts'
import type { RunningModule } from '../../src/core/module.ts'
import { requireVisitor, visitorOf } from '../../src/core/visitor-auth.ts'
import type { VisitorVerifier } from '@lb/common'

/** Builds a module named `lb-99`, whose readiness is whatever `ready` says. */
export function fakeModule(verify: VisitorVerifier, ready: () => Promise<boolean> = async () => true): RunningModule {
  return {
    part: 'lb-99',
    apiPrefix: '/api/lb99',
    registerRoutes(scope: FastifyInstance) {
      requireVisitor(scope, verify)
      const typed = scope.withTypeProvider<ZodTypeProvider>()
      typed.get('/whoami', { schema: { response: { 200: z.strictObject({ session: z.string() }) } } }, async request => ({ session: visitorOf(request).sessionKey }))
      typed.post('/echo', { schema: { body: z.strictObject({ text: z.string().min(1).max(20) }), response: { 200: z.strictObject({ length: z.number() }) } } }, async request => ({ length: request.body.text.length }))
      typed.get('/limit', { schema: { response: { 200: z.strictObject({}) } } }, async () => {
        throw new AppError(429, 'daily_limit', 'A visitor may do this 10 times a day.', { retryAfterSeconds: 90, resetsAt: '2026-10-03T00:00:00.000Z' })
      })
      typed.get('/crash', { schema: { response: { 200: z.strictObject({}) } } }, async () => {
        throw new Error('the database said: the visitor wrote something private')
      })
      typed.get('/leaky', { schema: { response: { 200: z.strictObject({ session: z.string() }) } } }, async () => ({ session: 'ok', secret: 'must not be sent' }) as never)
    },
    startWorkers: async () => [],
    isReady: ready,
    close: async () => {},
  }
}
