// Tests for the server's settings: a site with none of them runs with its demos off, a site with
// some must have them all and right, and no message ever repeats a value.
import { describe, expect, it } from 'vitest'

import { ConfigError, loadSiteState } from '../../server/lib/config.ts'
import type { RawRuntimeConfig } from '../../server/lib/config.ts'
import { TEST_BUILD_ON_VERCEL } from '../../shared/build-mode.ts'
import { makeTestKeys } from '../support/site-app.ts'

const keys = makeTestKeys()

/** A complete, valid set of settings, with any of them replaced. */
function settings(overrides: Partial<RawRuntimeConfig> = {}): RawRuntimeConfig {
  return {
    lbApiUrl: 'https://api.example.com',
    lbGatewayUrl: 'https://api.example.com',
    lbWebSigningKey: keys.siteJwk,
    lbGatewayServiceKey: keys.webJwk,
    lbSessionSecret: 'a-session-secret-of-more-than-32-characters',
    turnstileSecretKey: 'turnstile-secret',
    public: { turnstileSiteKey: 'turnstile-site-key' },
    ...overrides,
  }
}

/** Loads settings that are expected to be wrong, and returns the problems found. */
function problemsOf(raw: RawRuntimeConfig, testBuild = false): readonly string[] {
  try {
    loadSiteState(raw, testBuild)
  }
  catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('The settings were expected to be refused.')
}

describe('a site with its settings', () => {
  it('is ready, with its keys built and its origins read', () => {
    const state = loadSiteState(settings(), false)

    expect(state.status).toBe('ready')
    if (state.status !== 'ready') return
    expect(state.config.apiUrl.origin).toBe('https://api.example.com')
    expect(state.config.signingKey.asymmetricKeyType).toBe('ed25519')
    expect(state.config.gatewayTokens.service).toBe('web')
    expect(state.config.gatewayTokens.current().split('.')).toHaveLength(3)
    expect(state.config.turnstileSiteKey).toBe('turnstile-site-key')
  })

  it('reads a key that Nitro has already parsed: an environment variable holding JSON arrives as an object', () => {
    const state = loadSiteState(settings({ lbWebSigningKey: JSON.parse(keys.siteJwk) as unknown, lbGatewayServiceKey: JSON.parse(keys.webJwk) as unknown }), false)

    expect(state.status).toBe('ready')
  })

  it('accepts plain HTTP for a back end on this machine, and for nothing else', () => {
    expect(loadSiteState(settings({ lbApiUrl: 'http://127.0.0.1:8001', lbGatewayUrl: 'http://localhost:8080' }), false).status).toBe('ready')
    expect(problemsOf(settings({ lbApiUrl: 'http://api.example.com' }))).toEqual([expect.stringContaining('NUXT_LB_API_URL')])
  })
})

describe('a site with no settings', () => {
  it('runs with its demos off, as a preview deployment does', () => {
    expect(loadSiteState({}, false)).toEqual({ status: 'disabled' })
    expect(loadSiteState({ lbApiUrl: '', lbSessionSecret: '', public: { turnstileSiteKey: '' } }, false)).toEqual({ status: 'disabled' })
  })
})

