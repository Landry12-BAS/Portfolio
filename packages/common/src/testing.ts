// Helpers for the tests of every Node system: the site's side of the visitor token, played
// by hand. Nothing in a running service imports this file.
//
// The site's Nitro server mints the real tokens (docs/SECURITY.md, section 2). A system's
// tests need tokens too, valid ones and deliberately wrong ones, so the format is written
// out here once, next to the check that reads it (visitors.ts). The shared corpus of
// tokens, with the verdict every verifier must give each, is read from here as well.
import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { z } from 'zod'

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

/** The claims of a visitor token for `system` that is valid at `nowSeconds` and lives five minutes. */
export function validClaims(nowSeconds: number, system = 'lb-08', session = 'session-0123456789abcdef'): Record<string, unknown> {
  return { iss: 'lb-web', aud: system, sub: session, iat: nowSeconds, exp: nowSeconds + 300 }
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

// Where the shared corpus lives, and the one place that writes it (scripts/visitor-token-corpus.ts).
const CORPUS_URL = new URL('../test/fixtures/visitor-tokens.json', import.meta.url)

// What every verifier must say about a case.
const verdictSchema = z.enum(['ok', 'refuse'])

// The corpus file as it is read: every field named, nothing else allowed, so a change to the file's shape is noticed.
const corpusSchema = z.strictObject({
  about: z.string(),
  // The rules the cases test, by number, in words.
  rules: z.record(z.string(), z.string()),
  // The moment every case is judged at, in Unix seconds.
  now: z.number().int().positive(),
  // The site's public key the signed cases were made for, as LB_WEB_TOKEN_KEY holds it.
  publicKey: z.string(),
  // Tokens, each checked for one system.
  tokens: z.array(z.strictObject({
    name: z.string(),
    rule: z.string(),
    system: z.string(),
    token: z.string(),
    expect: verdictSchema,
    // The visitor an accepted token names.
    sessionKey: z.string().optional(),
  }).refine(entry => entry.expect === 'refuse' || entry.sessionKey !== undefined, 'an accepted token names its visitor')),
  // Authorization headers, each around a token of the corpus.
  headers: z.array(z.strictObject({
    name: z.string(),
    rule: z.string(),
    system: z.string(),
    authorization: z.string().nullable(),
    expect: verdictSchema,
  })),
  // Ways the site's key may be configured.
  keys: z.array(z.strictObject({
    name: z.string(),
    rule: z.string(),
    key: z.string(),
    expect: verdictSchema,
  })),
})

/** The shared corpus of visitor tokens: signed tokens, header values and keys, each with the verdict every verifier must give it. */
export type VisitorTokenCorpus = z.infer<typeof corpusSchema>
/** One token of the corpus, and the system it is checked for. */
export type CorpusTokenCase = VisitorTokenCorpus['tokens'][number]
/** One Authorization header of the corpus. */
export type CorpusHeaderCase = VisitorTokenCorpus['headers'][number]
/** One way of configuring the site's key, from the corpus. */
export type CorpusKeyCase = VisitorTokenCorpus['keys'][number]

/**
 * Reads the shared corpus of visitor tokens (packages/common/test/fixtures/visitor-tokens.json) and checks its
 * shape. Every verifier's tests run this one file, so the TypeScript and Python checks, and the systems built on
 * them, accept and refuse exactly the same tokens.
 */
export function loadVisitorTokenCorpus(): VisitorTokenCorpus {
  return corpusSchema.parse(JSON.parse(readFileSync(CORPUS_URL, 'utf8')))
}
