// Logging for the Node systems: pino, configured so a log line can never hold what a
// visitor wrote. Request bodies and headers are never logged, a request is recorded as its
// method and path only (no query, no address), and an error is reduced to its type and its
// stack frames, because an error's message can quote the text that caused it.
import { pino } from 'pino'
import type { Logger, LoggerOptions } from 'pino'

import { describeError } from './errors.ts'

/** The log levels pino knows. */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

/** What a request is logged as: what was asked for, never who asked or what they sent. */
function serializeRequest(request: { method?: string, url?: string, id?: string }): { method: string | undefined, path: string, id: string | undefined } {
  return { method: request.method, path: (request.url ?? '').split('?')[0] ?? '', id: request.id }
}

/** Builds pino's options: the level, and the serializers and redactions that keep visitor text out of every line. */
export function loggerOptions(level: LogLevel): LoggerOptions {
  return {
    level,
    // A second line of defence: if a header ever reaches a log, its secret parts don't.
    redact: { paths: ['req.headers.authorization', 'headers.authorization', 'authorization'], censor: '[redacted]' },
    serializers: {
      req: serializeRequest,
      res: (response: { statusCode?: number }) => ({ statusCode: response.statusCode }),
      err: describeError,
    },
  }
}

/** Builds the logger the worker and the command-line tools use; the API's own is Fastify's, from the same options. */
export function createLogger(level: LogLevel): Logger {
  return pino(loggerOptions(level))
}
