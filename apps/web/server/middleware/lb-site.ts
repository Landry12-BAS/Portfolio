// Attaches the site's services to every request for the API, so the handlers can reach the
// settings, the clock and the network through the request alone (and tests can give them fakes).
// Page requests are left alone: they need none of it.
import { defineEventHandler } from 'h3'

import { nitroServices } from '../lib/nitro-services.ts'

/** Puts the services on the context of a request for /api/. */
export default defineEventHandler((event) => {
  if (event.path.startsWith('/api/')) event.context.lbSite = nitroServices()
})
