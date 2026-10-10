// The site's first middleware: sends every host but the site's own address on to it, and attaches the
// site's services to every request for the API, so the handlers can reach the settings, the clock and the
// network through the request alone (and tests can give them fakes). Page requests need none of the
// services and are left alone. The decisions are in server/lib/site-middleware.ts, which the tests run too.
import { nitroServices } from '../lib/nitro-services.ts'
import { siteMiddleware } from '../lib/site-middleware.ts'

export default siteMiddleware(nitroServices)
