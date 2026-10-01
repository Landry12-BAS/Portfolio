// Unit tests for the visitor-token check: a token the site mints is accepted, and every way a
// token can be wrong is refused. The rules are the ones python/lb-common's visitors.py applies.
import { describe, expect, it } from 'vitest'

import { createVisitorVerifier, loadPublicKey, verifyVisitorToken, visitorFromHeader, VisitorTokenError } from '../../src/visitors.ts'
import { hmacToken, makeSiteKeys, mintVisitorToken, segment, unsignedToken, validClaims } from '../support/visitor-tokens.ts'

const NOW = 1_790_000_000
const site = makeSiteKeys()

/** Verifies a token at a moment, for a system, against the test site's key. */
const verify = (token: string, at = NOW, system = 'lb-08') => verifyVisitorToken(token, system, site.publicKey, () => at)

/** Asserts that a token is refused, and that the refusal never repeats the token. */
function refused(token: string, at = NOW, system = 'lb-08'): VisitorTokenError {
  let caught: unknown
  try {
    verify(token, at, system)
  }
  catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(VisitorTokenError)
  if (token.length > 0) expect((caught as Error).message).not.toContain(token.slice(0, 20))
  return caught as VisitorTokenError
}

describe('a token the site minted', () => {
  it('names the visitor by their session hash and the system they call', () => {
    const visitor = verify(mintVisitorToken(site.privateKey, validClaims(NOW)))

    expect(visitor).toEqual({ sessionKey: 'session-0123456789abcdef', system: 'lb-08' })
  })

  it('accepts the audience as a list that includes the system, and a token a few seconds old', () => {
    expect(verify(mintVisitorToken(site.privateKey, { ...validClaims(NOW - 100), aud: ['lb-01', 'lb-08'] })).system).toBe('lb-08')
  })

  it('forgives 30 seconds of clock drift, and no more', () => {
    const claims = validClaims(NOW - 300)

    expect(verify(mintVisitorToken(site.privateKey, claims), NOW + 29)).toBeDefined()
    expect(() => verify(mintVisitorToken(site.privateKey, claims), NOW + 31)).toThrow('expired')
    expect(verify(mintVisitorToken(site.privateKey, validClaims(NOW + 29)))).toBeDefined()
    expect(() => verify(mintVisitorToken(site.privateKey, validClaims(NOW + 31)))).toThrow('future')
  })
})

describe('a token that is wrong', () => {
  it('is refused when it is malformed', () => {
    const good = mintVisitorToken(site.privateKey, validClaims(NOW))
    const parts = good.split('.')

    for (const token of ['', 'abc', 'a.b', `${good}.extra`, `${parts[0]}..${parts[2]}`, `${parts[0]}.${parts[1]}.`, `${parts[0]} .${parts[1]}.${parts[2]}`, 'x'.repeat(5_000), `${segment('not an object')}.${segment({})}.${parts[2]}`]) {
      refused(token)
    }
  })

  it('is refused when it is signed with another key, or altered after signing', () => {
    const other = makeSiteKeys()
    const good = mintVisitorToken(site.privateKey, validClaims(NOW))
    const [header, , signature] = good.split('.')

    refused(mintVisitorToken(other.privateKey, validClaims(NOW)))
    refused(`${header}.${segment({ ...validClaims(NOW), sub: 'someone-else-0123456789' })}.${signature}`)
    refused(`${segment({ alg: 'EdDSA', typ: 'JWT', kid: 'x' })}.${good.split('.')[1]}.${signature}`)
  })

  it('is refused when it says it needs no signature, or a shared secret', () => {
    refused(unsignedToken(validClaims(NOW)))
    refused(hmacToken(site.encodedPublicKey, validClaims(NOW)))
    refused(mintVisitorToken(site.privateKey, validClaims(NOW), { alg: 'HS256', typ: 'JWT' }))
  })

  it('is refused when it lists header extensions this verifier does not understand', () => {
    refused(mintVisitorToken(site.privateKey, validClaims(NOW), { alg: 'EdDSA', crit: ['exp'], exp: 1 }))
  })

  it('is refused when its claims break a rule', () => {
    const claims = validClaims(NOW)
    const cases: Record<string, unknown>[] = [
      { ...claims, iss: 'someone-else' },
      { ...claims, aud: 'lb-01' },
      { ...claims, aud: ['lb-01', 'lb-02'] },
      { ...claims, sub: 'short' },
      { ...claims, sub: 'has spaces and is long enough!' },
      { ...claims, sub: 42 },
      { ...claims, exp: NOW + 301 },
      { ...claims, exp: NOW },
      { ...claims, iat: 'now' },
      { ...claims, exp: NOW + 10.5 },
      { ...claims, nbf: NOW + 600 },
      { ...claims, nbf: 'later' },
    ]

    for (const bad of cases) refused(mintVisitorToken(site.privateKey, bad))
    for (const missing of ['iss', 'aud', 'sub', 'iat', 'exp']) {
      const without = Object.fromEntries(Object.entries(claims).filter(([name]) => name !== missing))
      expect(refused(mintVisitorToken(site.privateKey, without)).message).toContain(missing)
    }
  })

  it('is refused when it is for another system', () => {
    refused(mintVisitorToken(site.privateKey, validClaims(NOW)), NOW, 'lb-01')
  })

  it('may live at most 300 seconds, however far its expiry is from now', () => {
    refused(mintVisitorToken(site.privateKey, { ...validClaims(NOW), exp: NOW + 86_400 }))
  })
})

