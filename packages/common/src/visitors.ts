// Who is asking: the anonymous visitor behind a request, as the site vouches for them.
//
// Visitors have no accounts. The site's server (Nuxt's Nitro routes) keeps each visitor's
// anonymous session and mints a short-lived token for one system at a time
// (docs/SECURITY.md, section 2): an Ed25519-signed JWT whose subject is a keyed hash of
// the session, never the session cookie itself. Every system checks that token on every
// request, and knows the visitor only by that subject.
//
// The token, as the site must mint it:
//
//   header   {"alg": "EdDSA", "typ": "JWT"}
//   claims   {"iss": "lb-web", "aud": "<system, such as lb-08>", "sub": "<session hash>",
//             "iat": <issued, Unix seconds>, "exp": <at most 300 seconds later>}
//
// This is the twin of python/lb-common's lb_common.visitors, with the same rules, built on
// node:crypto alone. Without the site's public key (LB_WEB_TOKEN_KEY), no token verifies,
// so a system fails closed rather than serve anyone unchecked.
import { createPublicKey, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/** Who mints visitor tokens: the site's server. */
export const VISITOR_ISSUER = 'lb-web'
/** The longest a token may live, as docs/SECURITY.md sets it, in seconds. */
export const MAX_LIFETIME_SECONDS = 300
// How much clock drift between the site and a system is forgiven, in seconds.
const LEEWAY_SECONDS = 30
// A session hash: the format the gateway accepts for session keys.
const SESSION_KEY = /^[\w-]{16,128}$/
// A compact JWT is three base64url segments.
const SEGMENT = /^[\w-]+$/
// No honest token comes near this; refusing larger input early keeps a flood of junk cheap.
const MAX_TOKEN_LENGTH = 2_048

/** The request's visitor token is missing, malformed, expired, or not for this system. The message names the reason, never the token. */
export class VisitorTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VisitorTokenError'
  }
}

/** An anonymous visitor, known by the hash of their session, calling one system. */
export interface Visitor {
  readonly sessionKey: string
  readonly system: string
}

/** Reads the site's Ed25519 public key from its base64url form (a JWK's `x`). */
export function loadPublicKey(encoded: string): KeyObject {
  if (!/^[\w-]+$/.test(encoded)) throw new RangeError('LB_WEB_TOKEN_KEY isn\'t base64url.')
  const raw = Buffer.from(encoded, 'base64url')
  if (raw.length !== 32) throw new RangeError('LB_WEB_TOKEN_KEY isn\'t an Ed25519 public key: it must be 32 bytes.')
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: encoded }, format: 'jwk' })
}

/** Decodes one base64url segment of a token as a JSON object, or fails as a malformed token. */
function decodeObject(segment: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  }
  catch {
    // Falls through to the error below, which doesn't repeat what was wrong.
  }
  throw new VisitorTokenError('The token is malformed.')
}

/** Tells whether a claim is a whole number of seconds. */
function isSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/** Checks that a token's header asks for the one algorithm accepted, and nothing the verifier doesn't understand. */
function checkHeader(header: Record<string, unknown>): void {
  // Only Ed25519 signatures: no `none`, and no shared-secret HMAC the site's public key could be misused as.
  if (header.alg !== 'EdDSA') throw new VisitorTokenError('The token isn\'t signed with EdDSA.')
  // A `crit` header lists extensions the verifier must understand, and this one understands none.
  if ('crit' in header) throw new VisitorTokenError('The token uses extensions this service doesn\'t understand.')
}

/** Checks that the audience claim names this system, as a string or in a list. */
function audienceIncludes(audience: unknown, system: string): boolean {
  return audience === system || (Array.isArray(audience) && audience.includes(system))
}

