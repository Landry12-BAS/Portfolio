// LB-08's API: every route a visitor's browser (through the site) may call, behind the
// visitor token for lb-08. They are mounted by the module under /api/lb08.
import {
  catalogueViewSchema,
  createWorkflowRequestSchema,
  decisionRequestSchema,
  deadLetterViewSchema,
  errorBodySchema,
  limitsViewSchema,
  runEventSchema,
  runSummarySchema,
  runViewSchema,
  sampleViewSchema,
  sentViewSchema,
  startRunRequestSchema,
  stepViewSchema,
  updateWorkflowRequestSchema,
  workflowGraphSchema,
  workflowSummarySchema,
  workflowViewSchema,
} from '@lb/contracts'
import type { VisitorVerifier } from '@lb/common'
import type { FastifyInstance } from 'fastify'

import { requireVisitor } from '../../../core/visitor-auth.ts'
import type { SchemaNames } from '../../../core/openapi.ts'
import { registerCatalogueRoutes } from './catalogue.ts'
import { registerRunRoutes } from './runs.ts'
import { registerSandboxRoutes } from './sandbox.ts'
import { typed } from './shared.ts'
import type { Lb08Services } from './shared.ts'
import { registerWorkflowRoutes } from './workflows.ts'

/** The names the OpenAPI document gives LB-08's schemas, so the site's typed client has readable types. */
export const LB08_SCHEMA_NAMES: SchemaNames = {
  CatalogueView: catalogueViewSchema,
  CreateWorkflowRequest: createWorkflowRequestSchema,
  DeadLetterView: deadLetterViewSchema,
  DecisionRequest: decisionRequestSchema,
  ErrorBody: errorBodySchema,
  LimitsView: limitsViewSchema,
  RunEvent: runEventSchema,
  RunSummary: runSummarySchema,
  RunView: runViewSchema,
  SampleView: sampleViewSchema,
  SentView: sentViewSchema,
  StartRunRequest: startRunRequestSchema,
  StepView: stepViewSchema,
  UpdateWorkflowRequest: updateWorkflowRequestSchema,
  WorkflowGraph: workflowGraphSchema,
  WorkflowSummary: workflowSummarySchema,
  WorkflowView: workflowViewSchema,
}

/** Adds every LB-08 route to a scope, behind the visitor token. */
export function registerLb08Routes(scope: FastifyInstance, services: Lb08Services, verify: VisitorVerifier): void {
  requireVisitor(scope, verify)
  const app = typed(scope)
  registerCatalogueRoutes(app, services)
  registerWorkflowRoutes(app, services)
  registerRunRoutes(app, services)
  registerSandboxRoutes(app, services)
}
