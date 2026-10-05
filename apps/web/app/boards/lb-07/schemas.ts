// What LB-07's API says, checked before the board uses any of it. The schemas are the ones in
// @lb/contracts, which the service builds its answers from, so the board does not write them a second
// time: it only adds the shape of the visitor's list of runs and bounds it. Everything a run shows is data
// the service and the sandbox produced, and the only words a model wrote (the planner's reading and the
// bug reports) are bounded there and shown as text: an answer that does not fit its schema is treated as
// the system failing and is never drawn (docs/STACK.md: Zod at every boundary).
//
// Each shape is also checked against the type generated from the service's OpenAPI document, so a field
// the service adds or renames shows up as a type error here instead of a blank on the page.
import type { NodeComponents } from '@lb/api-clients'
import { lb07EvidenceViewSchema, lb07LimitsViewSchema, lb07ReportSchema, lb07RunViewSchema, lb07TestViewSchema } from '@lb/contracts'
import type { Lb07EvidenceView, Lb07LimitsView, Lb07Report, Lb07RunView, Lb07TestView } from '@lb/contracts'
import { z } from 'zod'

export { lb07EvidenceViewSchema, lb07LimitsViewSchema, lb07ReportSchema, lb07RunViewSchema, lb07TestViewSchema }
export type { Lb07EvidenceView, Lb07LimitsView, Lb07Report, Lb07RunView, Lb07TestView }

/** The visitor's runs of the last hour, newest first: the service answers ten at most. */
export const runListSchema = z.array(lb07RunViewSchema).max(10)

// The checks against the service's own document: each one compiles only while what a schema produces
// has every field the document requires (and a compatible type for it). They exist for the type checker
// and cost nothing at run time.

/** The shapes the service's OpenAPI document defines. */
type Schemas = NodeComponents['schemas']
/** Fails to compile unless its argument is `true`. */
type Assert<T extends true> = T

/** The agreements between these schemas and the OpenAPI document, one for each shape the board reads. */
export type OpenApiChecks = [
  Assert<Lb07RunView extends Schemas['Lb07RunView'] ? true : false>,
  Assert<Lb07Report extends Schemas['Lb07Report'] ? true : false>,
  Assert<Lb07TestView extends Schemas['Lb07TestView'] ? true : false>,
  Assert<Lb07EvidenceView extends Schemas['Lb07EvidenceView'] ? true : false>,
  Assert<Lb07LimitsView extends Schemas['Lb07LimitsView'] ? true : false>,
]
