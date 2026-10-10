// POST /api/session/verify: the visitor's Turnstile token, checked with Cloudflare. Passing marks
// the session as verified for the rest of the day, in the signed cookie, so the check runs once
// before a visitor's first AI run and never again until tomorrow (docs/SECURITY.md, section 2).
// The token is single-use: it goes to Cloudflare and is kept nowhere.
import { getRequestURL } from 'h3'

import { defineApiHandler } from '../lib/api.ts'
import { readJsonBody } from '../lib/body.ts'
import { problems } from '../lib/errors.ts'
import { requireConfig } from '../lib/services.ts'
import { sessionsOf, stateOf } from '../lib/sessions.ts'
import { verifyTurnstile } from '../lib/turnstile.ts'
import { verifyRequestSchema } from '../../shared/schema/session.ts'

// A Turnstile token is about a kilobyte; nothing honest comes near this.
const MAX_BODY_BYTES = 4_096

/** Checks the token the browser's widget made, and marks the session verified when Cloudflare says it is real. */
export default defineApiHandler(async (event, site) => {
  const config = requireConfig(site)
  const body = await readJsonBody(event, MAX_BODY_BYTES)
  const request = verifyRequestSchema.safeParse(body.value)
  if (!request.success) throw problems.invalidRequest('Send the Turnstile token as {"token": "..."}.')

  const verdict = await verifyTurnstile(request.data.token, {
    secret: config.turnstileSecretKey,
    hostname: getRequestURL(event, { xForwardedHost: true }).hostname,
    fetch: site.fetch,
  })
  if (verdict === 'unavailable') throw problems.unavailable()
  if (verdict === 'failed') throw problems.verificationFailed()

  const sessions = sessionsOf(site)
  return stateOf(site, sessions.markVerified(event, sessions.ensure(event)))
})
