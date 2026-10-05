// LB-07's API: every route a visitor's browser (through the site) may call, behind the visitor token for
// lb-07. They are mounted by the module under /api/lb07.
import { lb07BugViewSchema, lb07CreateRunRequestSchema, lb07EvidenceViewSchema, lb07LimitsViewSchema, lb07ReportSchema, lb07RunViewSchema, lb07SampleViewSchema, lb07TestViewSchema } from '@lb/contracts'
import type { VisitorVerifier } from '@lb/common'
import type { FastifyInstance } from 'fastify'

import type { SchemaNames } from '../../../core/openapi.ts'
import { requireVisitor } from '../../../core/visitor-auth.ts'
import { registerCatalogueRoutes } from './catalogue.ts'
import { registerRunRoutes } from './runs.ts'
import { typed } from './shared.ts'
import type { Lb07Services } from './shared.ts'

/** The names the OpenAPI document gives LB-07's schemas, so the site's typed client has readable types. */
export const LB07_SCHEMA_NAMES: SchemaNames = {
  Lb07BugView: lb07BugViewSchema,
  Lb07CreateRunRequest: lb07CreateRunRequestSchema,
  Lb07EvidenceView: lb07EvidenceViewSchema,
  Lb07LimitsView: lb07LimitsViewSchema,
  Lb07Report: lb07ReportSchema,
  Lb07RunView: lb07RunViewSchema,
  Lb07SampleView: lb07SampleViewSchema,
  Lb07TestView: lb07TestViewSchema,
}

/** Adds every LB-07 route to a scope, behind the visitor token. */
export function registerLb07Routes(scope: FastifyInstance, services: Lb07Services, verify: VisitorVerifier): void {
  requireVisitor(scope, verify)
  const app = typed(scope)
  registerCatalogueRoutes(app, services)
  registerRunRoutes(app, services)
}
