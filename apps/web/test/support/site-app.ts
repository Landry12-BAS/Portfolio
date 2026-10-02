// A running copy of the site's server for the integration tests: the real handlers from
// server/api-routes.ts, in an h3 app on a local port, with fakes for what they reach out to.
// Nothing here starts Nuxt, so a test of the whole API takes milliseconds; and because the app
// is built from the same route list the site uses, a handler can't be tested that isn't served.
//
// The back ends are the mock from @lb/api-clients/testing, which the test starts and points the
// site at. Turnstile is a fake that answers what the test says. The clock is the test's.
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'
import type { EventHandler } from 'h3'

import { SERVER_ROUTES } from '../../server/api-routes.ts'
import { loadSiteState } from '../../server/lib/config.ts'
import type { RawRuntimeConfig } from '../../server/lib/config.ts'
import { SYSTEM_POLICIES } from '../../server/lib/policy.ts'
import type { SystemPolicy } from '../../server/lib/policy.ts'
import { SITEVERIFY_URL } from '../../server/lib/turnstile.ts'
import type { RecordingStore, SiteServices } from '../../server/lib/services.ts'
import { TraceCache } from '../../server/lib/trace-cache.ts'

/** The keys a test site and its mock back end share. */
export interface TestKeys {
  // The site's private key as JWK text (NUXT_LB_WEB_SIGNING_KEY), and its public half (LB_WEB_TOKEN_KEY).
  siteJwk: string
  sitePublic: string
  // The `web` service's private key as JWK text (NUXT_LB_GATEWAY_SERVICE_KEY), and its public half.
  webJwk: string
  webPublic: string
}

/** Makes fresh keys, so no test depends on a key in the repository. */
export function makeTestKeys(): TestKeys {
  const site = generateKeyPairSync('ed25519')
  const web = generateKeyPairSync('ed25519')
  return {
    siteJwk: JSON.stringify(site.privateKey.export({ format: 'jwk' })),
    sitePublic: site.publicKey.export({ format: 'jwk' }).x ?? '',
    webJwk: JSON.stringify(web.privateKey.export({ format: 'jwk' })),
    webPublic: web.publicKey.export({ format: 'jwk' }).x ?? '',
  }
}

/** What Turnstile's fake answers: a verdict, or no answer at all. */
export interface FakeTurnstile {
  // What the next checks answer; `down` makes Cloudflare unreachable.
  answer: 'pass' | 'pass-with-host' | 'fail' | 'down' | 'wrong-host'
  // The tokens it was asked about, oldest first.
  seen: string[]
}

/** What a test site is built from. */
export interface TestSiteOptions {
  keys: TestKeys
  // The mock back end's URL, which serves both the API and the gateway's route.
  backendUrl: string
  // Settings to override, as the runtime config holds them.
  config?: Partial<RawRuntimeConfig>
  // The recordings the site has, by `<system>/<sample>`.
  recordings?: Record<string, unknown>
  // Whether the deployment has no back end configured at all.
  disabled?: boolean
  // The clock to share with the mock back end, in Unix milliseconds: the back end must see the same moment the site stamps its tokens with.
  clock?: { now: number }
  // Limits to use instead of the real ones, by system: a test shortens a deadline to wait less.
  policies?: Partial<Record<'lb-01' | 'lb-02' | 'lb-05' | 'lb-08', Partial<SystemPolicy>>>
}

/** A running test site. */
export interface TestSite {
  // Where it listens, such as http://127.0.0.1:43212.
  url: string
  // Its origin, which is what a same-site request names in its Origin header.
  origin: string
  services: SiteServices
  turnstile: FakeTurnstile
  // The clock, in Unix milliseconds. Assign to it to move time.
  clock: { now: number }
  close: () => Promise<void>
}

/** Loads the default export of a handler's module. */
async function loadHandler(file: string): Promise<EventHandler> {
  const module = await import(new URL(`../../server/${file}`, import.meta.url).href) as { default: EventHandler }
  return module.default
}

/** Makes the recordings the site has from a plain object of `<system>/<sample>` to value. */
function recordingStore(files: Record<string, unknown>): RecordingStore {
  return {
    list: async system => Object.keys(files).filter(key => key.startsWith(`${system}/`)).map(key => key.slice(system.length + 1)),
    read: async (system, sample) => files[`${system}/${sample}`],
  }
}

/** Starts the site's server, on the loopback address, against a mock back end. */
export async function startTestSite(options: TestSiteOptions): Promise<TestSite> {
  const turnstile: FakeTurnstile = { answer: 'pass', seen: [] }
  const clock = options.clock ?? { now: Date.UTC(2026, 9, 5, 9, 0, 0) }
  const raw: RawRuntimeConfig = {
    lbApiUrl: options.backendUrl,
    lbGatewayUrl: options.backendUrl,
    lbWebSigningKey: options.keys.siteJwk,
    lbGatewayServiceKey: options.keys.webJwk,
    lbSessionSecret: randomBytes(32).toString('hex'),
    turnstileSecretKey: 'turnstile-secret-for-tests',
    public: { turnstileSiteKey: 'site-key-for-tests' },
    ...options.config,
  }
  // Calls to Cloudflare go to the fake; everything else (the mock back end) goes over the network.
  const fakeFetch: typeof fetch = async (input, init) => {
    const target = input instanceof Request ? input.url : String(input)
    if (!target.startsWith(SITEVERIFY_URL)) return fetch(input, init)
    turnstile.seen.push(new URLSearchParams(String(init?.body ?? '')).get('response') ?? '')
    if (turnstile.answer === 'down') throw new TypeError('fetch failed')
    const hostnames = { 'pass': undefined, 'pass-with-host': '127.0.0.1', 'wrong-host': 'elsewhere.example', 'fail': undefined }
    return Response.json({ success: turnstile.answer !== 'fail', hostname: hostnames[turnstile.answer] })
  }
  const services: SiteServices = {
    state: options.disabled ? { status: 'disabled' } : loadSiteState(raw, true, () => clock.now),
    fetch: fakeFetch,
    now: () => clock.now,
    random: bytes => randomBytes(bytes),
    policies: Object.fromEntries(Object.entries(SYSTEM_POLICIES).map(([system, policy]) => [system, { ...policy, ...options.policies?.[system as keyof typeof SYSTEM_POLICIES] }])) as typeof SYSTEM_POLICIES,
    recordings: recordingStore(options.recordings ?? {}),
    traces: new TraceCache(() => clock.now),
  }

  const app = createApp()
  app.use(defineEventHandler((event) => {
    event.context.lbSite = services
  }))
  const router = createRouter()
  for (const route of SERVER_ROUTES) {
    const handler = await loadHandler(route.handler)
    if (route.method) router.use(route.route, handler, route.method)
    else router.use(route.route, handler)
  }
  app.use(router)
  const server: Server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    origin: url,
    services,
    turnstile,
    clock,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
