// GET /api/recordings/:system/:sample: one recording, for the replay player. It is read from the
// site's own bundled files and checked with its schema before it is sent, and a recording that
// was not made on the live back end is never sent.
import { getRouterParam } from 'h3'

import { defineApiHandler } from '../../lib/api.ts'
import { problems } from '../../lib/errors.ts'
import { SAMPLE_NAME, SYSTEM_NAME, showableRecording } from '../../lib/recordings.ts'

/** Sends one recording, or a 404 when there is none a visitor may be shown. */
export default defineApiHandler(async (event, site) => {
  const system = getRouterParam(event, 'system') ?? ''
  const sample = getRouterParam(event, 'sample') ?? ''
  if (!SYSTEM_NAME.test(system) || !SAMPLE_NAME.test(sample)) throw problems.notFound()
  const recording = await showableRecording(site, system, sample)
  if (!recording) throw problems.notFound()
  return recording
}, { cache: 'public, max-age=300' })
