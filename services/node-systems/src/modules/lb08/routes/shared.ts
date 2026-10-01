// What every LB-08 route file shares: the services the routes call, how a scope is typed with
// Zod, and the error answers each route documents.
import { errorBodySchema } from '@lb/contracts'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { Sample } from '../data/samples.ts'
import type { EngineDeps } from '../engine/deps.ts'
import type { DescribeWorkflow } from '../generate/outcome.ts'

/** What the routes are built on: the engine, the way to describe a workflow (absent when the service has no gateway), and the curated samples. */
export interface Lb08Services {
  deps: EngineDeps
  describe: DescribeWorkflow | undefined
  samples: readonly Sample[]
}

/** A Fastify scope whose routes are checked against their Zod schemas. */
export function typed(scope: FastifyInstance) {
  return scope.withTypeProvider<ZodTypeProvider>()
}

/** A typed scope. */
export type Typed = ReturnType<typeof typed>

/** The error statuses LB-08's routes use, each answered in the platform's error shape. */
export const errors = {
  unauthorized: { 401: errorBodySchema },
  invalid: { 422: errorBodySchema },
  missing: { 404: errorBodySchema },
  conflict: { 409: errorBodySchema },
  limited: { 429: errorBodySchema },
  unavailable: { 503: errorBodySchema },
} as const

/** The parameters of a route that names one workflow, run or dead letter by its id. */
export const idParams = z.strictObject({ id: z.uuid() })

/** The parameters of a route that names a step of a run. */
export const stepParams = z.strictObject({ id: z.uuid(), nodeId: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/) })

/** Tags the routes in the OpenAPI document. */
export const TAGS = ['LB-08 Automation Studio']
