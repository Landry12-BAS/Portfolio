// The site's side of the visitor token, as the tests play it: mint a token the way the Nuxt
// server must (docs/SECURITY.md, section 2), or a deliberately wrong one.
import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/** The site's Ed25519 key pair, with the public half in the form LB_WEB_TOKEN_KEY holds. */
export interface SiteKeys {
  privateKey: KeyObject
  publicKey: KeyObject
  encodedPublicKey: string
}

/** Makes a fresh key pair for a test site, so no test depends on a key in the repository. */
export function makeSiteKeys(): SiteKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey, encodedPublicKey: publicKey.export({ format: 'jwk' }).x ?? '' }
}

/** The claims of a token that is valid at `now` for lb-08. */
export function validClaims(now: number): Record<string, unknown> {
  return { iss: 'lb-web', aud: 'lb-08', sub: 'session-0123456789abcdef', iat: now, exp: now + 300 }
}

/** Encodes a value as one base64url JSON segment. */
export function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/** Mints a token signed with the site's key. Pass `claims` or `header` to bend the rules. */
export function mintVisitorToken(key: KeyObject, claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'EdDSA', typ: 'JWT' }): string {
  const signingInput = `${segment(header)}.${segment(claims)}`
  return `${signingInput}.${sign(null, Buffer.from(signingInput), key).toString('base64url')}`
}

/** Mints an unsigned token (`alg: none`), the classic way to forge one. */
export function unsignedToken(claims: Record<string, unknown>): string {
  return `${segment({ alg: 'none', typ: 'JWT' })}.${segment(claims)}.`
}

/** Mints a token signed with HMAC, using the site's public key as the shared secret, the other classic forgery. */
export function hmacToken(secret: string, claims: Record<string, unknown>): string {
  const signingInput = `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment(claims)}`
  return `${signingInput}.${createHmac('sha256', secret).update(signingInput).digest('base64url')}`
}
