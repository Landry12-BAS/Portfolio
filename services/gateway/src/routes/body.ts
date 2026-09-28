// Request-body validation shared by the routes.
import type { z } from 'zod'

import { GatewayError } from '../errors.ts'

/**
 * Validates a request body against a schema and returns the clean, typed result.
 * Answers 400 listing up to ten problems, so a caller can fix them in one go.
 */
export function parseBody<Schema extends z.ZodType>(schema: Schema, body: unknown): z.infer<Schema> {
  const parsed = schema.safeParse(body)
  if (parsed.success) return parsed.data
  const problems = parsed.error.issues.slice(0, 10).map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`)
  throw new GatewayError(400, 'invalid_request', `Invalid request: ${problems.join('; ')}.`)
}
