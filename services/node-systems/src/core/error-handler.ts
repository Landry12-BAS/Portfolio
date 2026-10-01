// JSON answers for every error, so the API never serves an HTML error page and never
// repeats what was sent. Every answer has the platform's shape, `{"error": {"code",
// "message"}}`, the same as services/django-systems/core/views.py.
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod'
import type { FastifyError, FastifyInstance } from 'fastify'

import { AppError, errorBody } from './errors.ts'

// Fastify's own client errors, mapped to the platform's stable codes.
const CLIENT_ERROR_CODES: Readonly<Record<string, { status: number, code: string, message: string }>> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'payload_too_large', message: 'The request body is too large.' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: 'unsupported_media_type', message: 'Send the body as application/json.' },
  FST_ERR_CTP_INVALID_JSON_BODY: { status: 400, code: 'invalid_json', message: 'The body isn\'t valid JSON.' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: 'invalid_json', message: 'The body isn\'t valid JSON.' },
}

/** Names the fields at fault in a validation error, such as `body.description`, without their values. */
function faultyFields(error: FastifyError & { validation: { instancePath: string }[] }): string {
  const where = error.validationContext ?? 'request'
  const fields = error.validation.map(issue => `${where}${issue.instancePath.replaceAll('/', '.')}`.replace(/\.$/, ''))
  return [...new Set(fields)].sort().join(', ')
}

/** Installs the error handler and the not-found handler on the app. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      if (error.details.retryAfterSeconds !== undefined) reply.header('retry-after', String(Math.max(1, Math.ceil(error.details.retryAfterSeconds))))
      return reply.code(error.status).send(errorBody(error.code, error.message, error.details))
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(422).send(errorBody('invalid_request', 'The request doesn\'t have the expected form.', { fields: faultyFields(error) }))
    }
    const known = CLIENT_ERROR_CODES[error.code]
    if (known) return reply.code(known.status).send(errorBody(known.code, known.message))
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(400).send(errorBody('bad_request', 'The request can\'t be understood.'))
    }
    // Unexpected: the logger's serializer keeps only the error's type and stack frames.
    request.log.error({ err: error }, 'unhandled error')
    return reply.code(500).send(errorBody('internal_error', 'The service hit an internal error.'))
  })

  // An unknown path gets a JSON 404 that doesn't repeat the path, whatever was asked.
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(errorBody('not_found', 'There is nothing at this address.')))
}
