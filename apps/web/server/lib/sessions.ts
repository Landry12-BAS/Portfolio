// Gives each handler the visitors' sessions for the site's settings. The sessions are built once
// for a set of services and remembered, so every request of a running site shares the same keys.
import { Sessions } from './session.ts'
import type { Session } from './session.ts'
import { requireConfig } from './services.ts'
import type { SiteServices } from './services.ts'
import type { SessionState } from '../../shared/schema/session.ts'

// One Sessions object for each set of services: they are made from the settings, which never change while the site runs.
const made = new WeakMap<SiteServices, Sessions>()

/** Returns the sessions of a site that is set up, or answers 503 when it has no back end. */
export function sessionsOf(site: SiteServices): Sessions {
  const existing = made.get(site)
  if (existing) return existing
  const config = requireConfig(site)
  const sessions = new Sessions({ secret: config.sessionSecret, now: site.now, random: site.random })
  made.set(site, sessions)
  return sessions
}

/** Describes a session to the browser: whether the demos are on, whether Turnstile has passed and what widget to show. */
export function stateOf(site: SiteServices, session: Session | undefined): SessionState {
  const resetsAt = new Date(site.now())
  resetsAt.setUTCHours(24, 0, 0, 0)
  if (site.state.status !== 'ready') return { available: false, verified: false, siteKey: null, testMode: false, resetsAt: resetsAt.toISOString() }
  const key = site.state.config.turnstileSiteKey
  return {
    available: true,
    verified: session?.verified ?? false,
    // The test build has no widget: its browser sends the stand-in token instead.
    siteKey: __LB_TEST_BUILD__ || key === '' ? null : key,
    testMode: __LB_TEST_BUILD__,
    resetsAt: resetsAt.toISOString(),
  }
}
