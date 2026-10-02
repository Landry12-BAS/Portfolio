// What the server's handlers need from the outside world, gathered in one object so that a test
// can hand them fakes: the validated settings, the clock, a source of randomness, the way out to
// the network, and the recordings of the curated samples. In the running site a small piece of
// middleware (server/middleware/lb-site.ts) builds it once from Nuxt's runtime config and puts
// it on every request's context; a test builds its own.
import type { SystemName } from '@lb/api-clients/routes'
import type { H3Event } from 'h3'

import { problems } from './errors.ts'
import type { SiteConfig, SiteState } from './config.ts'
import type { SystemPolicy } from './policy.ts'
import type { TraceCache } from './trace-cache.ts'

/** Where the recordings of the curated samples are kept, and how to read them. */
export interface RecordingStore {
  // The names of the samples of a system that have a recording, such as `torn-bag`.
  list: (system: string) => Promise<string[]>
  // One recording as stored, or undefined when there is none. The caller checks it with its schema.
  read: (system: string, sample: string) => Promise<unknown>
}

/** Everything a handler may reach for. */
export interface SiteServices {
  state: SiteState
  // The site's one address, which every other host is sent on to; undefined where the site answers on any host.
  siteOrigin: URL | undefined
  // The network. Calls to the back ends and to Turnstile go through it, so tests can watch them.
  fetch: typeof fetch
  // The clock, in Unix milliseconds.
  now: () => number
  // Random bytes: the stuff session IDs are made of.
  random: (bytes: number) => Buffer
  // How big a request may be and how long each system has to answer. A test shortens the deadlines.
  policies: Readonly<Record<SystemName, SystemPolicy>>
  recordings: RecordingStore
  // The pages of traces the gateway sent a moment ago, so the Scope's route asks for each at most once a second.
  traces: TraceCache
}

declare module 'h3' {
  /** The context of a request, plus the services the site's middleware attached to it. */
  interface H3EventContext {
    lbSite?: SiteServices
  }
}

/** Returns the services of this request, or answers 503 when the middleware did not attach any. */
export function servicesOf(event: H3Event): SiteServices {
  const services = event.context.lbSite
  if (!services) throw problems.unavailable()
  return services
}

/** Returns the settings of a site that is set up, or answers 503 when this deployment has no back end. */
export function requireConfig(services: SiteServices): SiteConfig {
  if (services.state.status !== 'ready') throw problems.unavailable()
  return services.state.config
}
