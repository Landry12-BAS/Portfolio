// The transactional outbox: the intent to send, recorded before anything is sent.
//
// A side effect is a thing that can't be undone, so the engine writes down what it means
// to send, under the step's idempotency key, before it sends it. The outbox has one row per
// key, holding the content as it was rendered the first time. After a crash, a retry finds
// the row and sends that content again under the same key; the receiver recognises the key
// and does nothing twice. A replay of the whole run does the same, because a replay shares
// its original's keys.
//
// A key reused for different content is not quietly answered with the first send: the
// content's hash is kept, and a mismatch fails the step.
import type { ConnectorId, Values } from '@lb/contracts'
import { and, eq } from 'drizzle-orm'

import type { Executor } from '../db/connection.ts'
import { outbox } from '../db/schema.ts'
import { PermanentStepError } from './errors.ts'
import { payloadHash } from './keys.ts'

/** What a step means to send, and who it belongs to. */
export interface Intent {
  key: string
  workflowId: string
  // The run that is recording the intent, and the first run of its chain of replays.
  runId: string
  rootRunId: string
  nodeId: string
  connector: ConnectorId
  payload: Values
}

/** An intent as the outbox holds it: the content to send, and whether it was acknowledged. */
export interface StoredIntent {
  payload: Values
  delivered: boolean
  messageId: string | null
  // The run that recorded the intent first, which is where a duplicate comes from.
  firstRunId: string
}

/**
 * Records an intent, or finds the one already recorded under its key. Either way it
 * returns what is stored, and the caller sends that. Fails the step for good when the key
 * was recorded with different content.
 */
export async function recordIntent(db: Executor, intent: Intent): Promise<StoredIntent> {
  const fingerprint = payloadHash(intent.connector, intent.payload)
  const inserted = await db.insert(outbox).values({
    idempotencyKey: intent.key,
    workflowId: intent.workflowId,
    rootRunId: intent.rootRunId,
    firstRunId: intent.runId,
    nodeId: intent.nodeId,
    connector: intent.connector,
    payload: intent.payload,
    payloadHash: fingerprint,
  }).onConflictDoNothing().returning()
  const row = inserted[0] ?? (await db.select().from(outbox).where(eq(outbox.idempotencyKey, intent.key)).limit(1))[0]
  if (!row) throw new PermanentStepError('workflow_gone', 'The workflow was removed while this step ran.')
  if (row.payloadHash !== fingerprint) throw new PermanentStepError('idempotency_conflict', 'This step\'s key was already used for different content.')
  return { payload: row.payload, delivered: row.status === 'delivered', messageId: row.messageId, firstRunId: row.firstRunId }
}

/** Marks an intent delivered, with the id the receiver gave it. Marking one that is already delivered changes nothing. */
export async function acknowledge(db: Executor, key: string, messageId: string, moment: Date): Promise<void> {
  await db.update(outbox)
    .set({ status: 'delivered', messageId, deliveredAt: moment })
    .where(and(eq(outbox.idempotencyKey, key), eq(outbox.status, 'pending')))
}
