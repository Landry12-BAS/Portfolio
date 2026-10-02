// Gateway errors, sent in the OpenAI error envelope so the AI SDK and the openai
// Python client surface them as ordinary API errors. `code` is the stable part that
// callers branch on; the message is for people.

/** Every error code the gateway can answer with. The README lists what each one means. */
export type ErrorCode
  = | 'invalid_request'
    | 'unsupported_request'
    | 'invalid_service_token'
    | 'system_not_allowed'
    | 'alias_not_allowed'
    | 'permission_denied'
    | 'model_not_found'
    | 'input_too_large'
    | 'quota_exceeded'
    | 'rate_limited'
    | 'budget_exhausted'
    | 'upstream_rejected'
    | 'upstream_failed'
    | 'upstream_timeout'
    | 'gateway_unavailable'
    | 'not_found'
    | 'run_not_found'
    | 'internal_error'

// The OpenAI `type` field for each HTTP status; anything else is an `api_error`.
const errorTypes: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'invalid_request_error',
  429: 'rate_limit_error',
}

/** The JSON body of every error response: `{ "error": { message, type, code } }`. */
export interface ErrorBody {
  error: { message: string, type: string, code: string }
}

/** Builds an error body in the OpenAI format for a status, a code and a message. */
export function errorBody(status: number, code: string, message: string): ErrorBody {
  return { error: { message, type: errorTypes[status] ?? 'api_error', code } }
}

/**
 * An error the gateway answers on purpose, with its HTTP status and stable code.
 * Route handlers throw it; the app's error handler turns it into the response.
 */
export class GatewayError extends Error {
  readonly status: number
  readonly code: ErrorCode
  // Sent as Retry-After, rounded up to whole seconds.
  readonly retryAfterMs: number | undefined

  constructor(status: number, code: ErrorCode, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'GatewayError'
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }

  /** Returns this error as the JSON body the caller receives. */
  toBody(): ErrorBody {
    return errorBody(this.status, this.code, this.message)
  }
}
