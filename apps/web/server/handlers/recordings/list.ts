// GET /api/recordings/:system: the samples of a system that have a recording a visitor may be
// shown. A system with none answers an empty list, which is how a demo knows to say there is no
// recording and to offer the live run instead. No session is needed: the recordings are the same
// for every visitor, and they change only when the site is deployed.
import { getRouterParam } from 'h3'

import { defineApiHandler } from '../../lib/api.ts'
import { problems } from '../../lib/errors.ts'
import { SYSTEM_NAME, showableSamples } from '../../lib/recordings.ts'

/** Lists a system's recorded samples. */
export default defineApiHandler(async (event, site) => {
  const system = getRouterParam(event, 'system') ?? ''
  if (!SYSTEM_NAME.test(system)) throw problems.notFound()
  return { system, samples: await showableSamples(site, system) }
}, { cache: 'public, max-age=300' })
