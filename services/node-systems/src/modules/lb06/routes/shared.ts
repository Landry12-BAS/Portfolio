// What every LB-06 route file shares: the services the routes call, how a scope is typed with Zod, and
// the error answers each route documents.
import { errorBodySchema } from '@lb/contracts'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { Lb06Deps } from '../engine/deps.ts'

/** What the routes are built on: the engine's dependencies. */
export interface Lb06Services {
  deps: Lb06Deps
}

/** A Fastify scope whose routes are checked against their Zod schemas. */
export function typed(scope: FastifyInstance) {
  return scope.withTypeProvider<ZodTypeProvider>()
}

/** A typed scope. */
export type Typed = ReturnType<typeof typed>

/** The error statuses LB-06's routes use, each answered in the platform's error shape. */
export const errors = {
  unauthorized: { 401: errorBodySchema },
  invalid: { 422: errorBodySchema },
  missing: { 404: errorBodySchema },
  conflict: { 409: errorBodySchema },
  limited: { 429: errorBodySchema },
  unavailable: { 503: errorBodySchema },
} as const

/** The parameters of a route that names one incident by its id. */
export const idParams = z.strictObject({ id: z.uuid() })

/** The parameters of a route that names a proposal of an incident. */
export const proposalParams = z.strictObject({ id: z.uuid(), proposalId: z.string().regex(/^p[1-3]$/) })

/** Tags the routes in the OpenAPI document. */
export const TAGS = ['LB-06 Incident Commander']
