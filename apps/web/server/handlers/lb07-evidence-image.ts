// GET /api/lb07/runs/:runId/evidence/:evidenceId/image: one screenshot of an LB-07 run, as a picture on the
// site's own origin, so the board shows it with a plain `<img src>` and the page's policy needs nothing
// beyond `img-src 'self'`. The service sends a screenshot as base64 inside JSON (GET
// /api/lb07/runs/{id}/evidence/{evidenceId}, a documented route); this asks for it exactly as the proxy
// would, as the visitor (a token for lb-07 alone, made from the visitor's session), so a run that is not the
// visitor's, is gone or is past its hour answers the service's own 404. What comes back must fit the
// evidence schema, be a screenshot, decode cleanly, be no larger than the service keeps and start with
// the PNG signature; anything else is a 502, and a snapshot (text, not a picture) is a 404. The picture is
// answered as `image/png`, never sniffed, never kept.
import { matchRoute } from '@lb/api-clients/routes'
import { mintVisitorToken } from '@lb/common/visitors'
import { lb07EvidenceViewSchema } from '@lb/contracts'
import { getRouterParam } from 'h3'

import { screenshotBytes } from '../../shared/lb07-evidence.ts'
import { defineApiHandler } from '../lib/api.ts'
import type { RawAnswer } from '../lib/api.ts'
import { ApiError, problems } from '../lib/errors.ts'
import { requireConfig } from '../lib/services.ts'
import { sessionsOf } from '../lib/sessions.ts'
import { callService } from '../lib/upstream.ts'

// A run's id and an evidence's, as the service's routes accept them.
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EVIDENCE_ID = /^e\d{1,3}$/

/** Reads the service's answer as a screenshot's bytes, or says why it cannot be shown. */
function pictureOf(body: string | undefined): Uint8Array {
  let json: unknown
  try {
    json = JSON.parse(body ?? '')
  }
  catch {
    throw problems.upstreamFailed()
  }
  const evidence = lb07EvidenceViewSchema.safeParse(json)
  if (!evidence.success) throw problems.upstreamFailed()
  if (evidence.data.kind !== 'screenshot') throw new ApiError(404, 'not_a_picture', 'This piece of evidence is text, not a picture.')
  const bytes = screenshotBytes(evidence.data.base64)
  if (!bytes) throw problems.upstreamFailed()
  return bytes
}

/** Answers one screenshot of the visitor's own run as a PNG. */
export default defineApiHandler(async (event, site): Promise<RawAnswer> => {
  const config = requireConfig(site)
  const runId = getRouterParam(event, 'runId') ?? ''
  const evidenceId = getRouterParam(event, 'evidenceId') ?? ''
  if (!RUN_ID.test(runId) || !EVIDENCE_ID.test(evidenceId)) throw problems.notFound()
  const matched = matchRoute('GET', `/api/lb07/runs/${runId}/evidence/${evidenceId}`)
  if (!matched || matched.route.system !== 'lb-07') throw problems.notFound()
  const sessions = sessionsOf(site)
  const session = sessions.ensure(event)
  const policy = site.policies['lb-07']
  const token = mintVisitorToken(config.signingKey, { system: 'lb-07', sessionKey: sessions.subjectOf(session) }, site.now() / 1_000)
  const answer = await callService({
    method: 'GET',
    origin: config.apiUrl,
    path: matched.route.path.replace('{id}', encodeURIComponent(runId)).replace('{evidenceId}', encodeURIComponent(evidenceId)),
    query: [],
    token,
    timeoutMs: policy.timeoutMs,
    maxResponseBytes: policy.maxResponseBytes,
    fetch: site.fetch,
  })
  // A refusal of the service's (someone else's run, a run that is gone) goes back as the service said it.
  if (answer.status !== 200) return { status: answer.status, body: answer.body, headers: answer.headers }
  return { status: 200, body: undefined, file: { bytes: pictureOf(answer.body), contentType: 'image/png' } }
})
