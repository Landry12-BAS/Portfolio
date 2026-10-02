// GET /api/session: what the browser needs to know about the visitor's session before a demo can
// spend quota: whether the demos are on in this deployment, whether Turnstile has passed, and
// which widget to show. The first call starts the session (and sets its cookie, the only one the
// site ever sets); a deployment with no back end sets nothing and says its demos are off.
import { defineApiHandler } from '../lib/api.ts'
import { sessionsOf, stateOf } from '../lib/sessions.ts'

/** Answers with the visitor's session state, starting the session when there is none. */
export default defineApiHandler((event, site) => {
  if (site.state.status !== 'ready') return stateOf(site, undefined)
  return stateOf(site, sessionsOf(site).ensure(event))
})
