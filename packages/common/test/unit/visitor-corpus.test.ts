// Runs the shared corpus of visitor tokens (test/fixtures/visitor-tokens.json) against the TypeScript
// verifier. python/lb-common's tests run the same file against the Python one, and the Django, Flask
// and Node systems run it through their own authentication, so every verifier accepts and refuses
// exactly the same tokens (docs/SECURITY.md, section 2). The file is made by
// scripts/visitor-token-corpus.ts, which also says what each rule is.
import { describe, expect, it } from 'vitest'

import { loadVisitorTokenCorpus } from '../../src/testing.ts'
import { createVisitorVerifier, loadPublicKey, verifyVisitorToken, visitorFromHeader, VisitorTokenError } from '../../src/visitors.ts'

const corpus = loadVisitorTokenCorpus()
const publicKey = loadPublicKey(corpus.publicKey)

/** Gives the moment every case is judged at, in Unix seconds. */
function now(): number {
  return corpus.now
}

describe('the corpus itself', () => {
  it('names a rule for every case, and has a case for every rule', () => {
    const named = new Set([...corpus.tokens, ...corpus.headers, ...corpus.keys].map(entry => entry.rule))

    expect([...named].filter(rule => !(rule in corpus.rules))).toEqual([])
    expect(Object.keys(corpus.rules).filter(rule => !named.has(rule))).toEqual([])
  })

  it('gives each case its own name, so a failure points at one case', () => {
    for (const list of [corpus.tokens, corpus.headers, corpus.keys]) {
      const names = list.map(entry => entry.name)

      expect(names.length).toBe(new Set(names).size)
    }
  })

  it('is big enough to mean something, with cases on both sides of every verdict', () => {
    expect(corpus.tokens.filter(entry => entry.expect === 'ok').length).toBeGreaterThan(20)
    expect(corpus.tokens.filter(entry => entry.expect === 'refuse').length).toBeGreaterThan(100)
    expect(corpus.headers.filter(entry => entry.expect === 'ok').length).toBeGreaterThan(5)
    expect(corpus.headers.filter(entry => entry.expect === 'refuse').length).toBeGreaterThan(10)
    expect(corpus.keys.filter(entry => entry.expect === 'ok').length).toBeGreaterThan(0)
    expect(corpus.keys.filter(entry => entry.expect === 'refuse').length).toBeGreaterThan(5)
  })
})

describe('verifyVisitorToken, on the corpus', () => {
  const accepted = corpus.tokens.filter(entry => entry.expect === 'ok')
  const refused = corpus.tokens.filter(entry => entry.expect === 'refuse')

  it.each(accepted)('accepts $name ($rule)', ({ token, system, sessionKey }) => {
    expect(verifyVisitorToken(token, system, publicKey, now)).toEqual({ sessionKey, system })
  })

  it.each(refused)('refuses $name ($rule)', ({ token, system }) => {
    expect(() => verifyVisitorToken(token, system, publicKey, now)).toThrow(VisitorTokenError)
  })

  it('refuses without ever repeating the token in its message', () => {
    for (const { token, system } of refused) {
      try {
        verifyVisitorToken(token, system, publicKey, now)
      }
      catch (error) {
        const message = (error as Error).message

        expect(message.length).toBeLessThan(200)
        if (token.length >= 20) expect(message).not.toContain(token.slice(0, 20))
      }
    }
  })
})

describe('visitorFromHeader and a verifier made with createVisitorVerifier, on the corpus', () => {
  const accepted = corpus.headers.filter(entry => entry.expect === 'ok')
  const refused = corpus.headers.filter(entry => entry.expect === 'refuse')

  it.each(accepted)('accepts $name ($rule)', ({ authorization, system }) => {
    const visitor = visitorFromHeader(authorization ?? undefined, system, corpus.publicKey, now)

    expect(visitor.system).toBe(system)
    expect(createVisitorVerifier(system, corpus.publicKey, now)(authorization ?? undefined)).toEqual(visitor)
  })

  it.each(refused)('refuses $name ($rule)', ({ authorization, system }) => {
    expect(() => visitorFromHeader(authorization ?? undefined, system, corpus.publicKey, now)).toThrow(VisitorTokenError)
    expect(() => createVisitorVerifier(system, corpus.publicKey, now)(authorization ?? undefined)).toThrow(VisitorTokenError)
  })
})

describe('loadPublicKey, on the corpus', () => {
  it.each(corpus.keys.filter(entry => entry.expect === 'ok'))('accepts $name ($rule)', ({ key }) => {
    expect(loadPublicKey(key).asymmetricKeyType).toBe('ed25519')
  })

  it.each(corpus.keys.filter(entry => entry.expect === 'refuse'))('refuses $name ($rule)', ({ key }) => {
    expect(() => loadPublicKey(key)).toThrow(RangeError)
  })
})
