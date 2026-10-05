// What LB-06's API and WebSocket say, checked before the board uses any of it. The schemas are the
// ones in @lb/contracts, which the service builds its answers from, so the board does not write them
// a second time: it only adds the shape of the visitor's incident list and bounds it. Everything an
// incident shows is data the simulator and the agents produced: an answer that does not fit its
// schema is treated as the system failing and is never drawn (docs/STACK.md: Zod at every boundary).
//
// Each shape is also checked against the type generated from the service's OpenAPI document, so a
// field the service adds or renames shows up as a type error here instead of a blank on the page.
import type { NodeComponents } from '@lb/api-clients'
import {
  lb06CatalogueViewSchema,
  lb06EventSchema,
  lb06EventsPageSchema,
  lb06IncidentViewSchema,
  lb06LimitsViewSchema,
  lb06PostmortemViewSchema,
} from '@lb/contracts'
import type {
  Lb06CatalogueView,
  Lb06Event,
  Lb06EventsPage,
  Lb06IncidentView,
  Lb06LimitsView,
  Lb06PostmortemView,
} from '@lb/contracts'
import { z } from 'zod'

export { lb06CatalogueViewSchema, lb06EventSchema, lb06EventsPageSchema, lb06IncidentViewSchema, lb06LimitsViewSchema, lb06PostmortemViewSchema }
export type { Lb06CatalogueView, Lb06Event, Lb06EventsPage, Lb06IncidentView, Lb06LimitsView, Lb06PostmortemView }

/** The visitor's incidents of the day, newest first: one a day, kept for a day, so a handful at most. */
export const incidentListSchema = z.array(lb06IncidentViewSchema).max(10)

// The checks against the service's own document: each one compiles only while what a schema
// produces has every field the document requires (and a compatible type for it). They exist for
// the type checker and cost nothing at run time.

/** The shapes the service's OpenAPI document defines. */
type Schemas = NodeComponents['schemas']
/** Fails to compile unless its argument is `true`. */
type Assert<T extends true> = T

/** The agreements between these schemas and the OpenAPI document, one for each shape the board reads. */
export type OpenApiChecks = [
  Assert<Lb06IncidentView extends Schemas['Lb06IncidentView'] ? true : false>,
  Assert<Lb06Event extends Schemas['Lb06Event'] ? true : false>,
  Assert<Lb06EventsPage extends Schemas['Lb06EventsPage'] ? true : false>,
  Assert<Lb06PostmortemView extends Schemas['Lb06PostmortemView'] ? true : false>,
  Assert<Lb06LimitsView extends Schemas['Lb06LimitsView'] ? true : false>,
  Assert<Lb06CatalogueView extends Schemas['Lb06CatalogueView'] ? true : false>,
]
