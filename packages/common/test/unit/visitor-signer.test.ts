// Unit tests for the visitor token's signer, the site's half of the format: what it signs is
// exactly what the check accepts, and what the check would refuse it won't sign. The proof
// against the Python verifier is python/lb-common/tests/integration/test_visitor_contract.py.
import { describe, expect, it } from 'vitest'

import { makeSiteKeys } from '../../src/testing.ts'
import { MAX_LIFETIME_SECONDS, mintVisitorToken, verifyVisitorToken, VisitorTokenError } from '../../src/visitors.ts'

const NOW = 1_790_000_000
const site = makeSiteKeys()
const visitor = { sessionKey: 'Zk3mQ9vP2xT7aB1cD4eF6gH8iJ0kL5nO-_s', system: 'lb-01' }

/** Decodes one base64url segment of a token as JSON. */
function decode(segment: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
}

describe('a token the signer mints', () => {
  it('carries exactly the claims the systems check, and nothing else', () => {
    const [header, claims, signature] = mintVisitorToken(site.privateKey, visitor, NOW).split('.')

    expect(decode(header)).toEqual({ alg: 'EdDSA', typ: 'JWT' })
    expect(decode(claims)).toEqual({ iss: 'lb-web', aud: 'lb-01', sub: visitor.sessionKey, iat: NOW, exp: NOW + 300 })
    expect(Buffer.from(signature ?? '', 'base64url')).toHaveLength(64)
  })

  it('is accepted by the check for its own system and refused for any other', () => {
    const token = mintVisitorToken(site.privateKey, visitor, NOW)

    expect(verifyVisitorToken(token, 'lb-01', site.publicKey, () => NOW)).toEqual(visitor)
    for (const other of ['lb-02', 'lb-05', 'lb-08']) {
      expect(() => verifyVisitorToken(token, other, site.publicKey, () => NOW)).toThrow(VisitorTokenError)
    }
  })

  it('is refused when it was signed with another key', () => {
    const token = mintVisitorToken(makeSiteKeys().privateKey, visitor, NOW)

    expect(() => verifyVisitorToken(token, 'lb-01', site.publicKey, () => NOW)).toThrow('signature')
  })

  it('is minted for each of the four systems the site calls', () => {
    for (const system of ['lb-01', 'lb-02', 'lb-05', 'lb-08']) {
      const token = mintVisitorToken(site.privateKey, { ...visitor, system }, NOW)

      expect(verifyVisitorToken(token, system, site.publicKey, () => NOW).system).toBe(system)
    }
  })

  it('lives five minutes unless asked for less, and lapses after its lifetime plus the clock drift allowed', () => {
    const fiveMinutes = mintVisitorToken(site.privateKey, visitor, NOW)
    const oneMinute = mintVisitorToken(site.privateKey, visitor, NOW, 60)

    expect(MAX_LIFETIME_SECONDS).toBe(300)
    expect(decode(fiveMinutes.split('.')[1]).exp).toBe(NOW + 300)
    expect(decode(oneMinute.split('.')[1]).exp).toBe(NOW + 60)
    expect(verifyVisitorToken(oneMinute, 'lb-01', site.publicKey, () => NOW + 89)).toEqual(visitor)
    expect(() => verifyVisitorToken(oneMinute, 'lb-01', site.publicKey, () => NOW + 91)).toThrow('expired')
  })

  it('is stamped with whole seconds, whatever fraction of a second the clock gives', () => {
    const token = mintVisitorToken(site.privateKey, visitor, NOW + 0.9)

    expect(decode(token.split('.')[1])).toMatchObject({ iat: NOW, exp: NOW + 300 })
  })

  it('is the same token for the same grant and time, since Ed25519 signatures are deterministic', () => {
    expect(mintVisitorToken(site.privateKey, visitor, NOW)).toBe(mintVisitorToken(site.privateKey, visitor, NOW))
  })

  it('fits comfortably in an Authorization header', () => {
    expect(mintVisitorToken(site.privateKey, { ...visitor, sessionKey: 'x'.repeat(128) }, NOW).length).toBeLessThan(600)
  })
})

describe('what the signer refuses to sign', () => {
  const refused = (change: () => unknown) => expect(change).toThrow(RangeError)

  it('refuses a lifetime the systems would refuse', () => {
    for (const ttl of [0, -1, 301, 3_600, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      refused(() => mintVisitorToken(site.privateKey, visitor, NOW, ttl))
    }
  })

  it('refuses a system that is not named like one', () => {
    for (const system of ['', 'lb-1', 'lb-001', 'LB-01', 'lb-01 ', 'lb-gateway', 'lb-web', 'web', '../lb-01']) {
      refused(() => mintVisitorToken(site.privateKey, { ...visitor, system }, NOW))
    }
  })

  it('refuses a subject that is not a session hash', () => {
    for (const sessionKey of ['', 'short', 'x'.repeat(129), 'has spaces in it 0123456789', 'has.dots.0123456789abcdef', 'unicode-žluťoučký-0123456789']) {
      refused(() => mintVisitorToken(site.privateKey, { ...visitor, sessionKey }, NOW))
    }
  })

  it('refuses a time that is not a number', () => {
    refused(() => mintVisitorToken(site.privateKey, visitor, Number.NaN))
    refused(() => mintVisitorToken(site.privateKey, visitor, Number.POSITIVE_INFINITY))
  })

  it('names the rule it broke and never repeats a session hash', () => {
    let message = ''
    try {
      mintVisitorToken(site.privateKey, { ...visitor, sessionKey: 'a secret session!' }, NOW)
    }
    catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('session hash')
    expect(message).not.toContain('secret')
  })
})
