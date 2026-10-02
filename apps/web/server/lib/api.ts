// How every handler of the site's API is made: `defineApiHandler` wraps its work so that no
// handler can forget what every one needs. Every answer is marked uncacheable (unless the handler
// says its answer is the same for everyone), a request that changes something must come from
// this site (the Origin check), and every failure, expected or not, leaves in the platform's
// error shape. An unexpected error is logged by its name and the route, never its message or its
// stack, which may quote what a visitor wrote, and the visitor sees a generic 500.
import { defineEventHandler, send, setResponseHeader, setResponseStatus } from 'h3'
import type { H3Event } from 'h3'

import { ApiError, problems } from './errors.ts'
import { assertSameOrigin } from './origin.ts'
import { servicesOf } from './services.ts'
import type { SiteServices } from './services.ts'

/** What a handler may return: a value to send as JSON, or an answer it has already written (a status and a body). */
export interface RawAnswer {
  status: number
  body: string | undefined
  headers?: Record<string, string>
}

/** Options for one handler. */
export interface ApiHandlerOptions {
  // The Cache-Control of its answers. Uncacheable unless the answer is the same for every visitor.
  cache?: string
}

/** Tells whether a handler's result is an answer it wrote itself. */
function isRawAnswer(value: unknown): value is RawAnswer {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value && !Array.isArray(value)
}

/** Writes an error in the platform's shape. */
async function sendError(event: H3Event, error: ApiError): Promise<void> {
  for (const [name, value] of Object.entries(error.headers)) setResponseHeader(event, name, value)
  setResponseHeader(event, 'cache-control', 'no-store')
  setResponseStatus(event, error.status)
  await send(event, JSON.stringify(error.toBody()), 'application/json; charset=utf-8')
}

/** Logs an unexpected failure as one line of JSON: the route and the error's name, nothing a visitor wrote. */
function logUnexpected(event: H3Event, error: unknown): void {
  console.error(JSON.stringify({ event: 'api_error', route: new URL(event.path, 'http://site.local').pathname, error: error instanceof Error ? error.name : 'unknown' }))
}

/**
 * Makes an event handler for the site's API. The handler gets the request's services and returns
 * the value to answer with (sent as JSON), or a RawAnswer for an answer it has already shaped
 * (a proxied one). Throw an ApiError to answer with an error.
 */
export function defineApiHandler(handler: (event: H3Event, site: SiteServices) => Promise<unknown> | unknown, options: ApiHandlerOptions = {}) {
  return defineEventHandler(async (event) => {
    try {
      setResponseHeader(event, 'cache-control', options.cache ?? 'no-store')
      assertSameOrigin(event)
      const result = await handler(event, servicesOf(event))
      if (!isRawAnswer(result)) return result
      for (const [name, value] of Object.entries(result.headers ?? {})) setResponseHeader(event, name, value)
      setResponseStatus(event, result.status)
      return result.body === undefined ? send(event, '') : send(event, result.body, 'application/json; charset=utf-8')
    }
    catch (error) {
      if (error instanceof ApiError) return sendError(event, error)
      logUnexpected(event, error)
      return sendError(event, problems.internal())
    }
  })
}
