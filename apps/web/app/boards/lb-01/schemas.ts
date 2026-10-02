// What LB-01's API says, checked before the board uses any of it. The back end's drafts are the
// output of a model, so each field is bounded and typed here (docs/STACK.md: Zod at every
// boundary), and an answer that does not fit is treated as the system failing, never shown.
// Each schema is also checked against the type generated from the back end's OpenAPI document, so
// a field the back end adds or renames shows up as a type error here instead of a blank on the page.
import type { DjangoComponents } from '@lb/api-clients'
import { z } from 'zod'

/** A synthetic customer, who the visitor files tickets as. */
export const customerSchema = z.object({
  key: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  language: z.string().min(2).max(8),
})

/** One sentence of a draft: its text, the sources it cites, and whether the claim check found them to support it. */
export const sentenceSchema = z.object({
  text: z.string().max(2_000),
  citations: z.array(z.string().max(120)).max(20),
  supported: z.boolean(),
  // Why the claim check did not accept the sentence; null for one it accepted.
  problem: z.string().max(300).nullable(),
})

/** A passage or order the draft cites, in the ticket's language. */
export const sourceSchema = z.object({
  id: z.string().min(1).max(120),
  title: z.string().max(300),
  text: z.string().max(3_000),
})

/** A cited draft. */
export const draftSchema = z.object({
  sentences: z.array(sentenceSchema).max(40),
  claims_supported: z.boolean(),
  model: z.string().max(120),
  sources: z.array(sourceSchema).max(20),
})

/** What a person decided about a draft. */
export const decisionSchema = z.object({
  action: z.string().max(20),
  final_text: z.string().max(4_000),
  decided_at: z.string().max(40),
})

/** Where a ticket stands. An unknown status is not accepted: the board would not know what to show. */
export const statusSchema = z.enum(['received', 'processing', 'awaiting_approval', 'escalated', 'sent', 'failed'])

/** A ticket in full. */
export const ticketSchema = z.object({
  id: z.string().min(1).max(40),
  customer: customerSchema,
  language: z.string().min(2).max(8),
  status: statusSchema,
  // Empty while the pipeline is still working.
  category: z.string().max(40),
  created_at: z.string().max(40),
  body: z.string().max(2_100),
  order_number: z.string().max(40),
  escalation_reason: z.string().max(40),
  // Empty until the back end names the run: Django saves the run's ID with the pipeline's outcome,
  // so a ticket that is still being worked on has none (services/django-systems/lb01/pipeline.py).
  run_id: z.union([z.literal(''), z.string().regex(/^[\w-]{8,64}$/)]),
  expires_at: z.string().max(40),
  draft: draftSchema.nullable(),
  decision: decisionSchema.nullable(),
})

/** One line of the visitor's list of tickets. */
export const ticketSummarySchema = z.object({
  id: z.string().min(1).max(40),
  created_at: z.string().max(40),
})

/** The counters the demo shows. A share is null until there is something to count. */
export const statsSchema = z.object({
  tickets: z.int().nonnegative(),
  awaiting_approval: z.int().nonnegative(),
  sent: z.int().nonnegative(),
  sent_unedited: z.int().nonnegative(),
  escalated: z.int().nonnegative(),
  deflection: z.number().min(0).max(1).nullable(),
  accuracy: z.number().min(0).max(1).nullable(),
})

/** A synthetic customer. */
export type Customer = z.infer<typeof customerSchema>
/** One sentence of a draft. */
export type Sentence = z.infer<typeof sentenceSchema>
/** A source a draft cites. */
export type Source = z.infer<typeof sourceSchema>
/** A cited draft. */
export type Draft = z.infer<typeof draftSchema>
/** A ticket in full. */
export type Ticket = z.infer<typeof ticketSchema>
/** The visitor's counters. */
export type Stats = z.infer<typeof statsSchema>
/** Where a ticket stands. */
export type TicketStatus = z.infer<typeof statusSchema>

// The checks against the back end's own document: each one compiles only while what a schema
// produces has every field the document requires (and a compatible type for it). They exist for
// the type checker and cost nothing at run time.
/** The shapes the back end's OpenAPI document defines. */
type Schemas = DjangoComponents['schemas']
/** Fails to compile unless its argument is `true`. */
type Assert<T extends true> = T
/** The agreements between these schemas and the OpenAPI document, one for each shape the board reads. */
export type OpenApiChecks = [
  Assert<Ticket extends Schemas['TicketOut'] ? true : false>,
  Assert<Stats extends Schemas['StatsOut'] ? true : false>,
  Assert<Customer extends Schemas['CustomerOut'] ? true : false>,
  Assert<Sentence extends Schemas['SentenceOut'] ? true : false>,
  Assert<Source extends Schemas['SourceOut'] ? true : false>,
]
