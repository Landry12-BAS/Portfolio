// POST /api/tokens/lb-02 and /api/tokens/lb-09: the one thing the browser must do directly. A Vercel
// function can't hold a WebSocket, so LB-02's conversation and LB-09's meeting progress connect
// straight to the API's address, and the browser needs a visitor token of its own to say who it is:
// valid five minutes, for that one system only, with the same keyed-hash subject as every other
// token. It goes in the connection's first frame and never in the address, because addresses end up
// in logs (services/django-systems/README.md, "LB-02 WebSocket"). Opening a conversation or a
// meeting spends quota, so the session must have passed Turnstile.
import { mintVisitorToken } from '@lb/common/visitors'
import { getRequestURL } from 'h3'
import { defineApiHandler } from '../lib/api.ts'
import { problems } from '../lib/errors.ts'
import { requireConfig } from '../lib/services.ts'
import { sessionsOf } from '../lib/sessions.ts'
import type { SocketGrant } from '../../shared/schema/session.ts'

// How long the token lives: the most the systems accept (docs/SECURITY.md, section 2).
const LIFETIME_SECONDS = 300

/** The systems with a WebSocket, and where each listens on the API's host (services/django-systems/config/routing.py). */
const SOCKET_PATHS: Readonly<Record<SocketGrant['system'], string>> = {
  'lb-02': '/ws/lb02/',
  'lb-09': '/ws/lb09/',
}

/** Tells whether a name is one of the systems with a WebSocket. */
function isSocketSystem(name: string): name is SocketGrant['system'] {
  return Object.hasOwn(SOCKET_PATHS, name)
}

/** Makes the WebSocket address of the API for a system: its own origin, with `ws:` or `wss:` for the scheme. */
function socketUrl(api: URL, system: SocketGrant['system']): string {
  const url = new URL(SOCKET_PATHS[system], api)
  url.protocol = api.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/** Mints a token for the WebSocket of the system the path names, and says where to open it. */
export default defineApiHandler((event, site): SocketGrant => {
  const system = getRequestURL(event).pathname.split('/').at(-1) ?? ''
  if (!isSocketSystem(system)) throw problems.notFound()
  const config = requireConfig(site)
  const sessions = sessionsOf(site)
  const session = sessions.ensure(event)
  if (!session.verified) throw problems.verificationRequired()
  const issuedAt = site.now() / 1_000
  return {
    system,
    token: mintVisitorToken(config.signingKey, { system, sessionKey: sessions.subjectOf(session) }, issuedAt, LIFETIME_SECONDS),
    expiresAt: new Date((Math.floor(issuedAt) + LIFETIME_SECONDS) * 1_000).toISOString(),
    socketUrl: socketUrl(config.apiUrl, system),
  }
})
