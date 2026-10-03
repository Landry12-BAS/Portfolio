// What LB-03's API says, checked before the board uses any of it. A document's fields are what a
// model read from a stranger's file, and its checks and journal entry are made from those fields, so
// each value is bounded and typed here (docs/STACK.md: Zod at every boundary), and an answer that does
// not fit is treated as the system failing and never shown. Each schema is also checked against the
// type generated from the back end's OpenAPI document, so a field the back end adds or renames shows
// up as a type error here and not as a blank on the page.
import type { FlaskComponents } from '@lb/api-clients'
import { z } from 'zod'

/** The states a document passes through, in order: its pipeline ends in `ready` or `failed`. */
export const STATES = ['uploaded', 'ocr', 'extract', 'validate', 'repair', 'ready', 'failed'] as const
/** The eleven checks, in the order the service runs them. */
export const CHECK_IDS = [
  'required_fields',
  'dates_valid',
  'currency_known',
  'signs_agree',
  'line_math',
  'line_items_sum',
  'vat_math',
  'vat_bases',
  'total_reconciles',
  'fields_on_page',
  'not_duplicate',
] as const
/** Why a document may have no result: the codes the board has words for. */
export const FAILURE_CODES = [
  'unsupported_file',
  'too_large',
  'too_many_pages',
  'image_too_big',
  'unreadable_file',
  'unsafe_file',
  'no_text',
  'ocr_failed',
  'injection_suspected',
  'unchecked',
  'model_failed',
  'model_budget',
  'model_output',
  'time_limit',
  'call_limit',
  'interrupted',
] as const
/** The kinds of value a field holds, which say how it is corrected. */
export const FIELD_KINDS = ['choice', 'text', 'date', 'currency', 'amount', 'quantity', 'rate'] as const

/** Where a document is in its pipeline. An unknown state is not accepted: the board would not know what to show. */
export const stateSchema = z.enum(STATES)
/** The name of a check. */
export const checkIdSchema = z.enum(CHECK_IDS)
/** A failure code. */
export const failureCodeSchema = z.enum(FAILURE_CODES)

/** A document's own ID: the service makes it from random bytes, so it is a short word of URL-safe characters. */
const documentId = z.string().regex(/^[\w-]{8,64}$/)
/** A moment, as ISO 8601 text. */
const moment = z.string().min(10).max(40)
/** The path of a field of the invoice: `total`, `line_items.0.total`, `vat.1.rate` (services/flask-systems/lb03/invoice.py). */
export const fieldPathSchema = z.string().regex(/^(?:[a-z_]{1,20}|(?:line_items|vat)\.\d{1,2}\.[a-z_]{1,20})$/)
/** One corner of a box is a share of the page's width or height; a little outside the page is tolerated and drawn clipped. */
const corner = z.number().min(-0.5).max(1.5)

/** Where a field is printed: its page, the four corners of its words, and how sure the service is, in a number and in a word. */
export const boxSchema = z.object({
  page: z.int().min(1).max(5),
  quad: z.array(corner).length(8),
  confidence: z.number().min(0).max(1),
  match: z.number().min(0).max(1),
  band: z.enum(['high', 'medium', 'low']),
})

/** One field of the invoice, with its value as text, its box when it was found on the page, and the failed checks that name it. */
export const fieldSchema = z.object({
  path: fieldPathSchema,
  kind: z.enum(FIELD_KINDS),
  value: z.string().max(200).nullable(),
  box: boxSchema.nullable(),
  edited: z.boolean(),
  checks: z.array(checkIdSchema).max(CHECK_IDS.length),
})

/** One check's verdict, with the numbers that disagree and the paths of the fields it is about. */
export const checkSchema = z.object({
  id: checkIdSchema,
  status: z.enum(['passed', 'failed', 'skipped']),
  severity: z.enum(['error', 'warning']),
  // An English sentence for someone reading the API: the board writes its own, in the visitor's language.
  message: z.string().max(600),
  fields: z.array(fieldPathSchema).max(300),
  expected: z.string().max(300).nullable(),
  actual: z.string().max(300).nullable(),
})

/** The document this one repeats: one of the visitor's own, or a sample. */
export const duplicateSchema = z.object({
  of: z.string().min(1).max(80),
  source: z.enum(['document', 'sample']),
  same_content: z.boolean(),
})

/** One line of a journal entry: an account, and an amount on one side. */
export const journalLineSchema = z.object({
  account: z.string().min(1).max(20),
  name: z.string().max(120),
  debit: z.string().max(20),
  credit: z.string().max(20),
  memo: z.string().max(200),
})

/** A balanced journal entry, its amounts as decimal strings. */
export const journalSchema = z.object({
  date: z.string().max(12),
  reference: z.string().max(80),
  currency: z.string().max(3),
  lines: z.array(journalLineSchema).max(60),
  total_debit: z.string().max(20),
  total_credit: z.string().max(20),
})

/** One correction the visitor made: which field, what it was and what it became. */
export const correctionSchema = z.object({
  path: fieldPathSchema,
  was: z.string().max(200).nullable(),
  now: z.string().max(200).nullable(),
  at: moment,
})

/** One step of the document's run: what it was, how it ended, how long it took, and a few counts about it. */
export const stepSchema = z.object({
  name: z.string().min(1).max(40),
  status: z.enum(['ok', 'error', 'skipped']),
  ms: z.int().min(0).max(3_600_000),
  detail: z.record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()]))
    .refine(detail => Object.keys(detail).length <= 20, 'a step names at most twenty facts'),
})

