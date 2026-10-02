// The site server's settings, read from Nuxt's runtime config (the NUXT_* environment variables
// docs/DEPLOY.md lists) and checked once, at startup, with Zod. A site that has none of them (a
// Vercel preview) runs with its demos off and says so; a site that has some but not all, or any
// that are wrong, refuses to start rather than half work. Problems are reported by variable
// name and by rule: the message never repeats a value, so no log can leak a key or a secret.
import type { KeyObject } from 'node:crypto'

import { privateKeyFromJwk, ServiceTokens } from '@lb/common/tokens'
import { z } from 'zod'

/**
 * The runtime config as Nuxt hands it over: empty when the variable isn't set. Nitro reads an
 * environment variable that holds JSON as the JSON it holds, so a key file's contents arrive as an
 * object, not a string; every setting is read through `settingText`, which accepts both.
 */
export interface RawRuntimeConfig {
  lbApiUrl?: unknown
  lbGatewayUrl?: unknown
  lbWebSigningKey?: unknown
  lbGatewayServiceKey?: unknown
  lbSessionSecret?: unknown
  turnstileSecretKey?: unknown
  public?: { turnstileSiteKey?: unknown }
}

/** The settings of a site that is set up, with keys already built. */
export interface SiteConfig {
  // The origin of the API the Django, Flask and Node systems answer on (NUXT_LB_API_URL).
  apiUrl: URL
  // The origin of the gateway's one public route (NUXT_LB_GATEWAY_URL).
  gatewayUrl: URL
  // The site's private key, which signs visitor tokens (NUXT_LB_WEB_SIGNING_KEY).
  signingKey: KeyObject
  // The `web` service's tokens for the gateway, from its private key (NUXT_LB_GATEWAY_SERVICE_KEY).
  gatewayTokens: ServiceTokens
  // The secret the session cookie's signature and the visitors' hashes are derived from (NUXT_LB_SESSION_SECRET).
  sessionSecret: Buffer
  // Turnstile's secret key (NUXT_TURNSTILE_SECRET_KEY), empty only in the test build.
  turnstileSecretKey: string
  // Turnstile's site key (NUXT_PUBLIC_TURNSTILE_SITE_KEY), empty only in the test build.
  turnstileSiteKey: string
}

/** Whether the site has what it needs to serve its demos. */
export type SiteState
  = | { status: 'disabled' }
    | { status: 'ready', config: SiteConfig }

