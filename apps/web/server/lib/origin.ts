// The Origin check on every state-changing request (docs/SECURITY.md, section 3, CSRF). The
// session cookie is already `SameSite=Strict`, so a page on another site can't make a browser send
// it; this is the second line: a request that changes anything must say, in the Origin header a
// browser always sends with a POST, PUT or DELETE, that it comes from this very site. A request
// with no Origin, an Origin of `null` or one from elsewhere is refused. No CORS header is ever
// sent, so no other site can read an answer either.
import { getRequestHeader, getRequestURL } from 'h3'
import type { H3Event } from 'h3'

import { problems } from './errors.ts'

// The methods that change nothing, and so need no Origin.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Throws a 403 unless the request is a read, or says it comes from this site. The site's own
 * origin is the one the request was made to (the host and scheme a proxy such as Vercel's
 * reports), so the check needs no setting and can't be wrong about a preview's address.
 */
export function assertSameOrigin(event: H3Event): void {
  if (SAFE_METHODS.has(event.method.toUpperCase())) return
  const origin = getRequestHeader(event, 'origin')
  if (!origin) throw problems.forbiddenOrigin()
  // A browser says which kind of request this is. Anything but one from this very origin is refused,
  // even when the Origin header seems to fit.
  const fetchSite = getRequestHeader(event, 'sec-fetch-site')
  if (fetchSite !== undefined && fetchSite !== 'same-origin') throw problems.forbiddenOrigin()
  let claimed: string
  try {
    claimed = new URL(origin).origin
  }
  catch {
    throw problems.forbiddenOrigin()
  }
  const own = getRequestURL(event, { xForwardedHost: true, xForwardedProto: true }).origin
  if (claimed !== own || claimed === 'null') throw problems.forbiddenOrigin()
}
