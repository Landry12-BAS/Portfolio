// The shape of one entry in the table of routes the site may forward. The table itself is
// generated (generated/routes.ts); this file only says what an entry is, so the generator, the
// matcher and the site agree.

/** A demo system the site calls on a visitor's behalf, named as a visitor token's audience. */
export type SystemName = 'lb-01' | 'lb-02' | 'lb-05' | 'lb-08' | 'lb-03' | 'lb-04'

/** The back end that serves a system: the OpenAPI document its route came from. */
export type ServiceName = 'django' | 'flask' | 'node'

/** The HTTP methods the site forwards. */
export type ForwardedMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/** One route a back end documents, and the site's server may forward. */
export interface ApiRoute {
  system: SystemName
  service: ServiceName
  method: ForwardedMethod
  // The path as the document writes it, such as `/api/lb01/tickets/{ticket_id}`.
  path: string
  // The names of the query parameters the route accepts, sorted. No other is forwarded.
  query: readonly string[]
  // Whether the route takes a request body.
  body: boolean
  // Whether that body is a file upload (`multipart/form-data`) and not JSON. Absent for JSON.
  upload?: boolean
  // The media types of the files the route may answer with in place of JSON, sorted, such as
  // `image/jpeg` for a page's picture. Absent for a route that only ever answers JSON.
  files?: readonly string[]
}
