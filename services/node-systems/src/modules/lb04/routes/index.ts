// LB-04's API: every route a visitor's browser (through the site) may call, behind the visitor token
// for lb-04. They are mounted by the module under /api/lb04.
import {
  lb04ContractViewSchema,
  lb04CreateContractRequestSchema,
  lb04FileViewSchema,
  lb04LimitsViewSchema,
  lb04PagesViewSchema,
  lb04PlaybookViewSchema,
  lb04RedlineSchema,
  lb04ReportSchema,
  lb04SampleViewSchema,
} from '@lb/contracts'
import type { VisitorVerifier } from '@lb/common'
import type { FastifyInstance } from 'fastify'

import type { SchemaNames } from '../../../core/openapi.ts'
import { requireVisitor } from '../../../core/visitor-auth.ts'
import { registerCatalogueRoutes } from './catalogue.ts'
import { registerContractRoutes } from './contracts.ts'
import { typed } from './shared.ts'
import type { Lb04Services } from './shared.ts'

/**
 * The names the OpenAPI document gives LB-04's schemas, so the site's typed client has readable types. The
 * error body is not named here: LB-08 names it `ErrorBody`, and a schema has one name in the document.
 */
export const LB04_SCHEMA_NAMES: SchemaNames = {
  Lb04ContractView: lb04ContractViewSchema,
  Lb04CreateContractRequest: lb04CreateContractRequestSchema,
  Lb04FileView: lb04FileViewSchema,
  Lb04LimitsView: lb04LimitsViewSchema,
  Lb04PagesView: lb04PagesViewSchema,
  Lb04PlaybookView: lb04PlaybookViewSchema,
  Lb04Redline: lb04RedlineSchema,
  Lb04Report: lb04ReportSchema,
  Lb04SampleView: lb04SampleViewSchema,
}

/** Adds every LB-04 route to a scope, behind the visitor token. */
export function registerLb04Routes(scope: FastifyInstance, services: Lb04Services, verify: VisitorVerifier): void {
  requireVisitor(scope, verify)
  const app = typed(scope)
  registerCatalogueRoutes(app, services)
  registerContractRoutes(app, services)
}
