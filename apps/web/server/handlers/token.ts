// POST /api/tokens/lb-02: the one thing the browser must do directly. A Vercel function can't hold
// a WebSocket, so LB-02's conversation connects straight to the API's address, and the browser
// needs a visitor token of its own to say who it is: valid five minutes, for LB-02 only, with the
// same keyed-hash subject as every other token. It goes in the connection's first frame and
// never in the address, because addresses end up in logs (services/django-systems/README.md,
// "LB-02 WebSocket"). Opening a conversation spends quota, so the session must have passed Turnstile.
import { mintVisitorToken } from '@lb/common/visitors'

import { defineApiHandler } from '../lib/api.ts'
import { problems } from '../lib/errors.ts'
import { requireConfig } from '../lib/services.ts'
import { sessionsOf } from '../lib/sessions.ts'
import type { SocketGrant } from '../../shared/schema/session.ts'

// How long the token lives: the most the systems accept (docs/SECURITY.md, section 2).
const LIFETIME_SECONDS = 300
// Where LB-02's conversation listens on the API's host (services/django-systems/README.md).
const SOCKET_PATH = '/ws/lb02/'

/** Makes the WebSocket address of the API at a path: its own origin, with `ws:` or `wss:` for the scheme. */
function socketUrl(api: URL, path: string): string {
  const url = new URL(path, api)
  url.protocol = api.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/** Makes the handler that mints a token for one system's WebSocket at a path of the API, and says where to open it. LB-06's handler (token-lb06.ts) is made the same way. */
export function socketGrantHandler(system: SocketGrant['system'], path: string) {
  return defineApiHandler((event, site): SocketGrant => {
    const config = requireConfig(site)
    const sessions = sessionsOf(site)
    const session = sessions.ensure(event)
    if (!session.verified) throw problems.verificationRequired()
    const issuedAt = site.now() / 1_000
    return {
      system,
      token: mintVisitorToken(config.signingKey, { system, sessionKey: sessions.subjectOf(session) }, issuedAt, LIFETIME_SECONDS),
      expiresAt: new Date((Math.floor(issuedAt) + LIFETIME_SECONDS) * 1_000).toISOString(),
      socketUrl: socketUrl(config.apiUrl, path),
    }
  })
}

/** Mints a token for LB-02's WebSocket, and says where to open it. */
export default socketGrantHandler('lb-02', SOCKET_PATH)
