// What LB-08's API says, checked before the board uses any of it. The schemas are the ones in
// @lb/contracts, which the service builds its answers from and the editor builds its form from, so
// the board does not write them a second time: it only adds the shapes of the lists and of the
// poll, and bounds them. A graph a model wrote reaches the board only after the service validated
// it, and the board validates it again before it shows or saves one (docs/STACK.md: Zod at every
// boundary); an answer that does not fit is treated as the system failing, never shown.
//
// Each shape is also checked against the type generated from the service's OpenAPI document, so a
// field the service adds or renames shows up as a type error here instead of a blank on the page.
import type { NodeComponents } from '@lb/api-clients'
import {
  deadLetterViewSchema,
  limitsViewSchema,
  runEventSchema,
  runStatuses,
  runViewSchema,
  sentViewSchema,
  workflowSummarySchema,
  workflowViewSchema,
} from '@lb/contracts'
import type { DeadLetterView, LimitsView, RunEvent, RunView, SentView, WorkflowSummary, WorkflowView } from '@lb/contracts'
import { z } from 'zod'

export { deadLetterViewSchema, limitsViewSchema, runViewSchema, sentViewSchema, workflowSummarySchema, workflowViewSchema }
export type { DeadLetterView, LimitsView, RunEvent, RunView, SentView, WorkflowSummary, WorkflowView }

/** What a poll of a run's log answers with: where the run is, and the events after the last one the board saw. */
export const runEventsPageSchema = z.strictObject({
  status: z.enum(runStatuses),
  events: z.array(runEventSchema).max(500),
})

/** The visitor's workflows, newest first. */
export const workflowListSchema = z.array(workflowSummarySchema).max(50)

/** What the sandbox sent for the visitor. */
export const sentListSchema = z.array(sentViewSchema).max(50)

/** The visitor's dead letters. */
export const deadLetterListSchema = z.array(deadLetterViewSchema).max(50)

/** One page of a run's log. */
export type RunEventsPage = z.infer<typeof runEventsPageSchema>

// The checks against the service's own document: each one compiles only while what a schema
// produces has every field the document requires (and a compatible type for it). They exist for
// the type checker and cost nothing at run time.
/** The shapes the service's OpenAPI document defines. */
type Schemas = NodeComponents['schemas']
/** Fails to compile unless its argument is `true`. */
type Assert<T extends true> = T
/** The agreements between these schemas and the OpenAPI document, one for each shape the board reads. */
export type OpenApiChecks = [
  Assert<WorkflowView extends Schemas['WorkflowView'] ? true : false>,
  Assert<WorkflowSummary extends Schemas['WorkflowSummary'] ? true : false>,
  Assert<RunView extends Schemas['RunView'] ? true : false>,
  Assert<RunEvent extends Schemas['RunEvent'] ? true : false>,
  Assert<SentView extends Schemas['SentView'] ? true : false>,
  Assert<DeadLetterView extends Schemas['DeadLetterView'] ? true : false>,
  Assert<LimitsView extends Schemas['LimitsView'] ? true : false>,
]
