// What every LB-07 route file shares: the services the routes call, how a scope is typed with Zod, and the
// error answers each route documents.
import { errorBodySchema } from '@lb/contracts'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { Lb07Deps } from '../engine/deps.ts'

/** What the routes are built on. */
export interface Lb07Services {
  deps: Lb07Deps
}

/** A Fastify scope whose routes are checked against their Zod schemas. */
export function typed(scope: FastifyInstance) {
  return scope.withTypeProvider<ZodTypeProvider>()
}

/** A typed scope. */
export type Typed = ReturnType<typeof typed>

/** The error statuses LB-07's routes use, each in the platform's error shape. */
export const errors = {
  unauthorized: { 401: errorBodySchema },
  invalid: { 422: errorBodySchema },
  missing: { 404: errorBodySchema },
  notReady: { 409: errorBodySchema },
  limited: { 429: errorBodySchema },
  unavailable: { 503: errorBodySchema },
} as const

/** The parameters of a route that names one run. */
export const idParams = z.strictObject({ id: z.uuid() })

/** The parameters of a route that names a piece of evidence of a run. */
export const evidenceParams = z.strictObject({ id: z.uuid(), evidenceId: z.string().regex(/^e\d{1,3}$/) })

/** Tags the routes in the OpenAPI document. */
export const TAGS = ['LB-07 QA Engineer']
