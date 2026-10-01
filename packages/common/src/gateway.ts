// The AI gateway (LB-00), as a Node service calls it.
//
// The AI SDK talks to the gateway through its OpenAI-compatible provider, which the
// gateway's API matches. Every request carries a fresh service token and the current
// run's x-lb-* headers (services/gateway/README.md lists them), so the gateway counts the
// call against the run's quotas and the Scope shows it nested under the step that made
// it. A call made outside a run is stopped before anything leaves the process.
//
//   const gateway = Gateway.fromEnv()
//   await runScope(createRun({ system: 'lb-08', runId: newRunId(), session }), async () => {
//     const { object } = await generateObject({ model: gateway.chat('lb-tools'), schema, prompt })
//   })
//
// This is the twin of python/lb-common's lb_common.gateway.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { OpenAICompatibleProvider } from '@ai-sdk/openai-compatible'
import { APICallError } from 'ai'
import type { LanguageModel } from 'ai'

import { currentRun, currentSpanId, OutsideRunError } from './run.ts'
import type { Run } from './run.ts'
import { checkServiceName, loadServiceKey, ServiceTokens } from './tokens.ts'

// How long a call may take. It outlasts every alias's deadline in routing.yaml (lb-long
// allows 180 seconds), so the gateway answers 504 before this gives up.
const DEFAULT_TIMEOUT_MS = 200_000
// Hosts reachable only from this machine.
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/** The gateway's stable error codes (services/gateway/src/errors.ts); its README says what each means. */
export const gatewayCodes = [
  'invalid_request',
  'unsupported_request',
  'invalid_service_token',
  'system_not_allowed',
  'alias_not_allowed',
  'model_not_found',
  'input_too_large',
  'quota_exceeded',
  'budget_exhausted',
  'upstream_rejected',
  'upstream_failed',
  'upstream_timeout',
  'gateway_unavailable',
  'not_found',
  'internal_error',
] as const
/** One of the gateway's error codes, such as `budget_exhausted`. */
export type GatewayCode = (typeof gatewayCodes)[number]

// What each code means for the caller, in words that never quote a prompt or an answer.
const CODE_MESSAGES: Readonly<Record<GatewayCode, string>> = {
  invalid_request: 'The gateway refused the request as malformed.',
  unsupported_request: 'No model on the alias can take this request.',
  invalid_service_token: 'The gateway refused the service token.',
  system_not_allowed: 'This service may not make calls for that system.',
  alias_not_allowed: 'This system may not use that model alias.',
  model_not_found: 'The gateway has no such model alias.',
  input_too_large: 'The prompt is too long for the model alias.',
  quota_exceeded: 'A model-call quota is spent.',
  budget_exhausted: 'Every model on the alias is out of budget.',
  upstream_rejected: 'The model provider refused the request.',
  upstream_failed: 'Every model on the alias failed.',
  upstream_timeout: 'No model on the alias answered in time.',
  gateway_unavailable: 'The gateway is unavailable.',
  not_found: 'The gateway has no such route.',
  internal_error: 'The gateway hit an internal error.',
}

/**
 * A model call that failed, reduced to what a caller may act on: the HTTP status, the
 * gateway's error code and when to retry. It never carries the prompt or the answer, which
 * the AI SDK's own errors do, so it is safe to log.
 */
export class GatewayCallError extends Error {
  readonly status: number | undefined
  readonly code: GatewayCode | 'unreachable' | 'unknown'
  readonly retryAfterSeconds: number | undefined