describe('the Authorization header', () => {
  const token = mintVisitorToken(site.privateKey, validClaims(NOW))

  it('is read as a bearer token, whatever the case of the scheme', () => {
    expect(visitorFromHeader(`Bearer ${token}`, 'lb-08', site.encodedPublicKey, () => NOW).sessionKey).toBe('session-0123456789abcdef')
    expect(visitorFromHeader(`bearer   ${token}  `, 'lb-08', site.encodedPublicKey, () => NOW).system).toBe('lb-08')
  })

  it('is refused when it is missing, empty, or another scheme', () => {
    for (const header of [undefined, '', 'Bearer', 'Bearer ', `Basic ${token}`, token, `Bearer ${token} extra`]) {
      expect(() => visitorFromHeader(header, 'lb-08', site.encodedPublicKey, () => NOW)).toThrow(VisitorTokenError)
    }
  })

  it('fails closed when the site\'s key is not configured, however good the token is', () => {
    expect(() => visitorFromHeader(`Bearer ${token}`, 'lb-08', undefined, () => NOW)).toThrow('LB_WEB_TOKEN_KEY isn\'t set')
    expect(() => visitorFromHeader(`Bearer ${token}`, 'lb-08', '', () => NOW)).toThrow(VisitorTokenError)
    expect(() => createVisitorVerifier('lb-08', undefined)(`Bearer ${token}`)).toThrow(VisitorTokenError)
  })

  it('stops a misconfigured key at startup, not on the first request', () => {
    expect(() => createVisitorVerifier('lb-08', 'not a key')).toThrow(RangeError)
    expect(() => createVisitorVerifier('lb-08', 'AAAA')).toThrow('32 bytes')
  })

  it('loads the key once for a verifier that serves many requests', () => {
    const verifier = createVisitorVerifier('lb-08', site.encodedPublicKey, () => NOW)

    expect(verifier(`Bearer ${token}`).sessionKey).toBe('session-0123456789abcdef')
    expect(verifier(`Bearer ${token}`).sessionKey).toBe('session-0123456789abcdef')
  })
})

describe('the site\'s public key', () => {
  it('is 32 bytes of base64url', () => {
    expect(loadPublicKey(site.encodedPublicKey).asymmetricKeyType).toBe('ed25519')
    expect(() => loadPublicKey('')).toThrow(RangeError)
    expect(() => loadPublicKey('a+b/c=')).toThrow('base64url')
    expect(() => loadPublicKey(`${site.encodedPublicKey}AA`)).toThrow('32 bytes')
  })
})
