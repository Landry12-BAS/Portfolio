// What the site's server and the visitor's browser say to each other about the anonymous session
// and the one token the browser needs for itself. The server builds these answers with the
// schemas and the browser reads them with the same ones (docs/SECURITY.md, section 2).
import { z } from 'zod'

/** What the browser needs to know about the visitor's session before a demo can spend quota. */
export const sessionStateSchema = z.strictObject({
  // False when this deployment has no back end (a preview, or a site not yet configured): the demos stay off and say so.
  available: z.boolean(),
  // Whether the visitor has passed the invisible Turnstile check, which holds for the rest of the day.
  verified: z.boolean(),
  // The Turnstile site key the widget needs, or null in the test build, which has no widget.
  siteKey: z.string().min(1).max(100).nullable(),
  // True only in the end-to-end test build, where the browser sends a fixed token in place of Turnstile's.
  testMode: z.boolean(),
  // When the session and the visitor's daily quotas turn over: the next midnight, UTC.
  resetsAt: z.iso.datetime(),
})

/** The visitor's Turnstile token, sent to be checked. A real token is under 2,048 characters. */
export const verifyRequestSchema = z.strictObject({
  token: z.string().min(1).max(2_048),
})

/** A short-lived token for the one thing the browser does directly: LB-02's and LB-09's WebSockets. */
export const socketGrantSchema = z.strictObject({
  system: z.enum(['lb-02', 'lb-09']),
  // Goes in the connection's first frame, never in the address.
  token: z.string().min(1).max(1_024),
  expiresAt: z.iso.datetime(),
  // Where to open the connection: the API's own address, with the `ws:` or `wss:` scheme.
  socketUrl: z.string().min(1).max(300),
})

/** The visitor's session, as the browser is told of it. */
export type SessionState = z.infer<typeof sessionStateSchema>
/** The token for a system's WebSocket, and where to open it. */
export type SocketGrant = z.infer<typeof socketGrantSchema>
