// The bug token: how the bugs a visitor switched on travel to the staging shop without passing
// through anything the model can read or change. The service signs `{runId, bugs, exp}` with a key
// the shop shares with it (HMAC-SHA256), the runner puts the token in the browser context's cookie
// jar before the first page opens, and the shop verifies the signature on every request. A token
// that is missing, altered, expired or badly formed means a clean shop: the shop never trusts a
// bug list it did not sign. The model's plan has no action that reads, sets or carries a cookie,
// and the shop paths it may open carry no query string, so the agent cannot flip a bug.
import { createHmac, timingSafeEqual } from 'node:crypto'

import { LB07_BUG_IDS } from '@lb/contracts'
import type { Lb07BugId } from '@lb/contracts'
import { z } from 'zod'

/** The cookie the token travels in. */
export const BUG_COOKIE = 'lb07_bugs'
/** How long a token is good for: a run's three minutes, the verification passes, and slack for queueing. */
export const TOKEN_LIFETIME_MS = 15 * 60_000
// A key is at least 32 bytes; a shorter one is refused at startup.
const MIN_KEY_BYTES = 32

/** What the token says. */
export interface BugTokenClaims {
  runId: string
  bugs: Lb07BugId[]
  // Unix milliseconds after which the token is refused.
  exp: number
}

const claimsSchema = z.strictObject({
  v: z.literal(1),
  runId: z.string().regex(/^[\w-]{8,64}$/),
  bugs: z.array(z.enum(LB07_BUG_IDS)).max(LB07_BUG_IDS.length),
  exp: z.int().positive(),
})

/** Checks a signing key: raw bytes, at least 32 of them. */
export function checkTokenKey(key: Uint8Array): Uint8Array {
  if (key.byteLength < MIN_KEY_BYTES) throw new RangeError(`The bug-token key must have at least ${MIN_KEY_BYTES} bytes.`)
  return key
}

/** Reads a key from its hex form, as the environment carries it. */
export function tokenKeyFromHex(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64,256}$/i.test(hex)) throw new RangeError('The bug-token key must be 64 to 256 hex digits.')
  return checkTokenKey(Buffer.from(hex, 'hex'))
}

/** Signs a payload's base64url text. */
function signature(key: Uint8Array, payload: string): Buffer {
  return createHmac('sha256', key).update(payload).digest()
}

/** Makes a signed bug token for one run. */
export function signBugToken(key: Uint8Array, claims: BugTokenClaims): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, runId: claims.runId, bugs: [...claims.bugs].sort(), exp: claims.exp })).toString('base64url')
  return `${payload}.${signature(key, payload).toString('base64url')}`
}

/**
 * Reads a bug token and returns its claims, or undefined for anything that is not a token this key
 * signed and that is still good: a bad shape, a wrong signature, an expired token, an unknown bug.
 * Every failure gives the same answer, since the only thing the shop does with it is stay clean.
 */
export function verifyBugToken(key: Uint8Array, token: string | undefined, now: Date): BugTokenClaims | undefined {
  if (token === undefined || token.length > 1_024) return undefined
  const parts = token.split('.')
  if (parts.length !== 2) return undefined
  const [payload, given] = parts as [string, string]
  if (!/^[\w-]+$/.test(payload) || !/^[\w-]{43}$/.test(given)) return undefined
  const expected = signature(key, payload)
  const givenBytes = Buffer.from(given, 'base64url')
  if (givenBytes.length !== expected.length || !timingSafeEqual(givenBytes, expected)) return undefined
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  }
  catch {
    return undefined
  }
  const claims = claimsSchema.safeParse(decoded)
  if (!claims.success) return undefined
  if (claims.data.exp <= now.getTime()) return undefined
  return { runId: claims.data.runId, bugs: claims.data.bugs, exp: claims.data.exp }
}
