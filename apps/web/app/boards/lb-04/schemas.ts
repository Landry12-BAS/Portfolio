// What LB-04's API says, checked before the board uses any of it. A report carries the output of a model
// (the summaries) and of a PDF reader (every page's text and every quote), so each field is bounded and
// typed here (docs/STACK.md: Zod at every boundary), and an answer that does not fit is treated as the
// system failing and never shown. The schemas are the ones in @lb/contracts, which the service builds its
// answers from, so the board does not write them a second time: it only adds the shapes of the lists.
//
// Each shape is also checked against the type generated from the service's OpenAPI document, so a field
// the service adds or renames shows up as a type error here instead of a blank on the page.
import type { NodeComponents } from '@lb/api-clients'
import {
  lb04ContractViewSchema,
  lb04FileViewSchema,
  lb04LimitsViewSchema,
  lb04PagesViewSchema,
  lb04PlaybookViewSchema,
  lb04RedlineSchema,
  lb04ReportSchema,
} from '@lb/contracts'
import type {
  Lb04Citation,
  Lb04ContractView,
  Lb04DiffPart,
  Lb04FileView,
  Lb04Finding,
  Lb04LimitsView,
  Lb04PagesView,
  Lb04PlaybookView,
  Lb04RadarScore,
  Lb04Redline,
  Lb04Report,
  Lb04RuleView,
} from '@lb/contracts'
import { z } from 'zod'

export { lb04ContractViewSchema, lb04FileViewSchema, lb04LimitsViewSchema, lb04PagesViewSchema, lb04PlaybookViewSchema, lb04RedlineSchema, lb04ReportSchema }
export type { Lb04Citation, Lb04ContractView, Lb04DiffPart, Lb04FileView, Lb04Finding, Lb04LimitsView, Lb04PagesView, Lb04PlaybookView, Lb04RadarScore, Lb04Redline, Lb04Report, Lb04RuleView }

/** The visitor's contracts, newest first (the service lists at most twenty). */
export const contractListSchema = z.array(lb04ContractViewSchema).max(20)

// The checks against the service's own document: each one compiles only while what a schema
// produces has every field the document requires (and a compatible type for it). They exist for
// the type checker and cost nothing at run time.
/** The shapes the service's OpenAPI document defines. */
type Schemas = NodeComponents['schemas']
/** Fails to compile unless its argument is `true`. */
type Assert<T extends true> = T
/** The agreements between these schemas and the OpenAPI document, one for each shape the board reads. */
export type OpenApiChecks = [
  Assert<Lb04ContractView extends Schemas['Lb04ContractView'] ? true : false>,
  Assert<Lb04PagesView extends Schemas['Lb04PagesView'] ? true : false>,
  Assert<Lb04FileView extends Schemas['Lb04FileView'] ? true : false>,
  Assert<Lb04Report extends Schemas['Lb04Report'] ? true : false>,
  Assert<Lb04Redline extends Schemas['Lb04Redline'] ? true : false>,
  Assert<Lb04LimitsView extends Schemas['Lb04LimitsView'] ? true : false>,
  Assert<Lb04PlaybookView extends Schemas['Lb04PlaybookView'] ? true : false>,
]
