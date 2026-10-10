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
//
// The file holds both ends of the token: the signer the site's server uses
// (`mintVisitorToken`, with the site's private key) and the check every system runs
// (`verifyVisitorToken`, with its public key). They sit side by side so one format has one
// home, and a contract test (python/lb-common/tests/integration/test_visitor_contract.py)
// proves that tokens signed here are the ones Python's verifier accepts.
//
// Both checks are strict in the same way on purpose. A lenient parser would let a token that
// only the site's key could sign be read one way here and another way in Python, and the two
// would disagree about who is asking. So the text of a token has one spelling (no padding, no
// stray bits, no byte order mark), its JSON holds only plain values, and a time is a whole number
// of seconds. One corpus of signed tokens, with the verdict each must get
// (test/fixtures/visitor-tokens.json, made by scripts/visitor-token-corpus.ts), is run by the
// tests of both checks, and the corpus names every rule.
import { createPublicKey, sign, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/** Who mints visitor tokens: the site's server. */
export const VISITOR_ISSUER = 'lb-web'
/** The longest a token may live, as docs/SECURITY.md sets it, in seconds. */
export const MAX_LIFETIME_SECONDS = 300
// How much clock drift between the site and a system is forgiven, in seconds.
const LEEWAY_SECONDS = 30
// A session hash: the format the gateway accepts for session keys.
const SESSION_KEY = /^[\w-]{16,128}$/
// A compact JWT is three base64url segments of letters, digits, "-" and "_": no padding, nothing else.
const SEGMENT = /^[\w-]+$/
// No honest token comes near this; refusing larger input early keeps a flood of junk cheap.
const MAX_TOKEN_LENGTH = 2_048
// An Ed25519 signature is always 64 bytes.
const SIGNATURE_BYTES = 64
// The claims every token must carry.
const REQUIRED_CLAIMS = ['iss', 'aud', 'sub', 'iat', 'exp'] as const
// The one member that may hold a list, and only of strings: who the token is for.
const LIST_CLAIMS = ['aud'] as const
// The error every malformed token gets, whatever is wrong with it, so a caller can't probe which check failed.
const MALFORMED = 'The token is malformed.'
// What the Authorization header's scheme is called.
const BEARER_SCHEME = 'bearer'
// Decodes UTF-8 and refuses bytes that aren't, and keeps a byte order mark so that the JSON parser refuses it too.
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

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

// A system's name, such as `lb-08`: what the token's audience must be.
const SYSTEM_NAME = /^lb-\d{2}$/

/** Encodes a value as one base64url JSON segment of a token. */
function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/**
 * Signs a visitor token, the way the site's server mints it for one request to one system:
 * EdDSA, issuer `lb-web`, the system as audience, the visitor's session hash as subject,
 * and a lifetime of `ttlSeconds` (at most 300) from `nowSeconds`, which is Unix time in
 * seconds. The token carries no other claim. Refuses a system or a session hash the
 * verifiers would refuse, so a mistake fails here and not as a 401 somewhere else; error
 * messages name the rule, never the value.
 */
export function mintVisitorToken(key: KeyObject, visitor: Visitor, nowSeconds: number, ttlSeconds: number = MAX_LIFETIME_SECONDS): string {
  if (!SYSTEM_NAME.test(visitor.system)) throw new RangeError('A visitor token is for a system named like lb-08.')
  if (!SESSION_KEY.test(visitor.sessionKey)) throw new RangeError('A visitor token\'s subject is a session hash: 16 to 128 letters, digits, underscores or hyphens.')
  if (!Number.isFinite(nowSeconds)) throw new RangeError('A visitor token needs the time it is issued at, in seconds.')
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_LIFETIME_SECONDS) {
    throw new RangeError(`A visitor token lives from 1 to ${MAX_LIFETIME_SECONDS} seconds.`)
  }
  const issuedAt = Math.floor(nowSeconds)
  const header = { alg: 'EdDSA', typ: 'JWT' }
  const claims = { iss: VISITOR_ISSUER, aud: visitor.system, sub: visitor.sessionKey, iat: issuedAt, exp: issuedAt + ttlSeconds }
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`
  return `${signingInput}.${sign(null, Buffer.from(signingInput), key).toString('base64url')}`
}

/** Decodes one base64url segment of a token to its bytes. The text must be canonical: exactly what encoding those bytes writes, so a stray bit or a dangling character is refused (a lenient decoder would drop it, and Python's would not). */
function decodeSegment(segment: string): Buffer {
  const bytes = Buffer.from(segment, 'base64url')
  if (bytes.toString('base64url') !== segment) throw new VisitorTokenError(MALFORMED)
  return bytes
}

/** Reads the site's Ed25519 public key from its base64url form (a JWK's `x`): unpadded, canonical, and exactly 32 bytes. */
export function loadPublicKey(encoded: string): KeyObject {
  if (!SEGMENT.test(encoded)) throw new RangeError('LB_WEB_TOKEN_KEY isn\'t base64url.')
  const raw = Buffer.from(encoded, 'base64url')
  if (raw.length !== 32) throw new RangeError('LB_WEB_TOKEN_KEY isn\'t an Ed25519 public key: it must be 32 bytes.')
  if (raw.toString('base64url') !== encoded) throw new RangeError('LB_WEB_TOKEN_KEY isn\'t canonical base64url: its last character carries stray bits.')
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: encoded }, format: 'jwk' })
}

/** Tells whether a JSON value is a string, a number, a boolean or null: the plain values a token's members may hold. */
function isPlainValue(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** Tells whether a JSON value is a list of strings. */
function isListOfStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/**
 * Decodes one segment of a token as a JSON object, or fails as a malformed token. The bytes must be UTF-8
 * with no byte order mark, and every member a plain value (a string, number, boolean or null). Only the
 * members named in `listMembers` may hold a list, and then only of strings. Nothing deeper is allowed, so
 * there is no nesting for two JSON parsers to disagree about.
 */
function decodeObject(segment: string, listMembers: readonly string[]): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(STRICT_UTF8.decode(decodeSegment(segment)))
  }
  catch {
    // Not UTF-8, not JSON, or too deep to read: the error below doesn't repeat which.
    throw new VisitorTokenError(MALFORMED)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new VisitorTokenError(MALFORMED)
  const members = Object.entries(value)
  if (!members.every(([name, member]) => isPlainValue(member) || (listMembers.includes(name) && isListOfStrings(member)))) {
    throw new VisitorTokenError(MALFORMED)
  }
  return value as Record<string, unknown>
}

/** Tells whether a claim is a whole number of seconds a double holds exactly: 1790000000, 1.79e9 and 1790000000.0 are, 1790000000.5 and 2^53 are not. */
function isSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/** Checks that a token's header asks for the one algorithm accepted, and nothing the verifier doesn't understand. */
function checkHeader(header: Record<string, unknown>): void {
  // Only Ed25519 signatures: no `none`, and no shared-secret HMAC the site's public key could be misused as.
  if (header.alg !== 'EdDSA') throw new VisitorTokenError('The token isn\'t signed with EdDSA.')
  // A `crit` header lists extensions the verifier must understand, and this one understands none.
  if (Object.hasOwn(header, 'crit')) throw new VisitorTokenError('The token uses extensions this service doesn\'t understand.')
}

/** Checks that the audience claim names this system, as a string or in a list that holds nothing but strings. */
function audienceIncludes(audience: unknown, system: string): boolean {
  return audience === system || (isListOfStrings(audience) && audience.includes(system))
}

/** Checks a token's claims against the rules above, at a moment given in Unix seconds, and returns the session it vouches for. */
function checkClaims(claims: Record<string, unknown>, system: string, nowSeconds: number): string {
  for (const name of REQUIRED_CLAIMS) {
    if (!Object.hasOwn(claims, name)) throw new VisitorTokenError(`The token has no ${name} claim.`)
  }
  if (claims.iss !== VISITOR_ISSUER) throw new VisitorTokenError('The token wasn\'t issued by the site.')
  if (!audienceIncludes(claims.aud, system)) throw new VisitorTokenError('The token isn\'t for this system.')
  const { iat, exp, nbf, sub } = claims
  if (!isSeconds(iat) || !isSeconds(exp) || (nbf !== undefined && !isSeconds(nbf))) throw new VisitorTokenError('The token\'s times aren\'t whole seconds.')
  if (exp <= iat) throw new VisitorTokenError('The token expires before it was issued.')
  if (exp - iat > MAX_LIFETIME_SECONDS) throw new VisitorTokenError('The token may live at most 300 seconds.')
  if (exp <= nowSeconds - LEEWAY_SECONDS) throw new VisitorTokenError('The token has expired.')
  if (iat > nowSeconds + LEEWAY_SECONDS) throw new VisitorTokenError('The token was issued in the future.')
  if (nbf !== undefined && nbf > nowSeconds + LEEWAY_SECONDS) throw new VisitorTokenError('The token isn\'t valid yet.')
  if (typeof sub !== 'string' || !SESSION_KEY.test(sub)) throw new VisitorTokenError('The token\'s subject isn\'t a session hash.')
  return sub
}

/** Checks the signature over the first two segments exactly as written: 64 bytes of canonical base64url that verify under the site's key. */
function checkSignature(headerPart: string, claimsPart: string, signaturePart: string, publicKey: KeyObject): void {
  const signature = decodeSegment(signaturePart)
  let valid = false
  if (signature.length === SIGNATURE_BYTES) {
    try {
      valid = verify(null, Buffer.from(`${headerPart}.${claimsPart}`), publicKey, signature)
    }
    catch {
      valid = false
    }
  }
  if (!valid) throw new VisitorTokenError('The token\'s signature is wrong.')
}

/**
 * Checks a visitor token for `system`, and returns the visitor it vouches for. `now`
 * returns Unix time in seconds. Any problem throws a VisitorTokenError, which a system
 * answers with 401.
 */
export function verifyVisitorToken(token: string, system: string, publicKey: KeyObject, now: () => number = () => Date.now() / 1000): Visitor {
  if (token.length > MAX_TOKEN_LENGTH) throw new VisitorTokenError(MALFORMED)
  const segments = token.split('.')
  if (segments.length !== 3 || !segments.every(segment => SEGMENT.test(segment))) throw new VisitorTokenError(MALFORMED)
  const [headerPart = '', claimsPart = '', signaturePart = ''] = segments
  checkHeader(decodeObject(headerPart, []))
  checkSignature(headerPart, claimsPart, signaturePart, publicKey)
  return { sessionKey: checkClaims(decodeObject(claimsPart, LIST_CLAIMS), system, now()), system }
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

/** Tells whether a character is a space or a tab: all an Authorization header may be padded with. */
function isSpaceOrTab(character: string | undefined): boolean {
  return character === ' ' || character === '\t'
}

/** Strips leading and trailing spaces and tabs from a header value, and nothing else: `String.trim` would also strip line breaks, no-break spaces and byte order marks, which Python's check leaves alone. */
function stripSpacesAndTabs(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && isSpaceOrTab(value[start])) start += 1
  while (end > start && isSpaceOrTab(value[end - 1])) end -= 1
  return value.slice(start, end)
}

/**
 * Takes the token out of an `Authorization` header: the header stripped of spaces and tabs at both ends is
 * `Bearer` in any case, one or more spaces, and the token. The token's own rules then judge what follows
 * as a whole, so a tab, a line break or a second word in it makes the token malformed.
 */
function bearerToken(authorization: string | undefined): string {
  const text = stripSpacesAndTabs(authorization ?? '')
  const scheme = text.slice(0, BEARER_SCHEME.length)
  const rest = text.slice(BEARER_SCHEME.length)
  if (!/^bearer$/i.test(scheme) || !rest.startsWith(' ')) throw new VisitorTokenError('The request has no bearer token.')
  let tokenStart = 1
  while (rest[tokenStart] === ' ') tokenStart += 1
  return rest.slice(tokenStart)
}

/**
 * Builds the check a service runs on every request for `system`. The site's public key
 * is read once, here, so a misconfigured key stops the service at startup; without a
 * key the verifier refuses everyone, which is how a service fails closed.
 */
export function createVisitorVerifier(system: string, encodedKey: string | undefined, now: () => number = () => Date.now() / 1000): VisitorVerifier {
  const publicKey = encodedKey ? loadPublicKey(encodedKey) : undefined
  return (authorization) => {
    if (!publicKey) throw new VisitorTokenError('LB_WEB_TOKEN_KEY isn\'t set, so no visitor can be checked.')
    return verifyVisitorToken(bearerToken(authorization), system, publicKey, now)
  }
}