/** Why a document has no result. */
export const failureSchema = z.object({
  code: failureCodeSchema,
  // An English sentence for someone reading the API: the board has its own words for each code.
  message: z.string().max(400),
})

/** A document in full: where it is and, once it is read, everything that was made of it. */
export const documentSchema = z.object({
  id: documentId,
  state: stateSchema,
  failure: failureSchema.nullable(),
  label: z.string().max(120),
  kind: z.enum(['pdf', 'png', 'jpeg', 'webp']),
  byte_size: z.int().nonnegative(),
  pages: z.int().min(1).max(5).nullable(),
  created_at: moment,
  updated_at: moment,
  expires_at: moment,
  queued_ahead: z.int().nonnegative().nullable(),
  text_cut: z.boolean(),
  model: z.string().max(120).nullable(),
  model_calls: z.int().min(0).max(20),
  // Null until the pipeline has ended: the run is named when it is over, so the Scope can read it then.
  run_id: z.string().regex(/^[\w-]{8,64}$/).nullable(),
  ocr_ms: z.int().nonnegative().nullable(),
  elapsed_ms: z.int().nonnegative().nullable(),
  steps: z.array(stepSchema).max(20),
  prices_include_vat: z.boolean().nullable(),
  fields: z.array(fieldSchema).max(300).nullable(),
  checks: z.array(checkSchema).max(CHECK_IDS.length).nullable(),
  duplicate: duplicateSchema.nullable(),
  journal: journalSchema.nullable(),
  journal_status: z.enum(['made', 'blocked_by_checks', 'does_not_balance']).nullable(),
  corrections: z.array(correctionSchema).max(100),
  can_export: z.boolean(),
})

/** One line of the visitor's list of documents. */
export const documentSummarySchema = z.object({
  id: documentId,
  state: stateSchema,
  failure: failureSchema.nullable(),
  label: z.string().max(120),
  kind: z.enum(['pdf', 'png', 'jpeg', 'webp']),
  byte_size: z.int().nonnegative(),
  pages: z.int().min(1).max(5).nullable(),
  created_at: moment,
  expires_at: moment,
  checks_failed: z.int().nonnegative().nullable(),
  can_export: z.boolean(),
})

/** The visitor's documents of the hour, newest first. */
export const documentListSchema = z.object({
  documents: z.array(documentSummarySchema).max(50),
})

/** The limits the service enforces, which are the ones the datasheet promises. */
export const limitsSchema = z.object({
  documents_per_day: z.int().positive().max(1_000),
  concurrent_documents: z.int().positive().max(100),
  max_upload_bytes: z.int().positive(),
  max_pages: z.int().positive().max(100),
  file_lifetime_seconds: z.int().positive().max(86_400),
  max_model_calls_per_document: z.int().positive().max(100),
  document_deadline_seconds: z.number().positive().max(3_600),
})

/** The visitor's documents today, the limits, and whether the service can read documents at all right now. */
export const quotaSchema = z.object({
  used: z.int().nonnegative(),
  remaining: z.int().nonnegative(),
  active: z.int().nonnegative(),
  resets_at: moment,
  can_read: z.boolean(),
  limits: limitsSchema,
})

/** What the service answers when a document is deleted: nothing. */
export const nothingSchema = z.undefined()

/** One field of a document. */
export type Field = z.infer<typeof fieldSchema>
/** Where a field is printed. */
export type Box = z.infer<typeof boxSchema>
/** One check's verdict. */
export type Check = z.infer<typeof checkSchema>
/** One correction the visitor made. */
export type Correction = z.infer<typeof correctionSchema>
/** The name of a check. */
export type CheckId = z.infer<typeof checkIdSchema>
/** One step of a document's run. */
export type Step = z.infer<typeof stepSchema>
/** A document in full. */
export type InvoiceDocument = z.infer<typeof documentSchema>
/** A document's line in the list. */
export type DocumentSummary = z.infer<typeof documentSummarySchema>
/** Where a document is in its pipeline. */
export type DocumentState = z.infer<typeof stateSchema>
/** A failure code. */
export type FailureCode = z.infer<typeof failureCodeSchema>
/** A balanced journal entry. */
export type Journal = z.infer<typeof journalSchema>
/** The visitor's allowance and the service's limits. */
export type DocumentQuota = z.infer<typeof quotaSchema>

// The checks against the back end's own document: each one compiles only while what a schema
// produces has every field the document requires (and a compatible type for it). They exist for
// the type checker and cost nothing at run time.
/** The shapes the back end's OpenAPI document defines. */
type Schemas = FlaskComponents['schemas']
/** Fails to compile unless its argument is `true`. */
type Assert<T extends true> = T
/** The agreements between these schemas and the OpenAPI document, one for each shape the board reads. */
export type OpenApiChecks = [
  Assert<InvoiceDocument extends Schemas['DocumentOut'] ? true : false>,
  Assert<DocumentSummary extends Schemas['DocumentSummaryOut'] ? true : false>,
  Assert<DocumentQuota extends Schemas['DocumentQuotaOut'] ? true : false>,
  Assert<Field extends Schemas['FieldOut'] ? true : false>,
  Assert<Box extends Schemas['BoxOut'] ? true : false>,
  Assert<Check extends Schemas['CheckOut'] ? true : false>,
  Assert<Step extends Schemas['StepOut'] ? true : false>,
  Assert<Journal extends Schemas['JournalOut'] ? true : false>,
]
