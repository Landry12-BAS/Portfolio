// Service tokens: the short-lived JWTs a service signs to call the AI gateway.
//
// Each service holds its own Ed25519 private key, and the gateway holds only the public
// halves (docs/SECURITY.md, section 5). A token names the service as both its key ID and
// its issuer, names the gateway as its audience, and lives for minutes: a leaked token
// expires quickly, and a leaked gateway config can't mint new ones. The gateway's side
// of this contract is services/gateway/src/auth/service-token.ts, and the Python twin of
// this module is lb_common.tokens.
import { createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

/** The audience every token names; the gateway refuses a token meant for anything else. */
export const GATEWAY_AUDIENCE = 'lb-gateway'
/** The gateway refuses a token older than this, whatever its expiry says. */
export const MAX_TOKEN_AGE_SECONDS = 600
/** How long a new token lives. */
export const DEFAULT_TTL_SECONDS = 300
/** A token is replaced this long before it expires, so no request leaves with one about to lapse on the way. */
export const REFRESH_MARGIN_SECONDS = 60

// A service name such as `node-systems`: the rule the gateway applies too.
const SERVICE_NAME = /^[a-z][a-z0-9-]{1,39}$/

/** A service's private key is missing, malformed, or open to other users. */
export class ServiceKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServiceKeyError'
  }
}

/** Returns the service name if it is valid, so a typo fails here and not at the gateway. */
export function checkServiceName(service: string): string {
  if (!SERVICE_NAME.test(service)) throw new RangeError(`${JSON.stringify(service)} is not a service name: use lowercase letters, digits and hyphens.`)
  return service
}

/** Returns the base64url public half of a key: the service's entry in the gateway's LB_SERVICE_KEYS. */
export function publicKeyOf(key: KeyObject): string {
  const x = createPublicKey(key).export({ format: 'jwk' }).x
  if (x === undefined) throw new ServiceKeyError('The key has no public part.')
  return x
}

/**
 * Builds an Ed25519 private key from its JWK form, checking that its two halves match.
 * The JWK is what `just gateway-token keygen` writes: key type OKP, curve Ed25519, the
 * private part `d` and the public part `x`, both in base64url.
 */
export function privateKeyFromJwk(jwk: unknown): KeyObject {
  const parts = (typeof jwk === 'object' && jwk !== null ? jwk : {}) as Record<string, unknown>
  if (parts.kty !== 'OKP' || parts.crv !== 'Ed25519' || typeof parts.d !== 'string' || typeof parts.x !== 'string') {
    throw new ServiceKeyError('The key is not an Ed25519 private key in JWK form.')
  }
  let key: KeyObject
  try {
    key = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: parts.d, x: parts.x }, format: 'jwk' })
  }
  catch {
    throw new ServiceKeyError('The key\'s private part is not a valid Ed25519 key.')
  }
  // The gateway knows the service by the public half. A mismatch would only show up
  // later, as refused calls, so it is caught here instead.
  if (parts.x !== publicKeyOf(key)) throw new ServiceKeyError('The key\'s public part doesn\'t match its private part.')
  return key
}

/**
 * Reads a service's private key from its JWK file. Refuses a file that other users could
 * read or change, the way ssh refuses a private key with loose permissions: the key is the
 * service's whole identity at the gateway. Error messages name the file, never its contents.
 */
export function loadServiceKey(path: string): KeyObject {
  let mode: number
  try {
    mode = statSync(path).mode
  }
  catch {
    throw new ServiceKeyError(`There is no service key at ${path}.`)
  }
  if ((mode & 0o077) !== 0) throw new ServiceKeyError(`${path} is open to other users. Restrict it with: chmod 600 ${path}`)
  let jwk: unknown
  try {
    jwk = JSON.parse(readFileSync(path, 'utf8')) as unknown
  }
  catch {
    throw new ServiceKeyError(`${path} is not a readable JSON key file.`)
  }
  return privateKeyFromJwk(jwk)
}

/**
 * Signs a service token the way the gateway requires: EdDSA, the service's name as key ID
 * and issuer, the gateway as audience, a unique token ID, and a lifetime of `ttlSeconds`
 * from `nowSeconds` (Unix time in seconds).
 */
export function mintServiceToken(service: string, key: KeyObject, nowSeconds: number, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  checkServiceName(service)
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TOKEN_AGE_SECONDS) {
    throw new RangeError(`A token lives from 1 to ${MAX_TOKEN_AGE_SECONDS} seconds, not ${ttlSeconds}.`)
  }
  const issuedAt = Math.floor(nowSeconds)
  const header = { alg: 'EdDSA', kid: service, typ: 'JWT' }
  const claims = { iss: service, aud: GATEWAY_AUDIENCE, iat: issuedAt, exp: issuedAt + ttlSeconds, jti: randomUUID() }
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`
  const signature = sign(null, Buffer.from(signingInput), key).toString('base64url')
  return `${signingInput}.${signature}`
}

/** Hands out tokens for one service, minting a new one only when the current one nears expiry. */
export class ServiceTokens {
  readonly service: string
  readonly #key: KeyObject
  readonly #clock: () => number
  readonly #ttlSeconds: number
  #token: string | undefined
  #expiresAt = 0

  /** Prepares to sign as `service` with `key`. `clock` returns Unix time in seconds. */
  constructor(service: string, key: KeyObject, clock: () => number = () => Date.now() / 1000, ttlSeconds = DEFAULT_TTL_SECONDS) {
    if (!(ttlSeconds > REFRESH_MARGIN_SECONDS && ttlSeconds <= MAX_TOKEN_AGE_SECONDS)) {
      throw new RangeError(`Tokens must live longer than ${REFRESH_MARGIN_SECONDS} seconds and at most ${MAX_TOKEN_AGE_SECONDS}.`)
    }
    this.service = checkServiceName(service)
    this.#key = key
    this.#clock = clock
    this.#ttlSeconds = ttlSeconds
  }

  /** Returns a token with at least a minute left, minting a fresh one when needed. */
  current(): string {
    const now = this.#clock()
    if (this.#token === undefined || now >= this.#expiresAt - REFRESH_MARGIN_SECONDS) {
      this.#token = mintServiceToken(this.service, this.#key, now, this.#ttlSeconds)
      this.#expiresAt = Math.floor(now) + this.#ttlSeconds
    }
    return this.#token
  }
}
