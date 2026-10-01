// Visitor authentication for a system's routes: a valid visitor token for that system, or 401.
//
// The check itself, and the token's format, are in @lb/common's visitors module, which
// every Node system shares. Here it becomes a Fastify hook that runs before anything else
// on a request, so an unauthenticated caller learns nothing about the route's shape.
import type { Visitor, VisitorVerifier } from '@lb/common'
import { VisitorTokenError } from '@lb/common'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { AppError } from './errors.ts'

declare module 'fastify' {
  /** Fastify's request, plus the visitor the token vouched for. */
  interface FastifyRequest {
    // The anonymous visitor, known by their session hash; null before authentication.
    visitor: Visitor | null
  }
}

/**
 * Requires a valid visitor token on every route of a scope. A missing, malformed, expired
 * or foreign token, and a token for another system, all answer the same 401, so a caller
 * can't probe which check failed.
 */
export function requireVisitor(scope: FastifyInstance, verify: VisitorVerifier): void {
  scope.decorateRequest('visitor', null)
  scope.addHook('onRequest', async (request) => {
    try {
      request.visitor = verify(request.headers.authorization)
    }
    catch (error) {
      if (error instanceof VisitorTokenError) throw new AppError(401, 'unauthorized', 'This route needs a valid visitor token for its system.')
      throw error
    }
  })
}

/** Returns the visitor of an authenticated request; a route behind `requireVisitor` always has one. */
export function visitorOf(request: FastifyRequest): Visitor {
  if (!request.visitor) throw new AppError(401, 'unauthorized', 'This route needs a valid visitor token for its system.')
  return request.visitor
}
