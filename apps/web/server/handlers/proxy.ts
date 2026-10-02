// /api/lb01/**, /api/lb02/**, /api/lb05/**, /api/lb08/** and /api/lb03/**: the visitor's browser calls the site's
// own server at the same paths the back ends use, and this forwards the call, as the visitor, to
// the back end (docs/STACK.md, "Backend-for-frontend"). Nothing is forwardable unless the three
// committed OpenAPI documents describe it (packages/api-clients' route table): the method, the
// path with its parameters, and the query names. The steps, in order:
//
//   1. the route must be a documented one (404 otherwise), with a query the route documents;
//   2. a session is started or read, and a request that changes something needs a session that
//      has passed Turnstile (403 otherwise), before a byte of its body is read;
//   3. the body, if the route takes one, is read within the system's limit: JSON is written again,
//      and a file upload (LB-03's, `multipart/form-data`) has its envelope checked and its bytes passed on;
//   4. a visitor token for that one system is made, valid five minutes, whose subject is a keyed
//      hash of the session, and the call is made with a deadline;
//   5. only the answer's status, its JSON body (or, for a route the document says answers with a
//      file, the file) and Retry-After go back.
import { checkQuery, matchRoute } from '@lb/api-clients/routes'
import { mintVisitorToken } from '@lb/common/visitors'
import { getRequestURL } from 'h3'

import { defineApiHandler } from '../lib/api.ts'
import { readJsonBody, readUploadBody } from '../lib/body.ts'
import { problems } from '../lib/errors.ts'
import { requireConfig } from '../lib/services.ts'
import { sessionsOf } from '../lib/sessions.ts'
import { callService } from '../lib/upstream.ts'

/** Fills the `{name}` parameters of a documented path with the values the request carried. */
function fillPath(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(params[name] ?? ''))
}

/** Forwards one documented call to its back end and returns the answer that may be passed on. */
export default defineApiHandler(async (event, site) => {
  const config = requireConfig(site)
  const url = getRequestURL(event)
  const matched = matchRoute(event.method, url.pathname)
  if (!matched) throw problems.notFound()
  const { route, params } = matched
  const query = checkQuery(route, url.searchParams)
  if (!query) throw problems.invalidRequest('The query string is not accepted.')

  const sessions = sessionsOf(site)
  const session = sessions.ensure(event)
  if (route.method !== 'GET' && !session.verified) throw problems.verificationRequired()

  const policy = site.policies[route.system]
  let body: string | Uint8Array<ArrayBuffer> | undefined
  let contentType: string | undefined
  if (route.upload) {
    // A system whose routes take uploads names its limit; one that doesn't has no business with one.
    if (policy.maxUploadBytes === undefined) throw problems.notFound()
    const upload = await readUploadBody(event, policy.maxUploadBytes)
    body = upload.bytes
    contentType = upload.contentType
  }
  else if (route.body) {
    body = (await readJsonBody(event, policy.maxBodyBytes)).text
  }
  const token = mintVisitorToken(config.signingKey, { system: route.system, sessionKey: sessions.subjectOf(session) }, site.now() / 1_000)
  return callService({
    method: route.method,
    origin: config.apiUrl,
    path: fillPath(route.path, params),
    query,
    token,
    body,
    contentType,
    files: route.files,
    timeoutMs: policy.timeoutMs,
    maxResponseBytes: policy.maxResponseBytes,
    fetch: site.fetch,
  })
})
