// The sandboxed connectors: what an action step actually does.
//
// None of these reaches the network, and none of them can. A connector is a function in
// this file that reads or writes a table in LB-08's own schema: the stock check reads the
// synthetic stock list, and every other connector "sends" by inserting a row into the
// deliveries table, which the visitor can read back to see what went out. There is no HTTP
// client here, no socket, no process, and an endpoint or a mailbox is a name from a closed
// list, never an address that could be dialled.
//
// The deliveries table is the receiving side of every side effect. Its idempotency key is
// unique, so delivering the same key twice records one row and answers the second time
// with the first one's id. That is what makes a retry, a replay or a worker that died
// after sending safe: exactly one thing goes out.
//
// A visitor can ask a step's connector to fail a few times (the make-it-fail demo), which
// is how the retries, the dead-letter queue and the replay are watched.
import type { ConnectorId, Values } from '@lb/contracts'
import { and, eq, gt, sql } from 'drizzle-orm'

import type { Executor } from '../db/connection.ts'
import { faults, sandboxDeliveries, stockLevels } from '../db/schema.ts'
import type { ConnectorCall } from './context.ts'
import { ConnectorUnavailableError, PermanentStepError } from './errors.ts'
import { idempotencyKey } from './keys.ts'
import { recordIntent } from './outbox.ts'

// Days from an order to its arrival when the product is on the shelf. A product out of
// stock waits for its restock first.
const DISPATCH_DAYS = 2

/** Who is calling: the step, its run and the visitor it belongs to. */
export interface StepIdentity {
  workflowId: string
  sessionKey: string
  runId: string
  // The first run of the chain of replays this run belongs to. Side effects are keyed by it.
  rootRunId: string
  nodeId: string
}

/** What a connector call did, besides producing output. */
export interface Delivery {
  // The key the side effect was sent under.
  key: string
  messageId: string
  // Set when the key had been delivered before: the run that sent it first.
  duplicateOf: string | null
}

/** What a connector call came to: the values later steps may read, and the delivery if something was sent. */
export interface ConnectorResult {
  output: Values
  delivery: Delivery | null
}

/** Points in a step where a test may stop the worker, as if the process had died there. */
export interface Hooks {
  // Called after a side effect has been delivered and before the step is acknowledged.
  afterEffect?: (point: { runId: string, nodeId: string }) => Promise<void> | void
}

/** Makes the id the sandbox gives a delivery: `msg-` and the start of the row's id, or `task-` for a task. */
function messageIdOf(connector: ConnectorId, deliveryId: string): string {
  return `${connector === 'create_task' ? 'task' : 'msg'}-${deliveryId.slice(0, 8)}`
}

/**
 * Fails the call if the visitor asked for this step's connector to fail, using up one of
 * the failures they asked for. Each failure is taken by one atomic statement, so two
 * attempts at once can't both use the same one.
 */
async function failIfAsked(db: Executor, who: StepIdentity): Promise<void> {
  const taken = await db.update(faults)
    .set({ remaining: sql`${faults.remaining} - 1` })
    .where(and(eq(faults.rootRunId, who.rootRunId), eq(faults.nodeId, who.nodeId), gt(faults.remaining, 0)))
    .returning({ remaining: faults.remaining })
  if (taken.length > 0) throw new ConnectorUnavailableError()
}

/** Looks a product up in the stock list and works out whether the stock covers the quantity, and when it could arrive. */
async function checkStock(db: Executor, payload: Values): Promise<Values> {
  const [product] = await db.select().from(stockLevels).where(eq(stockLevels.sku, String(payload.sku))).limit(1)
  if (!product) throw new PermanentStepError('unknown_product', 'That product isn\'t in the stock list.')
  const wanted = typeof payload.quantityKg === 'number' ? payload.quantityKg : undefined
  const inStock = wanted === undefined ? product.availableKg > 0 : product.availableKg >= wanted
  return {
    inStock,
    availableKg: product.availableKg,
    etaDays: inStock ? DISPATCH_DAYS : product.restockEtaDays + DISPATCH_DAYS,
    productName: product.name,
  }
}

/**
 * Records a delivery under its key, or finds the one already recorded. Returns the id the
 * sandbox gives it, and whether the key was new. The content is the outbox's stored
 * content, so a retry sends exactly what the first attempt would have.
 */
async function deliver(db: Executor, who: StepIdentity, connector: ConnectorId, key: string, payload: Values): Promise<{ messageId: string, created: boolean }> {
  const inserted = await db.insert(sandboxDeliveries).values({
    idempotencyKey: key,
    workflowId: who.workflowId,
    sessionKey: who.sessionKey,
    rootRunId: who.rootRunId,
    nodeId: who.nodeId,
    connector,
    payload,
  }).onConflictDoNothing().returning({ id: sandboxDeliveries.id })
  const row = inserted[0] ?? (await db.select({ id: sandboxDeliveries.id }).from(sandboxDeliveries).where(eq(sandboxDeliveries.idempotencyKey, key)).limit(1))[0]
  if (!row) throw new PermanentStepError('workflow_gone', 'The workflow was removed while this step ran.')
  return { messageId: messageIdOf(connector, row.id), created: inserted.length > 0 }
}

/** Names what a write connector hands the next steps: a task's id, or the message's id. */
function outputOf(connector: ConnectorId, messageId: string): Values {
  return connector === 'create_task' ? { taskId: messageId } : { messageId }
}

/** Sends through the outbox: record the intent, check the connector is up, deliver under the key, and let a test stop here. */
async function send(db: Executor, hooks: Hooks, who: StepIdentity, call: ConnectorCall): Promise<ConnectorResult> {
  const key = idempotencyKey(who.rootRunId, who.nodeId)
  const intent = await recordIntent(db, { key, workflowId: who.workflowId, runId: who.runId, rootRunId: who.rootRunId, nodeId: who.nodeId, connector: call.connector, payload: call.payload })
  await failIfAsked(db, who)
  const delivery = await deliver(db, who, call.connector, key, intent.payload)
  await hooks.afterEffect?.({ runId: who.runId, nodeId: who.nodeId })
  return {
    output: outputOf(call.connector, delivery.messageId),
    delivery: { key, messageId: delivery.messageId, duplicateOf: delivery.created ? null : intent.firstRunId },
  }
}

/**
 * Runs one connector call. A read connector answers from the tables; a write connector goes
 * through the outbox and the deliveries table. Either may be made to fail by the visitor,
 * and a failure of that kind can always be retried.
 */
export async function callConnector(db: Executor, hooks: Hooks, who: StepIdentity, call: ConnectorCall): Promise<ConnectorResult> {
  if (call.connector === 'stock_check') {
    await failIfAsked(db, who)
    return { output: await checkStock(db, call.payload), delivery: null }
  }
  return send(db, hooks, who, call)
}
