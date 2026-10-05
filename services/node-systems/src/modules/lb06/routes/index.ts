// LB-06's API: every route a visitor's browser (through the site) may call, behind the visitor token
// for lb-06. They are mounted by the module under /api/lb06; the WebSocket lives at /ws/lb06/ and is
// registered at the app's root by the module.
import {
  lb06CatalogueViewSchema,
  lb06DecisionRequestSchema,
  lb06EventSchema,
  lb06EventsPageSchema,
  lb06IncidentViewSchema,
  lb06LimitsViewSchema,
  lb06PostmortemViewSchema,
  lb06StartIncidentRequestSchema,
} from '@lb/contracts'
import type { VisitorVerifier } from '@lb/common'
import type { FastifyInstance } from 'fastify'

import type { SchemaNames } from '../../../core/openapi.ts'
import { requireVisitor } from '../../../core/visitor-auth.ts'
import { registerCatalogueRoutes } from './catalogue.ts'
import { registerIncidentRoutes } from './incidents.ts'
import { typed } from './shared.ts'
import type { Lb06Services } from './shared.ts'

/** The names the OpenAPI document gives LB-06's schemas, so the site's typed client has readable types. */
export const LB06_SCHEMA_NAMES: SchemaNames = {
  Lb06CatalogueView: lb06CatalogueViewSchema,
  Lb06DecisionRequest: lb06DecisionRequestSchema,
  Lb06Event: lb06EventSchema,
  Lb06EventsPage: lb06EventsPageSchema,
  Lb06IncidentView: lb06IncidentViewSchema,
  Lb06LimitsView: lb06LimitsViewSchema,
  Lb06PostmortemView: lb06PostmortemViewSchema,
  Lb06StartIncidentRequest: lb06StartIncidentRequestSchema,
}

/** Adds every LB-06 route to a scope, behind the visitor token. */
export function registerLb06Routes(scope: FastifyInstance, services: Lb06Services, verify: VisitorVerifier): void {
  requireVisitor(scope, verify)
  const app = typed(scope)
  registerCatalogueRoutes(app, services)
  registerIncidentRoutes(app, services)
}
