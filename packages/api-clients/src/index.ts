// @lb/api-clients: typed clients for the back ends' APIs, generated from their committed OpenAPI
// documents (`pnpm --filter @lb/api-clients generate`; `pnpm check` fails when they are stale).
//
// The site's browser calls its own server at the same paths the back ends use (the server
// forwards them, `./routes` says which), so these clients take no base URL by default:
//
//   const { django } = createApiClients()
//   const { data, error } = await django.GET('/api/lb01/tickets/{ticket_id}', { params: { path: { ticket_id } } })
//
// Nothing here validates what comes back: the answer's type is what the document says, and
// the code that uses it checks it with its own Zod schema (docs/STACK.md, "Zod at every boundary").
import createClient from 'openapi-fetch'
import type { Client, ClientOptions } from 'openapi-fetch'

import type { paths as DjangoPaths } from './generated/django.ts'
import type { paths as FlaskPaths } from './generated/flask.ts'
import type { paths as NodePaths } from './generated/node.ts'

export type { components as DjangoComponents, paths as DjangoPaths } from './generated/django.ts'
export type { components as FlaskComponents, paths as FlaskPaths } from './generated/flask.ts'
export type { components as NodeComponents, paths as NodePaths } from './generated/node.ts'

/** One typed client for each back end. */
export interface ApiClients {
  // LB-01 and LB-02.
  django: Client<DjangoPaths>
  // LB-05.
  flask: Client<FlaskPaths>
  // LB-08.
  node: Client<NodePaths>
}

/**
 * Makes the three clients with the same options: pass `fetch` to send the requests somewhere
 * else (a test's fake server), or `baseUrl` to call a server on another origin. Cookies and
 * the visitor's session travel with same-origin requests by the browser's own rules.
 */
export function createApiClients(options: ClientOptions = {}): ApiClients {
  return {
    django: createClient<DjangoPaths>(options),
    flask: createClient<FlaskPaths>(options),
    node: createClient<NodePaths>(options),
  }
}