/** The settings are wrong: the message names each variable and the rule it breaks, never a value. */
export class ConfigError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`Invalid site settings:\n- ${problems.join('\n- ')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

// The names the variables have in the environment, by runtime config key, for the messages.
const VARIABLE_NAMES: Readonly<Record<string, string>> = {
  lbApiUrl: 'NUXT_LB_API_URL',
  lbGatewayUrl: 'NUXT_LB_GATEWAY_URL',
  lbWebSigningKey: 'NUXT_LB_WEB_SIGNING_KEY',
  lbGatewayServiceKey: 'NUXT_LB_GATEWAY_SERVICE_KEY',
  lbSessionSecret: 'NUXT_LB_SESSION_SECRET',
  turnstileSecretKey: 'NUXT_TURNSTILE_SECRET_KEY',
  turnstileSiteKey: 'NUXT_PUBLIC_TURNSTILE_SITE_KEY',
}

/** Reads a setting as text: a string as it is, JSON that Nitro already parsed written out again, and nothing as an empty text. */
function settingText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value as number | boolean)
}

/** Tells whether a host is the machine itself, the one place plain HTTP is accepted. */
function isLoopback(host: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(host)
}

/** Checks that a text is the origin of a service: HTTPS (HTTP only on this machine), no login, no path, no query. */
function isServiceOrigin(text: string): boolean {
  let url: URL
  try {
    url = new URL(text)
  }
  catch {
    return false
  }
  const allowedScheme = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname))
  return allowedScheme && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === ''
}

/** Reads a key's JWK text and checks that it is an Ed25519 private key whose halves match. */
function readPrivateKey(text: string): KeyObject | undefined {
  try {
    return privateKeyFromJwk(JSON.parse(text) as unknown)
  }
  catch {
    return undefined
  }
}

// The checks, one for each variable. They only say whether a value is acceptable (a message
// for each is in VARIABLE_RULES), so the failure message can never include the value.
const settingsSchema = z.object({
  lbApiUrl: z.string().refine(isServiceOrigin),
  lbGatewayUrl: z.string().refine(isServiceOrigin),
  lbWebSigningKey: z.string().refine(text => readPrivateKey(text) !== undefined),
  lbGatewayServiceKey: z.string().refine(text => readPrivateKey(text) !== undefined),
  lbSessionSecret: z.string().min(32).max(512),
  turnstileSecretKey: z.string().min(1).max(200),
  turnstileSiteKey: z.string().min(1).max(100),
})

// What each rule says, in words for the person who set the variable.
const VARIABLE_RULES: Readonly<Record<string, string>> = {
  lbApiUrl: 'must be the API\'s origin: https://host (http only for localhost), with no login, path or query',
  lbGatewayUrl: 'must be the gateway\'s origin: https://host (http only for localhost), with no login, path or query',
  lbWebSigningKey: 'must be an Ed25519 private key in JWK form (the contents of the `site` key file)',
  lbGatewayServiceKey: 'must be an Ed25519 private key in JWK form (the contents of the `web` key file)',
  lbSessionSecret: 'must be a random secret of at least 32 characters (`just secret-token 32`)',
  turnstileSecretKey: 'must be Turnstile\'s secret key',
  turnstileSiteKey: 'must be Turnstile\'s site key',
}

/**
 * Checks the runtime config and builds the site's settings. With none of the variables set, the
 * site is `disabled`: it serves its pages and answers the demos' routes with 503. With some set,
 * every one must be right, or this throws a ConfigError. `testBuild` is the end-to-end build,
 * which has no Turnstile to check against and so doesn't need its two keys. `now` is the clock,
 * in Unix milliseconds, the service tokens are dated by.
 */
export function loadSiteState(raw: RawRuntimeConfig, testBuild: boolean, now: () => number = Date.now): SiteState {
  const values: Record<string, string> = {
    lbApiUrl: settingText(raw.lbApiUrl),
    lbGatewayUrl: settingText(raw.lbGatewayUrl),
    lbWebSigningKey: settingText(raw.lbWebSigningKey),
    lbGatewayServiceKey: settingText(raw.lbGatewayServiceKey),
    lbSessionSecret: settingText(raw.lbSessionSecret),
    turnstileSecretKey: settingText(raw.turnstileSecretKey),
    turnstileSiteKey: settingText(raw.public?.turnstileSiteKey),
  }
  if (Object.values(values).every(value => value === '')) return { status: 'disabled' }

  const needed = testBuild ? ['lbApiUrl', 'lbGatewayUrl', 'lbWebSigningKey', 'lbGatewayServiceKey', 'lbSessionSecret'] : Object.keys(values)
  const problems: string[] = []
  for (const key of needed) {
    const field = settingsSchema.shape[key as keyof typeof settingsSchema.shape]
    const checked = field.safeParse(values[key])
    if (!checked.success) {
      const state = values[key] === '' ? 'is not set' : VARIABLE_RULES[key]
      problems.push(`${VARIABLE_NAMES[key]} ${state}`)
    }
  }
  if (problems.length > 0) throw new ConfigError(problems)

  const signingKey = readPrivateKey(values.lbWebSigningKey ?? '')
  const serviceKey = readPrivateKey(values.lbGatewayServiceKey ?? '')
  if (!signingKey || !serviceKey) throw new ConfigError(['The keys could not be read.'])
  return {
    status: 'ready',
    config: {
      apiUrl: new URL(values.lbApiUrl ?? ''),
      gatewayUrl: new URL(values.lbGatewayUrl ?? ''),
      signingKey,
      gatewayTokens: new ServiceTokens('web', serviceKey, () => now() / 1_000),
      sessionSecret: Buffer.from(values.lbSessionSecret ?? '', 'utf8'),
      turnstileSecretKey: values.turnstileSecretKey ?? '',
      turnstileSiteKey: values.turnstileSiteKey ?? '',
    },
  }
}