describe('a site with settings that are wrong', () => {
  it('refuses to start when only some are set, naming each one that is missing', () => {
    const problems = problemsOf({ lbApiUrl: 'https://api.example.com' })

    expect(problems.map(problem => problem.split(' ')[0])).toEqual([
      'NUXT_LB_GATEWAY_URL', 'NUXT_LB_WEB_SIGNING_KEY', 'NUXT_LB_GATEWAY_SERVICE_KEY', 'NUXT_LB_SESSION_SECRET', 'NUXT_TURNSTILE_SECRET_KEY', 'NUXT_PUBLIC_TURNSTILE_SITE_KEY',
    ])
    expect(problems.every(problem => problem.includes('is not set'))).toBe(true)
  })

  it('refuses an origin that is not an origin', () => {
    for (const bad of ['api.example.com', 'ftp://api.example.com', 'https://user:pass@api.example.com', 'https://api.example.com/v1', 'https://api.example.com/?x=1', 'https://api.example.com/#x', 'not a url', 'data:text/html,hello']) {
      expect(problemsOf(settings({ lbApiUrl: bad })), bad).toEqual([expect.stringContaining('NUXT_LB_API_URL')])
    }
  })

  it('refuses a key that is not an Ed25519 private key in JWK form, a public key alone, and keys whose halves do not match', () => {
    const other = makeTestKeys()
    const publicOnly = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: keys.sitePublic })
    const mismatched = JSON.stringify({ ...JSON.parse(keys.siteJwk) as object, x: other.sitePublic })
    for (const bad of ['', 'not json', '{}', '[]', publicOnly, mismatched, JSON.stringify({ kty: 'RSA' })]) {
      expect(problemsOf(settings({ lbWebSigningKey: bad })), bad.slice(0, 20)).toEqual([expect.stringContaining('NUXT_LB_WEB_SIGNING_KEY')])
    }
    expect(problemsOf(settings({ lbGatewayServiceKey: publicOnly }))).toEqual([expect.stringContaining('NUXT_LB_GATEWAY_SERVICE_KEY')])
  })

  it('refuses a session secret that is too short to be random', () => {
    expect(problemsOf(settings({ lbSessionSecret: 'short' }))).toEqual([expect.stringContaining('NUXT_LB_SESSION_SECRET')])
  })

  it('never repeats a value in what it says, even a secret one', () => {
    const secrets = ['hunter2-hunter2-hunter2-hunter2-0001', 'https://user:p4ssw0rd-LEAK@api.example.com/path', '{"kty":"OKP","d":"PRIVATE-PART-LEAK"}', 'turnstile-LEAK']
    const raw = settings({
      lbSessionSecret: 'x',
      lbApiUrl: secrets[1],
      lbWebSigningKey: secrets[2],
      turnstileSecretKey: '',
      public: { turnstileSiteKey: '' },
    })

    let message = ''
    try {
      loadSiteState(raw, false)
    }
    catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('NUXT_LB_API_URL')
    for (const secret of secrets) expect(message).not.toContain(secret.slice(8, 20))
    expect(message).not.toContain('LEAK')
    expect(message).not.toContain('p4ssw0rd')
  })
})

describe('the end-to-end test build', () => {
  it('needs no Turnstile keys, since it has no Turnstile to ask', () => {
    const raw = settings({ turnstileSecretKey: '', public: { turnstileSiteKey: '' } })

    expect(loadSiteState(raw, true).status).toBe('ready')
    expect(problemsOf(raw, false)).toEqual([expect.stringContaining('NUXT_TURNSTILE_SECRET_KEY'), expect.stringContaining('NUXT_PUBLIC_TURNSTILE_SITE_KEY')])
  })

  it('still needs everything else', () => {
    expect(problemsOf(settings({ lbApiUrl: '' }), true)).toEqual([expect.stringContaining('NUXT_LB_API_URL')])
  })

  it('refuses to start where VERCEL is set, with settings or without, so a server built as a test build never serves the production site', () => {
    const onVercel = { VERCEL: '1' }

    for (const raw of [settings(), {}]) {
      expect(() => loadSiteState(raw, true, Date.now, onVercel)).toThrow(ConfigError)
      expect(() => loadSiteState(raw, true, Date.now, onVercel)).toThrow(TEST_BUILD_ON_VERCEL)
    }
  })

  it('starts anywhere else, and the production build starts on Vercel', () => {
    expect(loadSiteState(settings(), true, Date.now, {}).status).toBe('ready')
    expect(loadSiteState({}, true, Date.now, {}).status).toBe('disabled')
    expect(loadSiteState(settings(), false, Date.now, { VERCEL: '1' }).status).toBe('ready')
  })
})
