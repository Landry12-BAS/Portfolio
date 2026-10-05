// The key the worker shows the runner's API with every call, so that nothing else that can reach the API (above
// all a page of the browser the runner drives, should both network layers ever fail) can open a session, drive a
// step or close one. It is derived (HKDF-SHA-256, with a label of its own) from the bug-token key the service and
// the sandbox already share, so it needs no setting of its own and is never the token key itself: a party that
// learns it can drive the runner and cannot sign a bug token, and the other way round.
import { hkdfSync, timingSafeEqual } from 'node:crypto'

/** The header the key travels in. */
export const RUNNER_KEY_HEADER = 'x-lb07-runner-key'

// What the derivation is for, so the same root key never gives the same bytes for two purposes.
const SALT = 'lb07'
const INFO = 'runner api v1'

/** Derives the runner's key from the bug-token key, as 64 hex digits. */
export function runnerKeyFrom(tokenKey: Uint8Array): string {
  return Buffer.from(hkdfSync('sha256', tokenKey, SALT, INFO, 32)).toString('hex')
}

/** Tells whether a request's header carries the key, in time that does not depend on how much of it matched. */
export function keyMatches(expected: string, given: string | string[] | undefined): boolean {
  if (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given)) return false
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))
}
