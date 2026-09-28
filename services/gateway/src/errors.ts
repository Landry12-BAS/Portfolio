// Errors in the OpenAI envelope, so the AI SDK and the openai Python client surface
// them as ordinary API errors. `code` is the stable, documented part.

export type ErrorCode
  = | 'invalid_request'
    | 'unsupported_request'
    | 'invalid_service_token'
    | 'system_not_allowed'
    | 'alias_not_allowed'
    | 'model_not_found'
    | 'input_too_large'
    | 'quota_exceeded'
    | 'budget_exhausted'
    | 'upstream_rejected'
    | 'upstream_failed'
    | 'upstream_timeout'
    | 'gateway_unavailable'
    | 'not_found'
    | 'internal_error'

const errorTypes: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'invalid_request_error',
  429: 'rate_limit_error',
}

export interface ErrorBody {
  error: { message: string, type: string, code: string }
}

export function errorBody(status: number, code: string, message: string): ErrorBody {
  return { error: { message, type: errorTypes[status] ?? 'api_error', code } }
}

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

  toBody(): ErrorBody {
    return errorBody(this.status, this.code, this.message)
  }
}
