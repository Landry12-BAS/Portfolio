import type { z } from 'zod'

import { GatewayError } from '../errors.ts'

/** Validates a request body, answering 400 with every problem found. */
export function parseBody<Schema extends z.ZodType>(schema: Schema, body: unknown): z.infer<Schema> {
  const parsed = schema.safeParse(body)
  if (parsed.success) return parsed.data
  const problems = parsed.error.issues.slice(0, 10).map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`)
  throw new GatewayError(400, 'invalid_request', `Invalid request: ${problems.join('; ')}.`)
}
