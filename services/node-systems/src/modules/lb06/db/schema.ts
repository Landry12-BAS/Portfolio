// LB-06's tables, in the lb06 schema: one schema per system (AGENTS.md, Architecture rules). Every
// table is declared inside it, so Drizzle names the schema in each query and each migration, and
// every connection is also opened with a search_path that holds only lb06 (core/database.ts).
// Drizzle writes the migrations from this file (`drizzle-kit generate --config drizzle.lb06.config.ts`).
//
// How the tables fit together: an incident is a visitor's scenario and where it stands; its event log
// is the whole story, numbered without gaps, and cascades with it. The usage counters outlive the
// incidents they counted, so deleting one gives no place back. The scenario cache holds the agents'
// work for a scenario that was run before, so a curated sample costs its model calls once.
import type { Lb06EndReason, Lb06Event, Lb06FaultParams, Lb06PendingProposal, Lb06SpecialistReport, Lb06State } from '@lb/contracts'
import { sql } from 'drizzle-orm'
import { check, date, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import type { Remediation } from '../sim/faults.ts'

/** The name of LB-06's Postgres schema. */
export const LB06_SCHEMA = 'lb06'

const lb06 = pgSchema(LB06_SCHEMA)

/** A timestamp column with a time zone, which defaults to now. */
const now = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow()
/** A timestamp column with a time zone and no default. */
const moment = (name: string) => timestamp(name, { withTimezone: true })

/** What the engine keeps of an investigation between proposals: the specialists' reports, for a second ranking. */
export interface StoredInvestigation {
  reports: Lb06SpecialistReport[]
}

/** An incident: its scenario, its owner, where it stands, what it has cost, and what waits for the visitor. */
export const incidents = lb06.table('incidents', {
  // Also the id of the incident's run in the gateway's and the tracer's eyes, so the Scope can follow it.
  id: uuid('id').primaryKey().defaultRandom(),
  // The visitor's hashed session, never the raw cookie.
  sessionKey: text('session_key').notNull(),
  origin: text('origin').notNull(),
  sampleId: text('sample_id'),
  seed: integer('seed').notNull(),
  fault: text('fault').notNull(),
  // The fault's parameters after the injection screen; the visitor's own words at most 40 characters each.
  params: jsonb('params').$type<Lb06FaultParams>().notNull().default({}),
  guard: text('guard').notNull().default('not_needed'),
  state: text('state').notNull().default('baseline'),
  endReason: text('end_reason'),
  // The simulated minute the incident has reached: the number of ticks in its log, less one.
  minute: integer('minute').notNull().default(0),
  // When the next tick is due, so a job that resumes keeps the pace.
  nextTickAt: moment('next_tick_at').notNull(),
  modelCalls: integer('model_calls').notNull().default(0),
  cached: integer('cached').notNull().default(0),
  proposalsMade: integer('proposals_made').notNull().default(0),
  pendingProposal: jsonb('pending_proposal').$type<Lb06PendingProposal>(),
  // Whether the visitor rejected the pending proposal and the agents must rank again.
  rerank: integer('rerank').notNull().default(0),
  remediations: jsonb('remediations').$type<Remediation[]>().notNull().default([]),
  // The minute the last remediation was applied, for the verification window.
  remediatedAt: integer('remediated_at'),
  investigation: jsonb('investigation').$type<StoredInvestigation>(),
  alertMinute: integer('alert_minute'),
  recoveredMinute: integer('recovered_minute'),
  // How many times a worker has started this incident's job, across retries and the sweep's requeues.
  attempts: integer('attempts').notNull().default(0),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
  // When the incident is ended whatever its state (the wall-clock cap), and when it is deleted.
  deadlineAt: moment('deadline_at').notNull(),
  expiresAt: moment('expires_at').notNull(),
}, table => [
  index('incidents_session_idx').on(table.sessionKey, table.createdAt),
  index('incidents_expires_idx').on(table.expiresAt),
  index('incidents_state_idx').on(table.state, table.updatedAt),
  check('incidents_origin_check', sql`${table.origin} in ('sample', 'custom')`),
  check('incidents_sample_check', sql`(${table.origin} = 'sample') = (${table.sampleId} is not null)`),
  check('incidents_fault_check', sql`${table.fault} in ('bad_deploy', 'slow_payment', 'memory_leak', 'cache_stampede')`),
  check('incidents_guard_check', sql`${table.guard} in ('not_needed', 'clean', 'flagged', 'unchecked')`),
  // The states are the closed list LB06_STATES in @lb/contracts; a test checks the two agree.
  check('incidents_state_check', sql`${table.state} in ('baseline', 'detecting', 'investigating', 'awaiting_approval', 'remediating', 'verifying', 'writing_postmortem', 'closed', 'aborted', 'failed')`),
  check('incidents_end_check', sql`(${table.state} in ('aborted', 'failed')) = (${table.endReason} is not null)`),
  check('incidents_pending_check', sql`(${table.state} = 'awaiting_approval') = (${table.pendingProposal} is not null)`),
  check('incidents_calls_check', sql`${table.modelCalls} between 0 and 15`),
  check('incidents_proposals_check', sql`${table.proposalsMade} between 0 and 3`),
])

/** One event of an incident's log, numbered without gaps from 1. */
export const incidentEvents = lb06.table('incident_events', {
  incidentId: uuid('incident_id').notNull().references(() => incidents.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  kind: text('kind').notNull(),
  minute: integer('minute').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull(),
  data: jsonb('data').$type<Lb06Event['data']>().notNull(),
}, table => [
  primaryKey({ columns: [table.incidentId, table.seq] }),
  check('incident_events_seq_check', sql`${table.seq} between 1 and 600`),
])

/** How much of a daily allowance each visitor has used. A counter outlives the incidents it counted. */
export const usageCounters = lb06.table('usage_counters', {
  sessionKey: text('session_key').notNull(),
  day: date('day', { mode: 'string' }).notNull(),
  kind: text('kind').notNull(),
  used: integer('used').notNull(),
}, table => [
  primaryKey({ columns: [table.sessionKey, table.day, table.kind] }),
  check('usage_counters_kind_check', sql`${table.kind} in ('incident')`),
])

/** The agents' work for a scenario that was run before, by the scenario's key and the stage, so a curated sample costs its calls once. */
export const scenarioCache = lb06.table('scenario_cache', {
  key: text('key').notNull(),
  stage: text('stage').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: now('created_at'),
}, table => [
  primaryKey({ columns: [table.key, table.stage] }),
])

/** Every table of the schema, for typed queries. */
export const tables = { incidents, incidentEvents, usageCounters, scenarioCache }

/** The states as the database's check names them; a test compares them with the contracts' list. */
export const STATES_IN_SCHEMA: readonly Lb06State[] = ['baseline', 'detecting', 'investigating', 'awaiting_approval', 'remediating', 'verifying', 'writing_postmortem', 'closed', 'aborted', 'failed']
/** The end reasons as the code uses them. */
export type EndReason = Lb06EndReason
