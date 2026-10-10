// What LB-02's HTTP API says, checked before the board uses any of it: what can be booked, a snapshot
// of the calendar, the visitor's conversations, and one conversation in full with its recorded
// confirmation and its handoff. The conversation itself travels over the WebSocket (wire.ts). Each
// schema is bounded and typed (docs/STACK.md: Zod at every boundary), an answer that does not fit
// is treated as the system failing and never shown, and each is also checked against the type
// generated from the back end's OpenAPI document, so a field the back end adds or renames shows up
// as a type error here instead of a blank on the page.
import type { DjangoComponents } from '@lb/api-clients'
import { z } from 'zod'

import { bookingSchema, holdSchema, optionSchema, slotStatusSchema, stepSchema } from './wire.ts'

// A moment in ISO 8601, with a `Z` or an offset: the server writes UTC.
const MOMENT = z.iso.datetime({ offset: true })
// An offering's key, such as `cupping`.
const OFFERING_KEY = z.string().regex(/^[a-z][a-z-]{0,39}$/)

/** A text in each of the site's two languages. */
export const localizedSchema = z.object({
  en: z.string().max(600),
  cs: z.string().max(600),
})

/** Something a visitor can book: what it is, how long it takes, how many it takes, and what it costs. */
export const offeringSchema = z.object({
  key: OFFERING_KEY,
  title: localizedSchema,
  summary: localizedSchema,
  room: localizedSchema,
  duration_minutes: z.int().min(1).max(600),
  capacity: z.int().min(1).max(100),
  price_czk: z.int().nonnegative().max(1_000_000),
})

/** One slot of the calendar, as the visitor's conversation sees it; `mine` is true for the slot it holds or has. */
export const slotSchema = z.object({
  id: z.int().nonnegative(),
  offering: OFFERING_KEY,
  starts_at: MOMENT,
  ends_at: MOMENT,
  status: slotStatusSchema,
  mine: z.boolean(),
  until: MOMENT.nullable(),
})

/** A snapshot of the calendar. `as_of` is the server's time, for ordering it against the live changes. */
export const calendarSchema = z.object({
  as_of: MOMENT,
  first_day: z.iso.date(),
  last_day: z.iso.date(),
  // Fourteen days of at most eight slots, with room to spare.
  slots: z.array(slotSchema).max(400),
})

/** One line of a transcript, with its place in the conversation and when it was said. */
export const transcriptLineSchema = z.object({
  position: z.int().nonnegative(),
  role: z.enum(['visitor', 'concierge', 'action']),
  text: z.string().max(2_100),
  at: MOMENT,
})

/** The confirmation email as it would have been sent. `delivery` is always `mock`: nothing is ever sent. */
export const confirmationSchema = z.object({
  to: z.string().max(254),
  subject: z.string().max(200),
  body: z.string().max(4_000),
  language: z.string().min(2).max(8),
  delivery: z.literal('mock'),
  recorded_at: MOMENT,
})

/** A conversation handed to a person: why, what was collected, and every line said. */
export const handoffSchema = z.object({
  reason: z.string().max(200),
  summary: z.string().max(2_000),
  created_at: MOMENT,
  transcript: z.array(transcriptLineSchema).max(200),
})

/** A conversation as the visitor's list shows it. */
export const conversationSummarySchema = z.object({
  id: z.string().regex(/^[\w-]{16,24}$/),
  step: stepSchema,
  language: z.string().min(2).max(8),
  messages_used: z.int().nonnegative().max(1_000),
  messages_left: z.int().min(0).max(30),
  closed: z.boolean(),
  created_at: MOMENT,
  expires_at: MOMENT,
})

/** A conversation in full: the transcript, where the booking stands, and what a person would receive. */
export const conversationSchema = conversationSummarySchema.extend({
  // The gateway's run for the whole conversation, which the Scope reads the trace of.
  run_id: z.string().regex(/^[\w-]{8,64}$/),
  model_calls: z.int().nonnegative().max(1_000),
  transcript: z.array(transcriptLineSchema).max(200),
  options: z.array(optionSchema).max(10),
  hold: holdSchema.nullable(),
  booking: bookingSchema.nullable(),
  confirmation: confirmationSchema.nullable(),
  handoff: handoffSchema.nullable(),
})

/** What can be booked, in both languages. */
export const offeringsSchema = z.array(offeringSchema).max(20)
/** The visitor's own conversations, newest first. */
export const conversationListSchema = z.array(conversationSummarySchema).max(100)

/** Something a visitor can book. */
export type Offering = z.infer<typeof offeringSchema>
/** One slot of the calendar. */
export type CalendarSlot = z.infer<typeof slotSchema>
/** A snapshot of the calendar. */
export type CalendarSnapshot = z.infer<typeof calendarSchema>
/** A conversation as the list shows it. */
export type ConversationSummary = z.infer<typeof conversationSummarySchema>
/** A conversation in full. */
export type ConversationDetail = z.infer<typeof conversationSchema>
/** The recorded confirmation. */
export type Confirmation = z.infer<typeof confirmationSchema>
/** A handoff to a person. */
export type Handoff = z.infer<typeof handoffSchema>

// The checks against the back end's own document: each one compiles only while what a schema
// produces fits the shape the document describes. They exist for the type checker and cost nothing at run time.
/** The shapes the back end's OpenAPI document defines. */
type Schemas = DjangoComponents['schemas']
/** Fails to compile unless its argument is `true`. */
type Assert<T extends true> = T
/** The agreements between these schemas and the OpenAPI document, one for each shape the board reads. */
export type OpenApiChecks = [
  Assert<Offering extends Schemas['OfferingOut'] ? true : false>,
  Assert<CalendarSlot extends Schemas['SlotOut'] ? true : false>,
  Assert<CalendarSnapshot extends Schemas['CalendarOut'] ? true : false>,
  Assert<ConversationSummary extends Schemas['ConversationSummary'] ? true : false>,
  Assert<ConversationDetail extends Schemas['ConversationOut'] ? true : false>,
  Assert<Confirmation extends Schemas['ConfirmationOut'] ? true : false>,
  Assert<Handoff extends Schemas['HandoffOut'] ? true : false>,
]
