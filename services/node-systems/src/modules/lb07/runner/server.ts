// The runner's HTTP API: a plain node:http server the service's worker calls to open a session, run a
// step, read the page's snapshot or screenshot, run axe and close the session. It listens only on the
// sandbox network (src/sandbox.ts), carries the bug token without signing it, and every body it reads
// is checked against protocol.ts before anything touches the browser.
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import type { z } from 'zod'

import { axeResponseSchema, closeResponseSchema, healthResponseSchema, openSessionRequestSchema, openSessionResponseSchema, screenshotResponseSchema, snapshotResponseSchema, stepRequestSchema, stepResponseSchema } from './protocol.ts'
import type { BrowserSessions } from './session.ts'
import { SessionError } from './session.ts'

// The largest body the runner reads: a step, or a session request with its token.
const MAX_BODY_BYTES = 8_192

/** Reads a small JSON body, or undefined when it is too large or not JSON. */
function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        request.destroy()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      }
      catch {
        resolve(undefined)
      }
    })
    request.on('error', () => resolve(undefined))
  })
}

/** Writes a JSON answer. */
function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(body))
}

/** Writes the runner's error body. */
function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  send(response, status, { error: { code, message } })
}

/** Checks an answer against its schema before it leaves, so a bug in the runner never sends the service something it did not plan for. */
function checked<Schema extends z.ZodType>(schema: Schema, value: z.input<Schema>): z.output<Schema> {
  return schema.parse(value)
}

/** What the server tells its process when the runner is exhausted, so the process can exit for a fresh start. */
export type OnExhausted = () => void

/** Builds the runner's server over a set of sessions. */
export function createRunnerServer(sessions: BrowserSessions, onExhausted: OnExhausted = () => {}): Server {
  /** Answers one request. */
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://runner.invalid')
    const method = request.method ?? 'GET'
    const path = url.pathname

    if (method === 'GET' && path === '/healthz') {
      return send(response, 200, checked(healthResponseSchema, { ok: true, busy: sessions.busy, runsServed: sessions.runsServed, exhausted: sessions.exhausted }))
    }
    if (method === 'POST' && path === '/sessions') {
      const body = openSessionRequestSchema.safeParse(await readJson(request))
      if (!body.success) return sendError(response, 422, 'invalid_request', 'The session request does not follow its schema.')
      const sessionId = await sessions.open(body.data)
      return send(response, 201, checked(openSessionResponseSchema, { sessionId }))
    }
    const match = /^\/sessions\/([\w-]{8,64})(?:\/(steps|snapshot|screenshot|axe))?$/.exec(path)
    if (!match) return sendError(response, 404, 'not_found', 'There is nothing at this address.')
    const id = match[1] ?? ''
    const part = match[2]

    if (method === 'POST' && part === 'steps') {
      const body = stepRequestSchema.safeParse(await readJson(request))
      if (!body.success) return sendError(response, 422, 'invalid_request', 'The step does not follow the plan vocabulary.')
      const result = await sessions.step(id, body.data.index, body.data.step)
      return send(response, 200, checked(stepResponseSchema, result))
    }
    if (method === 'GET' && part === 'snapshot') return send(response, 200, checked(snapshotResponseSchema, await sessions.snapshot(id)))
    if (method === 'GET' && part === 'screenshot') return send(response, 200, checked(screenshotResponseSchema, await sessions.screenshot(id)))
    if (method === 'POST' && part === 'axe') {
      const body = await readJson(request)
      const index = typeof body === 'object' && body !== null && typeof (body as { index?: unknown }).index === 'number' ? Math.max(0, Math.floor((body as { index: number }).index)) : null
      return send(response, 200, checked(axeResponseSchema, await sessions.axe(id, index)))
    }
    if (method === 'DELETE' && part === undefined) {
      const closed = await sessions.close(id)
      send(response, 200, checked(closeResponseSchema, closed))
      if (sessions.exhausted) onExhausted()
      return
    }
    return sendError(response, 405, 'method_not_allowed', 'This address does not take that method.')
  }

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end()
        return
      }
      if (error instanceof SessionError) return sendError(response, error.status, error.code, error.message)
      sendError(response, 500, 'runner_error', 'The runner could not do that.')
    })
  })
}