/** Checks a token's claims against the rules above, at a moment given in Unix seconds, and returns the session it vouches for. */
function checkClaims(claims: Record<string, unknown>, system: string, nowSeconds: number): string {
  for (const name of ['iss', 'aud', 'sub', 'iat', 'exp']) {
    if (!(name in claims)) throw new VisitorTokenError(`The token has no ${name} claim.`)
  }
  if (claims.iss !== VISITOR_ISSUER) throw new VisitorTokenError('The token wasn\'t issued by the site.')
  if (!audienceIncludes(claims.aud, system)) throw new VisitorTokenError('The token isn\'t for this system.')
  const { iat, exp, nbf, sub } = claims
  if (!isSeconds(iat) || !isSeconds(exp)) throw new VisitorTokenError('The token\'s times aren\'t whole seconds.')
  if (exp - iat > MAX_LIFETIME_SECONDS) throw new VisitorTokenError('The token may live at most 300 seconds.')
  if (exp <= iat) throw new VisitorTokenError('The token expires before it was issued.')
  if (exp <= nowSeconds - LEEWAY_SECONDS) throw new VisitorTokenError('The token has expired.')
  if (iat > nowSeconds + LEEWAY_SECONDS) throw new VisitorTokenError('The token was issued in the future.')
  if (nbf !== undefined && (!isSeconds(nbf) || nbf > nowSeconds + LEEWAY_SECONDS)) throw new VisitorTokenError('The token isn\'t valid yet.')
  if (typeof sub !== 'string' || !SESSION_KEY.test(sub)) throw new VisitorTokenError('The token\'s subject isn\'t a session hash.')
  return sub
}

/**
 * Checks a visitor token for `system`, and returns the visitor it vouches for. `now`
 * returns Unix time in seconds. Any problem throws a VisitorTokenError, which a system
 * answers with 401.
 */
export function verifyVisitorToken(token: string, system: string, publicKey: KeyObject, now: () => number = () => Date.now() / 1000): Visitor {
  if (token.length > MAX_TOKEN_LENGTH) throw new VisitorTokenError('The token is malformed.')
  const segments = token.split('.')
  const [headerPart, claimsPart, signaturePart] = segments
  if (segments.length !== 3 || !headerPart || !claimsPart || !signaturePart || !segments.every(segment => SEGMENT.test(segment))) {
    throw new VisitorTokenError('The token is malformed.')
  }
  checkHeader(decodeObject(headerPart))
  let signatureValid: boolean
  try {
    signatureValid = verify(null, Buffer.from(`${headerPart}.${claimsPart}`), publicKey, Buffer.from(signaturePart, 'base64url'))
  }
  catch {
    signatureValid = false
  }
  if (!signatureValid) throw new VisitorTokenError('The token\'s signature is wrong.')
  return { sessionKey: checkClaims(decodeObject(claimsPart), system, now()), system }
}

/**
 * Checks an `Authorization: Bearer <token>` header for `system`, failing closed.
 * `encodedKey` is the site's public key as configured (LB_WEB_TOKEN_KEY); without one,
 * nobody is let in.
 */
export function visitorFromHeader(authorization: string | undefined, system: string, encodedKey: string | undefined, now: () => number = () => Date.now() / 1000): Visitor {
  return createVisitorVerifier(system, encodedKey, now)(authorization)
}

/** Checks the `Authorization` header of a request and returns the visitor it vouches for, or throws a VisitorTokenError. */
export type VisitorVerifier = (authorization: string | undefined) => Visitor

/**
 * Builds the check a service runs on every request for `system`. The site's public key
 * is read once, here, so a misconfigured key stops the service at startup; without a
 * key the verifier refuses everyone, which is how a service fails closed.
 */
export function createVisitorVerifier(system: string, encodedKey: string | undefined, now: () => number = () => Date.now() / 1000): VisitorVerifier {
  const publicKey = encodedKey ? loadPublicKey(encodedKey) : undefined
  return (authorization) => {
    if (!publicKey) throw new VisitorTokenError('LB_WEB_TOKEN_KEY isn\'t set, so no visitor can be checked.')
    const match = /^bearer +(\S+)$/i.exec((authorization ?? '').trim())
    const token = match?.[1]
    if (!token) throw new VisitorTokenError('The request has no bearer token.')
    return verifyVisitorToken(token, system, publicKey, now)
  }
}
