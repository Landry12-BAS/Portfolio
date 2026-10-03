// LB-04's tables, in the lb04 schema: one schema per system (AGENTS.md, Architecture rules). Every
// table is declared inside it, so Drizzle names the schema in each query and each migration, and every
// connection is also opened with a search_path that holds only lb04 (core/database.ts). Drizzle writes
// the migrations from this file (`drizzle-kit generate --config drizzle.lb04.config.ts`).
//
// How the tables fit together: a contract is a visitor's file and the review of it. Everything that
// belongs to a contract (its file, its pages' text, its report and its redlines) is a row that
// references it and cascades, so deleting the contract when it expires removes all of it at once: the
// sweep deletes expired contracts, and nothing a visitor sent outlives its hour. The usage counters
// are the one table that doesn't hang from a contract: a counter outlives the contract it counted, so
// deleting a contract doesn't give its place back.
import type { Lb04Redline, Lb04Report } from '@lb/contracts'
import { sql } from 'drizzle-orm'
import { check, customType, date, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

import type { Working } from '../analysis/pipeline.ts'

/** The name of LB-04's Postgres schema. */
export const LB04_SCHEMA = 'lb04'

const lb04 = pgSchema(LB04_SCHEMA)

/** A timestamp column with a time zone, which defaults to now. */
const now = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow()
/** A timestamp column with a time zone and no default. */
const moment = (name: string) => timestamp(name, { withTimezone: true })

/** Postgres's `bytea`, as a Buffer: the bytes of a visitor's PDF. */
const bytea = customType<{ data: Buffer, driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

/** A contract under review, or reviewed: its owner, its state and what the review has paid for so far. */
export const contracts = lb04.table('contracts', {
  // Also the id of the contract's run in the gateway's and the tracer's eyes, so the Scope can follow it.
  id: uuid('id').primaryKey().defaultRandom(),
  // The visitor's hashed session, never the raw cookie.
  sessionKey: text('session_key').notNull(),
  origin: text('origin').notNull(),
  sampleId: text('sample_id'),
  // The file's name as a label for the visitor's list, cleaned (pdf/upload.ts): never used as a path.
  title: text('title').notNull(),
  state: text('state').notNull().default('queued'),
  // Why the review failed, one of the failure codes of @lb/contracts.
  failureCode: text('failure_code'),
  pages: integer('pages'),
  // What the review has worked out and paid for (analysis/pipeline.ts, `Working`), saved after each model call so a retry resumes.
  working: jsonb('working').$type<Working>(),
  modelCalls: integer('model_calls').notNull().default(0),
  // How many times a worker has started this contract's review, across the queue's retries and the sweep's requeues: a contract that keeps failing is ended and not tried for ever.
  attempts: integer('attempts').notNull().default(0),
  redlinesUsed: integer('redlines_used').notNull().default(0),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
  // When the contract, with its file, text, report and redlines, is deleted: an hour after it was made.
  expiresAt: moment('expires_at').notNull(),
}, table => [
  index('contracts_session_idx').on(table.sessionKey, table.createdAt),
  index('contracts_expires_idx').on(table.expiresAt),
  index('contracts_state_idx').on(table.state, table.updatedAt),
  check('contracts_origin_check', sql`${table.origin} in ('upload', 'sample')`),
  check('contracts_sample_check', sql`(${table.origin} = 'sample') = (${table.sampleId} is not null)`),
  // The states are the closed list LB04_STATES in @lb/contracts; a test checks the two agree.
  check('contracts_state_check', sql`${table.state} in ('queued', 'extracting', 'analysing', 'verifying', 'done', 'failed')`),
  check('contracts_failure_check', sql`(${table.state} = 'failed') = (${table.failureCode} is not null)`),
  check('contracts_redlines_check', sql`${table.redlinesUsed} between 0 and 3`),
])

/** The bytes of a contract's PDF, kept only until the review has read them and the contract expires. */
export const contractFiles = lb04.table('contract_files', {
  contractId: uuid('contract_id').primaryKey().references(() => contracts.id, { onDelete: 'cascade' }),
  content: bytea('content').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
})

/** The text of one page of a contract, as the extraction made it: what every citation counts characters in. */
export const contractPages = lb04.table('contract_pages', {
  contractId: uuid('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  page: integer('page').notNull(),
  text: text('text').notNull(),
}, table => [
  primaryKey({ columns: [table.contractId, table.page] }),
  check('contract_pages_page_check', sql`${table.page} between 1 and 30`),
])

/** The finished review of a contract. */
export const reports = lb04.table('reports', {
  contractId: uuid('contract_id').primaryKey().references(() => contracts.id, { onDelete: 'cascade' }),
  report: jsonb('report').$type<Lb04Report>().notNull(),
  createdAt: now('created_at'),
})

/** A redline a visitor asked for, one for each finding at most: asking again shows this one and spends nothing. */
export const redlines = lb04.table('redlines', {
  id: uuid('id').primaryKey().defaultRandom(),
  contractId: uuid('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  findingId: text('finding_id').notNull(),
  redline: jsonb('redline').$type<Lb04Redline>().notNull(),
  createdAt: now('created_at'),
}, table => [
  uniqueIndex('redlines_finding_idx').on(table.contractId, table.findingId),
])

/** How much of a daily allowance each visitor has used. A counter outlives the contracts it counted, so deleting one frees nothing. */
export const usageCounters = lb04.table('usage_counters', {
  sessionKey: text('session_key').notNull(),
  day: date('day', { mode: 'string' }).notNull(),
  kind: text('kind').notNull(),
  used: integer('used').notNull(),
}, table => [
  primaryKey({ columns: [table.sessionKey, table.day, table.kind] }),
  check('usage_counters_kind_check', sql`${table.kind} in ('contract', 'upload')`),
])

/** Every table of the schema, for typed queries. */
export const tables = { contracts, contractFiles, contractPages, reports, redlines, usageCounters }
