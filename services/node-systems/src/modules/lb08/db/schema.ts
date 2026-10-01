// LB-08's tables, in the lb08 schema: one schema per system (AGENTS.md, Architecture rules).
// Every table is declared inside it, so Drizzle names the schema in each query and each
// migration, and every connection is also opened with a search_path that holds only lb08
// (core/database.ts). A query can't reach another system's tables, and none of this
// system's code can name them. Drizzle writes the migrations from this file
// (`drizzle-kit generate`).
//
// How the tables fit together:
// - A workflow has versions (each an immutable graph) and runs (each pinned to a version).
// - A run has one row per step of its graph, and an ordered log of events.
// - A connector's side effect goes through the outbox, keyed by `<root run>:<step>`, and the
//   sandbox's own table records what was "sent". The key is what makes a retry or a replay
//   recognise work already done.
// - Everything a visitor creates belongs to their workflow, so deleting the workflow when it
//   expires removes all of it at once.
import type { Values, WorkflowGraph } from '@lb/contracts'
import { sql } from 'drizzle-orm'
import { check, date, index, integer, jsonb, numeric, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/** The name of LB-08's Postgres schema. */
export const LB08_SCHEMA = 'lb08'

const lb08 = pgSchema(LB08_SCHEMA)

/** A timestamp column with a time zone, which defaults to now. */
const now = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow()
/** A timestamp column with a time zone and no default. */
const moment = (name: string) => timestamp(name, { withTimezone: true })

/** A visitor's workflow. Its content lives in its versions. */
export const workflows = lb08.table('workflows', {
  id: uuid('id').primaryKey().defaultRandom(),
  // The visitor's hashed session, never the raw cookie.
  sessionKey: text('session_key').notNull(),
  name: text('name').notNull(),
  latestVersion: integer('latest_version').notNull().default(1),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
  // When the workflow, with its runs and everything else of its own, is deleted.
  expiresAt: moment('expires_at').notNull(),
}, table => [
  index('workflows_session_idx').on(table.sessionKey, table.createdAt),
  index('workflows_expires_idx').on(table.expiresAt),
])

/** One saved version of a workflow: an immutable graph. */
export const workflowVersions = lb08.table('workflow_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workflowId: uuid('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  origin: text('origin').notNull(),
  // What the visitor wrote, when a model turned it into this graph.
  description: text('description'),
  graph: jsonb('graph').$type<WorkflowGraph>().notNull(),
  // Gateway calls it took: one or two for a generated version, none otherwise.
  modelCalls: integer('model_calls').notNull().default(0),
  // The id the gateway and the tracer know that generation by, so the Scope can open its trace.
  traceRunId: text('trace_run_id'),
  createdAt: now('created_at'),
}, table => [
  uniqueIndex('workflow_versions_number_idx').on(table.workflowId, table.version),
  check('workflow_versions_origin_check', sql`${table.origin} in ('generated', 'sample', 'edited')`),
])

