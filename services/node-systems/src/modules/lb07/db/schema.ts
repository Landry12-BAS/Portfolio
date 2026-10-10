// LB-07's tables, in the lb07 schema: one schema per system (AGENTS.md, Architecture rules). Every table
// is declared inside it, so Drizzle names the schema in each query and each migration, and every
// connection is opened with a search_path that holds only lb07 (core/database.ts). Drizzle writes the
// migrations from this file (`drizzle-kit generate --config drizzle.lb07.config.ts`).
//
// How the tables fit together: a run is a visitor's goal, the bugs they switched on, and what the agent
// did about it. Everything that belongs to a run (its steps, its findings, its evidence, its report
// with the generated test) references it and cascades, so deleting the run when it expires removes all
// of it at once: the sweep deletes expired runs, and nothing a visitor made outlives its hour. The
// usage counters are the one table that does not hang from a run: a counter outlives the run it
// counted, so deleting a run does not give its place back.
import type { Lb07Report, Lb07Step, Lb07Verdict } from '@lb/contracts'
import { sql } from 'drizzle-orm'
import { check, customType, date, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import type { Working } from '../agent/working.ts'

/** The name of LB-07's Postgres schema. */
export const LB07_SCHEMA = 'lb07'

const lb07 = pgSchema(LB07_SCHEMA)

/** A timestamp column with a time zone, which defaults to now. */
const now = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow()
/** A timestamp column with a time zone and no default. */
const moment = (name: string) => timestamp(name, { withTimezone: true })

/** Postgres's `bytea`, as a Buffer: the bytes of a screenshot. */
const bytea = customType<{ data: Buffer, driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

/** A run: a visitor's goal and bugs, its state, and what it has paid for so far. */
export const runs = lb07.table('runs', {
  // Also the id of the run in the gateway's and the tracer's eyes, so the Scope can follow it.
  id: uuid('id').primaryKey().defaultRandom(),
  // The visitor's hashed session, never the raw cookie.
  sessionKey: text('session_key').notNull(),
  origin: text('origin').notNull(),
  sampleId: text('sample_id'),
  // The goal as the visitor wrote it (or the sample's). Shown back to the same visitor only.
  goal: text('goal').notNull(),
  bugs: jsonb('bugs').$type<string[]>().notNull(),
  state: text('state').notNull().default('queued'),
  failureCode: text('failure_code'),
  // The planner's one sentence on how it read the goal.
  reading: text('reading'),
  // What the agent has worked out and paid for (agent/working.ts), saved after each model call so a retry resumes.
  working: jsonb('working').$type<Working>(),
  // The plan that was run in the end: the steps that passed or made a finding, in order. What the generated test is written from.
  finalPlan: jsonb('final_plan').$type<Lb07Step[]>(),
  modelCalls: integer('model_calls').notNull().default(0),
  replans: integer('replans').notNull().default(0),
  findingsCount: integer('findings_count').notNull().default(0),
  // How many times a worker has started this run, across retries and the sweep's requeues.
  attempts: integer('attempts').notNull().default(0),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
  startedAt: moment('started_at'),
  endedAt: moment('ended_at'),
  // When the run and everything that belongs to it is deleted: an hour after it was made.
  expiresAt: moment('expires_at').notNull(),
}, table => [
  index('runs_session_idx').on(table.sessionKey, table.createdAt),
  index('runs_expires_idx').on(table.expiresAt),
  index('runs_state_idx').on(table.state, table.updatedAt),
  check('runs_origin_check', sql`${table.origin} in ('sample', 'custom')`),
  check('runs_sample_check', sql`(${table.origin} = 'sample') = (${table.sampleId} is not null)`),
  // The states are the closed list LB07_STATES in @lb/contracts; a test checks the two agree.
  check('runs_state_check', sql`${table.state} in ('queued', 'planning', 'running', 'replanning', 'cross_checking', 'reporting', 'verifying', 'done', 'failed')`),
  check('runs_failure_check', sql`(${table.state} = 'failed') = (${table.failureCode} is not null)`),
  check('runs_goal_check', sql`char_length(${table.goal}) between 1 and 300`),
])

/** One step of a run's plan as it was run: the step, which plan it came from, what became of it. */
export const runSteps = lb07.table('run_steps', {
  runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  index: integer('index').notNull(),
  plan: integer('plan').notNull().default(0),
  step: jsonb('step').$type<Lb07Step>().notNull(),
  status: text('status').notNull(),
  outcome: text('outcome'),
  durationMs: integer('duration_ms'),
}, table => [
  primaryKey({ columns: [table.runId, table.index] }),
  check('run_steps_status_check', sql`${table.status} in ('pending', 'running', 'passed', 'failed', 'finding', 'blocked', 'skipped')`),
])

/** One finding code made: its kind, where, and the evidence that shows it. */
export const findings = lb07.table('findings', {
  runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  // `f1`, `f2`, ... in the order they were made.
  id: text('id').notNull(),
  kind: text('kind').notNull(),
  engine: text('engine').notNull(),
  stepIndex: integer('step_index'),
  title: text('title').notNull(),
  detail: text('detail').notNull(),
  rule: text('rule'),
  path: text('path'),
  evidenceIds: jsonb('evidence_ids').$type<string[]>().notNull(),
}, table => [
  primaryKey({ columns: [table.runId, table.id] }),
  check('findings_kind_check', sql`${table.kind} in ('expectation_failed', 'console_error', 'failed_request', 'accessibility', 'blocked_navigation')`),
  check('findings_engine_check', sql`${table.engine} in ('chromium', 'firefox-ua')`),
])

/** A piece of evidence: a screenshot (bytes) or a trimmed accessibility snapshot (text). Gone with the run. */
export const evidence = lb07.table('evidence', {
  runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  id: text('id').notNull(),
  kind: text('kind').notNull(),
  engine: text('engine').notNull(),
  stepIndex: integer('step_index'),
  image: bytea('image'),
  text: text('text'),
  createdAt: now('created_at'),
}, table => [
  primaryKey({ columns: [table.runId, table.id] }),
  check('evidence_kind_check', sql`${table.kind} in ('screenshot', 'snapshot')`),
  check('evidence_content_check', sql`(${table.kind} = 'screenshot') = (${table.image} is not null)`),
])

/** The finished report of a run, with the generated test and its verdict. */
export const reports = lb07.table('reports', {
  runId: uuid('run_id').primaryKey().references(() => runs.id, { onDelete: 'cascade' }),
  report: jsonb('report').$type<Lb07Report>().notNull(),
  testSource: text('test_source').notNull(),
  verdict: text('verdict').$type<Lb07Verdict>().notNull(),
  createdAt: now('created_at'),
}, table => [
  check('reports_verdict_check', sql`${table.verdict} in ('kept', 'passing', 'discarded_not_red', 'discarded_not_green', 'not_verified')`),
])

/** How much of the daily allowance each visitor has used. A counter outlives the runs it counted. */
export const usageCounters = lb07.table('usage_counters', {
  sessionKey: text('session_key').notNull(),
  day: date('day', { mode: 'string' }).notNull(),
  kind: text('kind').notNull(),
  used: integer('used').notNull(),
}, table => [
  primaryKey({ columns: [table.sessionKey, table.day, table.kind] }),
  check('usage_counters_kind_check', sql`${table.kind} in ('run')`),
])

/** Every table of the schema, for typed queries. */
export const tables = { runs, runSteps, findings, evidence, reports, usageCounters }
