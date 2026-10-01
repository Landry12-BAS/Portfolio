// The events of a workflow run: what the engine records, step by step, and what the run
// page streams. Every state change of a run is one event with a sequence number, so the
// log is the whole story of the run: it can be shown live, read afterwards, and played
// back step by step. Events carry ids, counts and short fixed messages, never a
// visitor's text.
import { z } from 'zod'

import { APPROVERS, connectorIds } from '../workflow/catalogue.ts'

const nodeId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)

/** A flat set of named values, such as a step's output or a run's payload. */
export const valuesSchema = z.record(z.string().max(40), z.union([z.string().max(600), z.number(), z.boolean()]))
/** A flat set of named values. */
export type Values = z.infer<typeof valuesSchema>

// What every event has: where it sits in the run's log, when it happened and whose it is.
const base = {
  seq: z.int().min(1),
  at: z.iso.datetime(),
  runId: z.uuid(),
}

const connector = z.enum(connectorIds)
const messageId = z.string().max(80)

/** Every event a run can record. */
export const runEventSchema = z.discriminatedUnion('type', [
  // The run as a whole.
  z.strictObject({ ...base, type: z.literal('run.queued'), version: z.int().min(1), replayOf: z.uuid().nullable() }),
  z.strictObject({ ...base, type: z.literal('run.started') }),
  z.strictObject({ ...base, type: z.literal('run.awaiting_approval'), nodeId }),
  z.strictObject({ ...base, type: z.literal('run.succeeded') }),
  z.strictObject({ ...base, type: z.literal('run.failed'), nodeId }),
  // One step, from its first attempt to its end.
  z.strictObject({ ...base, type: z.literal('step.started'), nodeId, attempt: z.int().min(1) }),
  z.strictObject({ ...base, type: z.literal('step.succeeded'), nodeId, attempt: z.int().min(0), output: valuesSchema }),
  z.strictObject({
    ...base,
    type: z.literal('step.failed'),
    nodeId,
    attempt: z.int().min(1),
    maxAttempts: z.int().min(1),
    code: z.string().max(40),
    message: z.string().max(200),
    // How long until the next attempt, or null when this was the last.
    retryInMs: z.int().min(0).nullable(),
  }),
  z.strictObject({ ...base, type: z.literal('step.dead_lettered'), nodeId, attempts: z.int().min(1) }),
  z.strictObject({ ...base, type: z.literal('step.skipped'), nodeId, reason: z.enum(['branch_not_taken', 'upstream_skipped']) }),
  z.strictObject({ ...base, type: z.literal('step.awaiting_approval'), nodeId, approver: z.enum(APPROVERS) }),
  z.strictObject({ ...base, type: z.literal('step.decided'), nodeId, decision: z.enum(['approved', 'rejected']) }),
  // A connector's side effect: sent once, or recognised by its idempotency key and not repeated.
  z.strictObject({ ...base, type: z.literal('effect.sent'), nodeId, connector, messageId }),
  z.strictObject({ ...base, type: z.literal('effect.duplicate_suppressed'), nodeId, connector, messageId, originalRunId: z.uuid() }),
])

/** One event of a run's log. */
export type RunEvent = z.infer<typeof runEventSchema>
/** The kind of an event, such as `step.failed`. */
export type RunEventType = RunEvent['type']

/** Omits keys from every member of a union, so each event keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** An event as the engine records it, before the log gives it a sequence number, a time and its run. */
export type NewRunEvent = DistributiveOmit<RunEvent, 'seq' | 'at' | 'runId'>
