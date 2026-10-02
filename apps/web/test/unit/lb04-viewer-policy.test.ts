// Tests of how LB-04's PDF viewer starts pdf.js's worker under the site's Content Security Policy, and of
// what the board's two pages add to that policy. The worker's address is made by one named Trusted Types
// policy that hands out that one address and no other; the server adds the policy's name and the worker
// source to the board's two pages and changes nothing else.
import { beforeEach, describe, expect, it } from 'vitest'

import { LB04_BOARD_PAGE_ROUTES, PDF_WORKER_POLICY } from '#shared/lb04-viewer'

import { forgetPolicy, startPdfWorker, trustedWorkerUrl } from '~/boards/lb-04/pdf/worker'
import type { PolicyFactory } from '~/boards/lb-04/pdf/worker'

import { addLb04Policy } from '../../server/lib/lb04-csp'
import type { SecurityRules } from '../../server/lib/lb04-csp'

const ADDRESS = '/_nuxt/pdf.worker.min.abc123.mjs'

/** A Trusted Types factory that wraps what it is given, so a test can tell a made value from a plain string. */
function factory(): PolicyFactory & { made: string[] } {
  const made: string[] = []
  return {
    made,
    createPolicy: (name, rules) => {
      made.push(name)
      return { createScriptURL: input => ({ trusted: rules.createScriptURL(input) }) }
    },
  }
}

describe('the worker\'s address', () => {
  beforeEach(() => {
    forgetPolicy()
  })

  it('is plain text where the browser has no Trusted Types', () => {
    expect(trustedWorkerUrl(undefined, ADDRESS)).toBe(ADDRESS)
  })

  it('is a value made by the one policy, named lb-pdf-worker, never the default one', () => {
    const trusted = factory()

    expect(trustedWorkerUrl(trusted, ADDRESS)).toEqual({ trusted: ADDRESS })
    expect(trusted.made).toEqual([PDF_WORKER_POLICY])
    expect(PDF_WORKER_POLICY).toBe('lb-pdf-worker')
    expect(trusted.made).not.toContain('default')
  })

  it('makes the policy once, however many times the address is asked for', () => {
    const trusted = factory()
    trustedWorkerUrl(trusted, ADDRESS)
    trustedWorkerUrl(trusted, ADDRESS)
    trustedWorkerUrl(trusted, ADDRESS)

    expect(trusted.made).toHaveLength(1)
  })

  it('hands out no other address: the policy throws for any other text', () => {
    let rules: { createScriptURL: (input: string) => string } | undefined
    const keepRules: PolicyFactory = {
      createPolicy: (_, given) => {
        rules = given
        return { createScriptURL: input => input }
      },
    }
    trustedWorkerUrl(keepRules, ADDRESS)

    expect(rules?.createScriptURL(ADDRESS)).toBe(ADDRESS)
    // eslint-disable-next-line no-script-url -- the test hands the policy a script URL to prove it refuses it
    for (const other of ['https://evil.example/worker.js', '/_nuxt/other.mjs', 'data:text/javascript,1', 'javascript:alert(1)', '']) {
      expect(() => rules?.createScriptURL(other), other).toThrow(TypeError)
    }
  })
})

describe('starting the worker', () => {
  beforeEach(() => {
    forgetPolicy()
  })

  it('starts a module worker from the address the policy made, named lb-pdf', () => {
    const started: { address: unknown, options: unknown }[] = []
    /** A stand-in for the browser's Worker that only notes how it was started. */
    const FakeWorker = function FakeWorker(this: unknown, address: string, options: { type: 'module', name: string }): void {
      started.push({ address, options })
    }

    startPdfWorker(ADDRESS, { trustedTypes: factory(), Worker: FakeWorker as unknown as never })

    expect(started).toEqual([{ address: { trusted: ADDRESS }, options: { type: 'module', name: 'lb-pdf' } }])
  })
})

/** The rules as the other boards and every page have them. */
function baseRules(): SecurityRules {
  return {
    '/**': { headers: { contentSecurityPolicy: { 'connect-src': ['\'self\''], 'default-src': ['\'self\''], 'trusted-types': ['vue'] } } },
    '/systems/*/board': { headers: { contentSecurityPolicy: { 'frame-src': ['https://challenges.cloudflare.com'], 'trusted-types': ['vue', 'lb-turnstile'] } } },
    '/cs/systems/*/board': { headers: { contentSecurityPolicy: { 'frame-src': ['https://challenges.cloudflare.com'], 'trusted-types': ['vue', 'lb-turnstile'] } } },
  }
}

/** Reads one directive of a route's policy. */
function directive(rules: SecurityRules, route: string, name: string): unknown {
  const headers = rules[route]?.headers
  const policy = headers ? headers.contentSecurityPolicy : undefined
  return typeof policy === 'object' ? (policy as Record<string, unknown>)[name] : undefined
}

describe('LB-04\'s additions to the Content Security Policy', () => {
  it('gives each of the two board pages the policy name and the worker source', () => {
    const rules = baseRules()
    addLb04Policy(rules)

    for (const route of LB04_BOARD_PAGE_ROUTES) {
      expect(directive(rules, route, 'trusted-types')).toEqual(['vue', 'lb-turnstile', PDF_WORKER_POLICY])
      expect(directive(rules, route, 'worker-src')).toEqual(['\'self\''])
      // What the boards share (the Turnstile frame) is inherited from their own rule, which a page's rule is merged over.
      expect(directive(rules, route, 'frame-src')).toBeUndefined()
    }
  })

  it('leaves every other rule exactly as it was, and touches neither the script nor the connect sources', () => {
    const rules = baseRules()
    addLb04Policy(rules)
    const untouched = baseRules()

    for (const route of Object.keys(untouched)) expect(rules[route]).toEqual(untouched[route])
    expect(Object.keys(rules).sort()).toEqual([...Object.keys(untouched), ...LB04_BOARD_PAGE_ROUTES].sort())
    for (const route of LB04_BOARD_PAGE_ROUTES) {
      expect(directive(rules, route, 'script-src')).toBeUndefined()
      expect(directive(rules, route, 'connect-src')).toBeUndefined()
    }
  })

  it('adds nothing wide: no wildcard, no scheme alone, no unsafe source, no default policy', () => {
    const rules = baseRules()
    addLb04Policy(rules)

    for (const route of LB04_BOARD_PAGE_ROUTES) {
      const added = [...(directive(rules, route, 'trusted-types') as string[]), ...(directive(rules, route, 'worker-src') as string[])]
      for (const source of added) {
        expect(source).not.toBe('*')
        expect(source).not.toMatch(/^[a-z]+:$/)
        expect(source).not.toMatch(/unsafe|default/)
      }
    }
  })

  it('is a second run that changes nothing more', () => {
    const once = baseRules()
    addLb04Policy(once)
    const twice = baseRules()
    addLb04Policy(twice)
    addLb04Policy(twice)

    expect(twice).toEqual(once)
  })

  it('names the board in both languages and nothing else', () => {
    expect([...LB04_BOARD_PAGE_ROUTES]).toEqual(['/systems/lb-04/board', '/cs/systems/lb-04/board'])
  })
})
