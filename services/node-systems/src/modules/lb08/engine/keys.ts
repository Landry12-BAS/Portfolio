// Idempotency keys: what lets a retry or a replay recognise a side effect that was already
// sent. A key names one step of one chain of replays, so every attempt of that step, in the
// original run or any replay of it, sends the same thing under the same key.
import { createHash } from 'node:crypto'

import type { Values } from '@lb/contracts'

/** Returns the key of a step's side effect: its chain's root run and the step's id. */
export function idempotencyKey(rootRunId: string, nodeId: string): string {
  return `${rootRunId}:${nodeId}`
}

/**
 * Hashes what a side effect sends, in a stable order, so a key reused for different content is
 * caught instead of quietly answering with the first send.
 */
export function payloadHash(connector: string, payload: Values): string {
  const entries = Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256').update(JSON.stringify([connector, entries])).digest('hex')
}
