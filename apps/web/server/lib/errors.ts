// The errors the site's server answers with, in the platform's one shape:
// `{"error": {"code": "...", "message": "..."}}` (docs/SECURITY.md, section 3). The code is stable,
// the message is a sentence for people, and neither ever repeats what a visitor sent or what
// went wrong inside: an unexpected failure is logged by name and answered as a generic 500.

/** An error the server answers on purpose, with its status, its stable code and a few headers. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly headers: Readonly<Record<string, string>>
  // The fields a back end's own error adds for a case (`resets_at`, `fields`, `problems`).
  readonly extra: Readonly<Record<string, unknown>>

  constructor(status: number, code: string, message: string, options: { headers?: Record<string, string>, extra?: Record<string, unknown> } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.headers = options.headers ?? {}
    this.extra = options.extra ?? {}
  }

  /** The body the visitor's browser receives. */
  toBody(): { error: Record<string, unknown> } {
    return { error: { code: this.code, message: this.message, ...this.extra } }
  }
}

/** The errors the server raises itself, by what went wrong. */
export const problems = {
  notFound: () => new ApiError(404, 'not_found', 'There is nothing at this address.'),
  forbiddenOrigin: () => new ApiError(403, 'forbidden_origin', 'This request did not come from this site.'),
  invalidRequest: (message = 'The request is not valid.') => new ApiError(400, 'invalid_request', message),
  unsupportedMedia: (message = 'Send the request as application/json.') => new ApiError(415, 'unsupported_media_type', message),
  tooLarge: () => new ApiError(413, 'payload_too_large', 'The request is too big.', { headers: { connection: 'close' } }),
  verificationRequired: () => new ApiError(403, 'verification_required', 'Run the check that proves you are a person before using a demo with your own text.'),
  verificationFailed: () => new ApiError(403, 'verification_failed', 'The check could not tell that you are a person. Try again.'),
  unavailable: () => new ApiError(503, 'unavailable', 'This part of the site is not available right now.'),
  upstreamFailed: () => new ApiError(502, 'upstream_failed', 'The system behind this demo did not answer properly.'),
  upstreamTimeout: () => new ApiError(504, 'upstream_timeout', 'The system behind this demo took too long to answer.'),
  internal: () => new ApiError(500, 'internal_error', 'The site hit an internal error.'),
} as const
