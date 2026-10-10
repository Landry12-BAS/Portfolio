// What the gateway puts in its request log. A run's ID is the only key to its trace (routes/runs.ts),
// so a line of the log must not carry it. Fastify's own request serializer writes the whole URL, and
// for a trace read the URL holds the ID: anyone who can read the log could then read the trace. This
// serializer writes the same fields with the ID left out, and `redactingLogger` puts it into any
// logger the gateway is built with, so the promise holds however the log is set up.
import type { FastifyRequest, FastifyServerOptions } from 'fastify'

// What a run's ID is replaced by in a logged URL.
const RUN_ID_PLACEHOLDER = ':runId'
// The path segment after `runs`, up to the next slash, question mark or hash.
const RUN_SEGMENT = /(\/runs\/)[^/?#]*/g

/** Writes a URL for the log: whatever follows `/runs/` in its path is replaced, and nothing else changes. */
export function redactRunId(url: string): string {
  return url.replace(RUN_SEGMENT, `$1${RUN_ID_PLACEHOLDER}`)
}

/**
 * Describes a request for the log: its method, its URL without a run's ID, the host it was sent to and
 * who sent it. These are the fields Fastify's own serializer writes, less the run's ID and the
 * `accept-version` header: a request log carries no headers.
 */
export function serializeRequest(request: FastifyRequest): { method: string, url: string, host: string, remoteAddress: string, remotePort: number | undefined } {
  return {
    method: request.method,
    url: redactRunId(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  }
}

/**
 * Gives a logger's options the serializer above, whatever else they hold, and replaces any request
 * serializer they came with. A logger that is off stays off.
 */
export function redactingLogger(logger: FastifyServerOptions['logger']): FastifyServerOptions['logger'] {
  if (logger === undefined || logger === false) return false
  const options = logger === true ? {} : logger
  return { ...options, serializers: { ...options.serializers, req: serializeRequest } }
}