/** One run of a workflow version, with the payload it was started with. */
export const runs = lb08.table('runs', {
  id: uuid('id').primaryKey(),
  workflowId: uuid('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  sessionKey: text('session_key').notNull(),
  // The first run of a chain of replays: its own id for an original run. Side effects are
  // keyed by it, so a replay recognises what its originals already sent.
  rootRunId: uuid('root_run_id').notNull(),
  replayOf: uuid('replay_of'),
  status: text('status').notNull().default('queued'),
  input: jsonb('input').$type<Values>().notNull(),
  // The last sequence number given to an event of this run's log.
  eventSeq: integer('event_seq').notNull().default(0),
  createdAt: now('created_at'),
  startedAt: moment('started_at'),
  finishedAt: moment('finished_at'),
}, table => [
  index('runs_session_idx').on(table.sessionKey, table.createdAt),
  index('runs_workflow_idx').on(table.workflowId),
  index('runs_root_idx').on(table.rootRunId),
  check('runs_status_check', sql`${table.status} in ('queued', 'running', 'awaiting_approval', 'succeeded', 'failed')`),
])

/** One step of a run: its state, attempts and output. */
export const runSteps = lb08.table('run_steps', {
  runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  nodeId: text('node_id').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  output: jsonb('output').$type<Values>(),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  startedAt: moment('started_at'),
  finishedAt: moment('finished_at'),
  updatedAt: now('updated_at'),
}, table => [
  primaryKey({ columns: [table.runId, table.nodeId] }),
  index('run_steps_status_idx').on(table.status, table.updatedAt),
  check('run_steps_status_check', sql`${table.status} in ('pending', 'ready', 'queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'skipped')`),
])

/** The log of a run: every state change, in order. It is what the run page streams and what a replay plays back. */
export const runEvents = lb08.table('run_events', {
  runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  at: now('at'),
  type: text('type').notNull(),
  nodeId: text('node_id'),
  // The event's own fields: everything but its sequence number, time, run and type.
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
}, table => [primaryKey({ columns: [table.runId, table.seq] })])

/**
 * The transactional outbox: the intent to send, recorded before anything is sent. One row
 * per idempotency key, so a retry or a replay finds the work already recorded, and a
 * delivered row says it was done.
 */
export const outbox = lb08.table('outbox', {
  idempotencyKey: text('idempotency_key').primaryKey(),
  workflowId: uuid('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  rootRunId: uuid('root_run_id').notNull(),
  // The run that recorded the intent first.
  firstRunId: uuid('first_run_id').notNull(),
  nodeId: text('node_id').notNull(),
  connector: text('connector').notNull(),
  // What is to be sent, rendered once: a retry sends exactly this.
  payload: jsonb('payload').$type<Values>().notNull(),
  // A hash of the connector and payload, so a key reused for different content is caught.
  payloadHash: text('payload_hash').notNull(),
  status: text('status').notNull().default('pending'),
  messageId: text('message_id'),
  createdAt: now('created_at'),
  deliveredAt: moment('delivered_at'),
}, table => [check('outbox_status_check', sql`${table.status} in ('pending', 'delivered')`)])

/**
 * What the sandboxed connectors "sent": the receiving side of every side effect. The
 * unique key is the idempotency key, so a second delivery with the same key records
 * nothing and answers with the first.
 */
export const sandboxDeliveries = lb08.table('sandbox_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  workflowId: uuid('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  sessionKey: text('session_key').notNull(),
  rootRunId: uuid('root_run_id').notNull(),
  nodeId: text('node_id').notNull(),
  connector: text('connector').notNull(),
  payload: jsonb('payload').$type<Values>().notNull(),
  createdAt: now('created_at'),
}, table => [index('sandbox_deliveries_session_idx').on(table.sessionKey, table.createdAt)])

/** A step that used all its attempts, waiting for a replay. This is the dead-letter queue the visitor sees. */
export const deadLetters = lb08.table('dead_letters', {
  id: uuid('id').primaryKey().defaultRandom(),
  workflowId: uuid('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  sessionKey: text('session_key').notNull(),
  nodeId: text('node_id').notNull(),
  attempts: integer('attempts').notNull(),
  errorCode: text('error_code').notNull(),
  errorMessage: text('error_message').notNull(),
  createdAt: now('created_at'),
  // The run that replayed it, once someone has.
  replayedRunId: uuid('replayed_run_id'),
}, table => [index('dead_letters_session_idx').on(table.sessionKey, table.createdAt)])

/**
 * Failures a visitor asked for, for the make-it-fail demo: how many more times a step's
 * connector fails before it works. Keyed by the root run, so a replay inherits what is left.
 */
export const faults = lb08.table('faults', {
  rootRunId: uuid('root_run_id').notNull(),
  nodeId: text('node_id').notNull(),
  workflowId: uuid('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  remaining: integer('remaining').notNull(),
}, table => [primaryKey({ columns: [table.rootRunId, table.nodeId] })])

/** How much of a daily allowance each visitor has used. A counter outlives the workflows it counted, so deleting one frees nothing. */
export const usageCounters = lb08.table('usage_counters', {
  sessionKey: text('session_key').notNull(),
  day: date('day', { mode: 'string' }).notNull(),
  kind: text('kind').notNull(),
  used: integer('used').notNull(),
}, table => [
  primaryKey({ columns: [table.sessionKey, table.day, table.kind] }),
  check('usage_counters_kind_check', sql`${table.kind} in ('run', 'generation')`),
])

/** The synthetic stock list the stock-check connector reads (data/seed/lb08/stock.yaml). */
export const stockLevels = lb08.table('stock_levels', {
  sku: text('sku').primaryKey(),
  name: text('name').notNull(),
  availableKg: numeric('available_kg', { precision: 10, scale: 2, mode: 'number' }).notNull(),
  restockEtaDays: integer('restock_eta_days').notNull(),
})

/** Every table of the schema, for typed queries. */
export const tables = { workflows, workflowVersions, runs, runSteps, runEvents, outbox, sandboxDeliveries, deadLetters, faults, usageCounters, stockLevels }