  constructor(code: GatewayCallError['code'], status: number | undefined, retryAfterSeconds: number | undefined) {
    super(code === 'unreachable' ? 'The gateway can\'t be reached.' : code === 'unknown' ? 'The gateway answered in a way this client doesn\'t know.' : CODE_MESSAGES[code])
    this.name = 'GatewayCallError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** Tells whether text is one of the gateway's error codes. */
function isGatewayCode(value: unknown): value is GatewayCode {
  return typeof value === 'string' && (gatewayCodes as readonly string[]).includes(value)
}

/** Reads the `code` out of an OpenAI-style error body: `{ "error": { "code": "..." } }`. */
function codeOf(data: unknown): unknown {
  const error = (data as { error?: unknown } | null)?.error
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
}

/**
 * Turns whatever a model call threw into a GatewayCallError when the gateway (or the
 * network on the way to it) is to blame, and returns undefined for any other error,
 * such as an output that failed its schema.
 */
export function gatewayErrorOf(error: unknown): GatewayCallError | undefined {
  if (error instanceof GatewayCallError) return error
  if (!APICallError.isInstance(error)) return undefined
  if (error.statusCode === undefined) return new GatewayCallError('unreachable', undefined, undefined)
  const code = codeOf(error.data)
  const retryAfter = Number.parseInt(error.responseHeaders?.['retry-after'] ?? '', 10)
  return new GatewayCallError(isGatewayCode(code) ? code : 'unknown', error.statusCode, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined)
}

/**
 * Returns the gateway's base URL, without a trailing slash, if service tokens may be sent
 * to it. HTTPS anywhere. Plain HTTP only to this machine, or to a single-label host such
 * as `gateway`, the gateway's name on the internal Docker network. The URL is a scheme, a
 * host and a port: no credentials, path, query or fragment.
 */
export function checkGatewayUrl(url: string): string {
  let parts: URL
  try {
    parts = new URL(url)
  }
  catch {
    throw new RangeError('The gateway URL must be an http:// or https:// URL with a host.')
  }
  if ((parts.protocol !== 'http:' && parts.protocol !== 'https:') || !parts.hostname) {
    throw new RangeError('The gateway URL must be an http:// or https:// URL with a host.')
  }
  if (parts.username || parts.password || parts.search || parts.hash || (parts.pathname !== '/' && parts.pathname !== '')) {
    throw new RangeError('The gateway URL is only a scheme, a host and a port.')
  }
  const internal = LOOPBACK_HOSTS.includes(parts.hostname) || !parts.hostname.includes('.')
  if (parts.protocol === 'http:' && !internal) throw new RangeError('Use https:// for a gateway outside the internal network.')
  return `${parts.protocol}//${parts.host}`
}

/** Returns the x-lb-* headers that tell the gateway which run a call belongs to. */
export function runHeaders(run: Run, parentSpanId: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'x-lb-system': run.system,
    'x-lb-run-id': run.runId,
    'x-lb-data-class': run.dataClass,
  }
  if (run.session !== undefined) headers['x-lb-session'] = run.session
  if (parentSpanId !== undefined) headers['x-lb-parent-span'] = parentSpanId
  return headers
}

/** Where the gateway is, and how long a call may take. */
export interface GatewaySettings {
  url: string
  timeoutMs?: number
}

/** Choices that change what the client sends. */
export interface GatewayOptions {
  // For tests: the function that really sends requests. Defaults to the global fetch.
  fetch?: typeof fetch
  // Send the SDK's `response_format` (json_object) to the gateway. By default it is left
  // out: the gateway's fallback chains cross providers whose JSON modes differ, so a
  // system describes the format in its prompt and checks the reply against its schema.
  sendResponseFormat?: boolean
}

/** One service's connection to the AI gateway, shared by the whole process. */
export class Gateway {
  readonly provider: OpenAICompatibleProvider<string, string, string, string>
  readonly #tokens: ServiceTokens
  readonly #origin: string
  readonly #timeoutMs: number
  readonly #send: typeof fetch

  /** Connects to the gateway at `settings.url` as `tokens.service`. */
  constructor(settings: GatewaySettings, tokens: ServiceTokens, options: GatewayOptions = {}) {
    this.#origin = new URL(checkGatewayUrl(settings.url)).origin
    this.#tokens = tokens
    this.#timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#send = options.fetch ?? fetch
    this.provider = createOpenAICompatible({
      name: 'lb-gateway',
      baseURL: `${this.#origin}/v1`,
      // The token is set on every request below, so each call carries one with time left.
      fetch: (input, init) => this.#labelled(input, init),
      includeUsage: true,
      ...(options.sendResponseFormat ? {} : { transformRequestBody: withoutResponseFormat }),
    })
  }

  /** Connects with the settings in the environment: LB_GATEWAY_URL, LB_SERVICE_NAME and LB_SERVICE_KEY_FILE. */
  static fromEnv(environment: Readonly<Record<string, string | undefined>> = process.env): Gateway {
    const names = ['LB_GATEWAY_URL', 'LB_SERVICE_NAME', 'LB_SERVICE_KEY_FILE'] as const
    const missing = names.filter(name => !environment[name])
    if (missing.length > 0) throw new RangeError(`Set ${missing.join(', ')} to call the gateway.`)
    // A proxy would see the token in plain HTTP, and sits where it can be tampered with.
    if (environment.NODE_USE_ENV_PROXY === '1' || environment.NODE_USE_ENV_PROXY === 'true') {
      throw new RangeError('Unset NODE_USE_ENV_PROXY: a service token must go straight to the gateway, never through a proxy.')
    }
    const service = checkServiceName(environment.LB_SERVICE_NAME as string)
    const tokens = new ServiceTokens(service, loadServiceKey(environment.LB_SERVICE_KEY_FILE as string))
    return new Gateway({ url: environment.LB_GATEWAY_URL as string }, tokens)
  }

  /** Returns the model behind a virtual alias such as `lb-tools`, for the AI SDK's `generateObject` and `generateText`. */
  chat(alias: string): LanguageModel {
    return this.provider.chatModel(alias)
  }

  /**
   * Sends one request to the gateway, labelled with the current run and a fresh token.
   * It never follows a redirect, and refuses any address but the gateway's, so the token
   * can't be sent anywhere else.
   */
  async #labelled(input: Parameters<typeof fetch>[0], init: RequestInit = {}): Promise<Response> {
    const run = currentRun()
    if (!run) throw new OutsideRunError('Model calls belong to a run: make them inside runScope().')
    const target = new URL(input instanceof Request ? input.url : String(input))
    if (target.origin !== this.#origin) throw new RangeError('Refusing to send a service token anywhere but the gateway.')
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${this.#tokens.current()}`)
    for (const [name, value] of Object.entries(runHeaders(run, currentSpanId()))) headers.set(name, value)
    const signals = [AbortSignal.timeout(this.#timeoutMs), ...(init.signal ? [init.signal] : [])]
    return this.#send(input, { ...init, headers, redirect: 'error', signal: AbortSignal.any(signals) })
  }
}

/** Removes the SDK's `response_format` from a request body (see GatewayOptions.sendResponseFormat). */
function withoutResponseFormat(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'response_format'))
}
