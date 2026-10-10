// Cloudflare Turnstile, checked on the server: before a visitor's first AI run the browser's
// invisible widget makes a token, and this asks Cloudflare whether it is real (docs/SECURITY.md,
// section 2). A token is single-use and short-lived, so a visitor passes once a day and the
// result is kept in the signed session, never in the browser's hands.
//
// The end-to-end test build also accepts one fixed stand-in token, so the journeys need no
// Cloudflare. That branch sits behind `__LB_TEST_BUILD__`, which every other build replaces with
// `false`: it is not in a production bundle, and CI proves it.
import { z } from 'zod'

import { TEST_TURNSTILE_STAND_IN } from '../../shared/turnstile-stand-in.ts'

// Where Cloudflare checks a token, and how long to wait for it before the check counts as unavailable.
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const SITEVERIFY_TIMEOUT_MS = 5_000

// What Cloudflare answers: whether the token is good, and the hostname it was solved on.
const siteverifySchema = z.object({
  success: z.boolean(),
  hostname: z.string().max(253).optional(),
})

/** How a token check came out: the token is good, it is not, or Cloudflare could not be asked. */
export type TurnstileVerdict = 'passed' | 'failed' | 'unavailable'

/** What the check needs besides the token: the secret, the site's hostname, and a way to call out. */
export interface TurnstileCheck {
  secret: string
  // The hostname the visitor is on. A token solved on another site is refused.
  hostname: string
  fetch: typeof fetch
}

/**
 * Asks Cloudflare whether a Turnstile token is real. Fails closed: an answer that is not
 * understood, or Cloudflare not answering in time, never passes. The token and the secret are
 * sent in the request body and appear in no message.
 */
export async function verifyTurnstile(token: string, check: TurnstileCheck): Promise<TurnstileVerdict> {
  if (__LB_TEST_BUILD__ && token === TEST_TURNSTILE_STAND_IN) return 'passed'
  let response: Response
  try {
    response = await check.fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: check.secret, response: token }),
      redirect: 'manual',
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    })
  }
  catch {
    return 'unavailable'
  }
  if (!response.ok) return 'unavailable'
  const parsed = siteverifySchema.safeParse(await response.json().catch(() => undefined))
  if (!parsed.success) return 'unavailable'
  if (!parsed.data.success) return 'failed'
  // Cloudflare says which hostname the token was solved on; when it says, it must be this site's.
  return parsed.data.hostname === undefined || parsed.data.hostname === check.hostname ? 'passed' : 'failed'
}
