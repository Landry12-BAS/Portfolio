// One model call from start to finish: reading the call headers, checking the alias,
// admitting the call under its quotas, walking the alias's chain of models, settling
// the budget and recording spans. The routes decide how to talk to a provider; this
// decides which provider, and keeps the books.
import type { FastifyBaseLogger, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { CircuitBreaker } from './breaker.ts'
import type { TokenEstimate } from './budget/estimate.ts'
import { modelMeters, quotaMeters, refund, settlement } from './budget/meters.ts'
import type { Meter } from './budget/meters.ts'
import type { MeterStore } from './budget/store.ts'
import { GatewayError } from './errors.ts'
import type { ReadLimiter } from './read-limit.ts'
import type { Alias, Model, Routing, System } from './routing/load.ts'
import type { DataClass, Plan, Profile } from './routing/plan.ts'
import type { Capability } from './routing/schema.ts'
import { newSpanId } from './spans.ts'
import type { RedisSpanReader, Span, SpanSink, SpanStatus } from './spans.ts'
import type { Failure } from './upstream/client.ts'

/** Everything a call needs from the running gateway, shared by every request. */
export interface GatewayContext {
  routing: Routing
  profile: Profile
  prefix: string
  now: () => number
  meters: MeterStore
  breaker: CircuitBreaker
  spans: SpanSink
  // Reads a run's spans back, for the Scope route.
  spanReader: RedisSpanReader
  // Counts how often each run's trace is read, so a flood of reads of one run is refused before it costs a read.
  traceReads: ReadLimiter
  log: FastifyBaseLogger
}

/** Who a call is for, read from the caller's token and the x-lb-* headers. */
export interface CallMeta {
  service: string
  system: System
  dataClass: DataClass
  runId: string
  session: string | undefined
  parentSpanId: string | undefined
}

// Every call names its system and run. Visitor calls also carry an opaque, hashed
// session ID (never the raw cookie), so each visitor's daily quota holds. The patterns
// allow no colons or spaces, so a header value can never reach into another Redis key.
const metaHeaders = z.object({
  'x-lb-system': z.string().regex(/^lb-\d{2}$/, 'lb-NN'),
  'x-lb-run-id': z.string().regex(/^[\w-]{8,64}$/, '8 to 64 letters, digits, underscores or hyphens'),
  // Unlabelled content is treated as visitor content: the stricter routing.
  'x-lb-data-class': z.enum(['visitor', 'synthetic']).default('visitor'),
  'x-lb-session': z.string().regex(/^[\w-]{16,128}$/, '16 to 128 letters, digits, underscores or hyphens').optional(),
  'x-lb-parent-span': z.string().regex(/^[0-9a-f]{16}$/, '16 hex digits').optional(),
})

/**
 * Reads and checks the x-lb-* call headers. Refuses a system the calling service
 * doesn't own (403) and a visitor call without a session ID (400).
 */
export function readCallMeta(request: FastifyRequest, routing: Routing): CallMeta {
  const parsed = metaHeaders.safeParse(request.headers)
  if (!parsed.success) {
    const problems = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    throw new GatewayError(400, 'invalid_request', `Invalid call headers: ${problems}.`)
  }
  const headers = parsed.data
  const system = routing.systems.get(headers['x-lb-system'])
  if (!system || system.service !== request.service) {
    throw new GatewayError(403, 'system_not_allowed', `${request.service} can't make calls for ${headers['x-lb-system']}.`)
  }
  if (headers['x-lb-data-class'] === 'visitor' && !headers['x-lb-session']) {
    throw new GatewayError(400, 'invalid_request', 'Visitor calls need an x-lb-session header, so the visitor\'s quota applies.')
  }
  return {
    service: request.service,
    system,
    dataClass: headers['x-lb-data-class'],
    runId: headers['x-lb-run-id'],
    session: headers['x-lb-session'],
    parentSpanId: headers['x-lb-parent-span'],
  }
}

/**
 * Finds the alias a request asked for. Answers 404 for an unknown alias or one of the
 * wrong kind (an embedding alias on the chat route), and 403 when the system may not
 * use it.
 */
export function resolveAlias(routing: Routing, system: System, name: string, kind: Alias['kind']): Alias {
  const alias = routing.aliases.get(name)
  if (!alias || alias.kind !== kind) {
    throw new GatewayError(404, 'model_not_found', `There is no ${kind} model called ${name}. Ask for an lb- alias.`)
  }
  if (!system.aliases.includes(alias.name)) {
    throw new GatewayError(403, 'alias_not_allowed', `${system.key} may not use ${alias.name}.`)
  }
  return alias
}

/**
 * Fails early when nothing on the chain can take the call: 400 when no allowed model
 * supports what the request needs, 503 when the right models exist but none of their
 * providers is configured.
 */
export function assertPlannable(plan: Plan, alias: Alias, needs: ReadonlySet<Capability>): void {
  if (plan.candidates.length > 0) return
  const capable = new Set(alias.chain.filter(model => [...needs].every(need => model.capabilities.has(need))))
  const needed = [...needs].join(', ')
  if (capable.size === 0) {
    throw new GatewayError(400, 'unsupported_request', `No model on ${alias.name} supports everything this call needs (${needed}).`)
  }
  // The capable models are all off limits for this data or this profile: the request
  // can't be served here however long the caller waits.
  const allowed = plan.excluded.some(({ model, reason }) => capable.has(model) && reason === 'not-configured')
  if (!allowed) {
    throw new GatewayError(400, 'unsupported_request', `No model on ${alias.name} that may take this content supports everything this call needs (${needed}).`)
  }
  throw new GatewayError(503, 'gateway_unavailable', `No provider that may take this call on ${alias.name} is configured.`)
}

/** The outcome of one attempt: the provider's answer, or why it failed. */
export type AttemptResult<T> = { ok: true, value: T } | { ok: false, failure: Failure }
/** How a route talks to one model: send the request and report the outcome. */
export type Attempt<T> = (model: Model, timeoutMs: number) => Promise<AttemptResult<T>>

/** A successful attempt: the model that answered, its reserved meters and its answer. */
export interface Served<T> {
  model: Model
  meters: Meter[]
  value: T
  startedAt: number
}

/** Thrown when the caller's connection closed mid-call; there is no one left to answer. */
export class ClientGoneError extends Error {
  constructor() {
    super('The client closed the connection.')
    this.name = 'ClientGoneError'
  }
}

// Failures where the provider returned a status did no work worth billing, so their
// token reservation is refunded. After a timeout or a dropped connection the provider
// may have run the whole prompt, so the reservation stands.
const refundable = new Set(['rate_limited', 'server_error', 'unavailable', 'bad_response'])

// Below this, there is no point starting another attempt before the deadline.
const MIN_ATTEMPT_MS = 250

/** How a call ended, for its span, with any details the route adds (such as a guard's verdict). */
export interface Finish {
  ok: boolean
  error?: string
  attrs?: Span['attrs']
}

/**
 * One model call: its quota admission, the walk down its chain, budget settlement and
 * spans. Create it once the request is validated, then call `admit`, `run` and
 * `finish` in that order.
 */
export class ModelCall {
  readonly spanId = newSpanId()
  readonly startedAt: number
  readonly deadlineAt: number
  attempts = 0

  readonly #ctx: GatewayContext
  readonly #meta: CallMeta
  readonly #alias: Alias
  readonly #plan: Plan
  readonly #estimate: TokenEstimate
  readonly #stream: boolean
  // Spans recorded but not yet written to Redis.
  #spans: Span[] = []

  constructor(ctx: GatewayContext, meta: CallMeta, alias: Alias, plan: Plan, estimate: TokenEstimate, stream: boolean) {
    this.#ctx = ctx
    this.#meta = meta
    this.#alias = alias
    this.#plan = plan
    this.#estimate = estimate
    this.#stream = stream
    this.startedAt = ctx.now()
    this.deadlineAt = this.startedAt + alias.timeouts.deadlineMs
  }

  /** The alias this call asked for. */
  get alias(): Alias {
    return this.#alias
  }

  /** Counts the call against the run, the visitor and the system, or refuses it with a 429. */
  async admit(): Promise<void> {
    const { system, session, runId } = this.#meta
    const meters = quotaMeters(system, session, runId, this.#ctx.prefix, this.startedAt)
    const full = await this.#ctx.meters.reserve(meters)
    if (!full) return
    const which = full.scope.split(':')[0]
    const retryAfterMs = full.resetAtMs === undefined ? undefined : full.resetAtMs - this.startedAt
    throw new GatewayError(429, 'quota_exceeded', `This ${which} has used its ${full.limit} model calls${full.window === 'day' ? ' for today' : ''}.`, retryAfterMs)
  }

  /**
   * Walks the chain until one model serves the call, and returns that model's answer.
   * Each model is skipped while its breaker is open or its budget is spent; a failed or
   * refused attempt moves on to the next model. Throws when none can serve it: with the
   * last refusal when every model tried refused the request, else as a failure.
   */
  async run<T>(attempt: Attempt<T>): Promise<Served<T>> {
    // Models the plan ruled out (data class, terms, capability, no key) go in the trace too.
    for (const { model, reason } of this.#plan.excluded) this.#skip(model, reason)
    let nextFreeAt = Number.POSITIVE_INFINITY
    let timedOut = false
    // The last provider refusal, and whether any attempt failed otherwise, for the error the caller gets.
    let refusal: { provider: string, message: string } | undefined
    let failedOtherwise = false

    for (const model of this.#plan.candidates) {
      const now = this.#ctx.now()
      const remaining = this.deadlineAt - now
      if (remaining < MIN_ATTEMPT_MS) {
        timedOut = true
        break
      }

      // 1. The breaker: skip a model that keeps failing or asked us to wait.
      const gate = this.#ctx.breaker.admit(model.ref)
      if (!gate.ok) {
        this.#skip(model, 'breaker_open', { retryAtMs: gate.retryAtMs })
        nextFreeAt = Math.min(nextFreeAt, gate.retryAtMs)
        continue
      }

      // 2. The budget: reserve this model's requests, tokens or Neurons, or skip it.
      const meters = modelMeters(this.#ctx.routing, model, this.#estimate, this.#ctx.prefix, now)
      const full = await this.#ctx.meters.reserve(meters)
      if (full) {
        this.#ctx.breaker.release(model.ref)
        this.#skip(model, 'budget', { meter: `${full.scope} ${full.unit} per ${full.window}` })
        if (full.resetAtMs !== undefined) nextFreeAt = Math.min(nextFreeAt, full.resetAtMs)
        continue
      }

      // 3. The attempt itself, within the per-attempt timeout and the call's deadline.
      this.attempts += 1
      const perAttempt = this.#stream ? this.#alias.timeouts.firstTokenMs : this.#alias.timeouts.responseMs
      let result: AttemptResult<T>
      try {
        result = await attempt(model, Math.min(perAttempt, remaining))
      }
      catch (error) {
        // The client left, or the attempt hit a bug: record it and stop the whole call.
        this.#ctx.breaker.release(model.ref)
        this.#attemptSpan(model, now, 'error', { outcome: error instanceof ClientGoneError ? 'client_closed' : 'internal_error' })
        await this.#close({ ok: false, error: error instanceof ClientGoneError ? 'client_closed' : 'internal_error' })
        throw error
      }

      if (result.ok) {
        this.#ctx.breaker.success(model.ref)
        this.#attemptSpan(model, now, 'ok', { outcome: 'ok', ...(this.#stream ? { ttftMs: this.#ctx.now() - now } : {}) })
        await this.#flush()
        return { model, meters, value: result.value, startedAt: now }
      }

      // 4. The attempt failed: settle the reservation and decide what comes next.
      const { failure } = result
      if (failure.kind === 'reject' || refundable.has(failure.reason)) await this.#ctx.meters.adjust(refund(meters))
      if (failure.kind === 'reject') {
        // This provider refused the request itself. The model isn't failing, so its breaker is untouched,
        // and the next model may take what this one refused.
        this.#ctx.breaker.release(model.ref)
        this.#attemptSpan(model, now, 'error', { outcome: 'rejected', httpStatus: failure.status })
        refusal = { provider: model.provider.name, message: failure.message }
        continue
      }
      failedOtherwise = true
      if (failure.reason === 'rate_limited') {
        this.#ctx.breaker.coolDown(model.ref, this.#ctx.now() + (failure.retryAfterMs ?? 30_000))
      }
      else {
        this.#ctx.breaker.failure(model.ref)
      }
      this.#attemptSpan(model, now, 'error', {
        outcome: failure.reason,
        ...(failure.status === undefined ? {} : { httpStatus: failure.status }),
        ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
      })
    }

    if (refusal && !failedOtherwise && !timedOut) {
      // Every model that was tried refused the request, so it is the request that needs changing.
      await this.#close({ ok: false, error: 'upstream_rejected' })
      throw new GatewayError(400, 'upstream_rejected', `${refusal.provider} rejected the request: ${refusal.message}`)
    }
    return this.#fail(timedOut, nextFreeAt)
  }

  /**
   * Ends a call no model could serve, with the error that tells the system what to do:
   * 503 (out of budget, serve a replay), 504 (too slow) or 502 (every model failed).
   */
  async #fail(timedOut: boolean, nextFreeAt: number): Promise<never> {
    // A call that reached no provider cost nothing, so it doesn't count against the
    // run, the visitor or the system.
    if (this.attempts === 0 && !timedOut) {
      await this.#ctx.meters.adjust(quotaMeters(this.#meta.system, this.#meta.session, this.#meta.runId, this.#ctx.prefix, this.startedAt)
        .map(meter => ({ meter, delta: -1 })))
      await this.#close({ ok: false, error: 'budget_exhausted' })
      const retryAfterMs = Number.isFinite(nextFreeAt) ? Math.max(nextFreeAt - this.#ctx.now(), 1_000) : undefined
      throw new GatewayError(503, 'budget_exhausted', `Every model on ${this.#alias.name} is out of budget or cooling down. Serve a replay.`, retryAfterMs)
    }
    if (timedOut || this.#ctx.now() >= this.deadlineAt) {
      await this.#close({ ok: false, error: 'upstream_timeout' })
      throw new GatewayError(504, 'upstream_timeout', `No model on ${this.#alias.name} answered within ${this.#alias.timeouts.deadlineMs} ms.`)
    }
    await this.#close({ ok: false, error: 'upstream_failed' })
    throw new GatewayError(502, 'upstream_failed', `Every model on ${this.#alias.name} failed. Serve a replay.`)
  }

  /** Settles the served model's budget with the provider's own token count, and closes the call. */
  async finish(served: Served<unknown>, usage: TokenEstimate | undefined, outcome: Finish): Promise<void> {
    if (usage) {
      try {
        await this.#ctx.meters.adjust(settlement(served.meters, served.model, this.#estimate, usage))
      }
      catch (error) {
        // The answer is already on its way; a failed correction must not break it.
        this.#ctx.log.warn({ err: error, model: served.model.ref }, 'could not settle a call\'s budget')
      }
    }
    await this.#close(outcome, served.model, usage)
  }

  /** The x-lb-* response headers that tell the caller which model answered. */
  headers(model: Model): Record<string, string> {
    return {
      'x-lb-provider': model.provider.key,
      'x-lb-model': model.ref,
      'x-lb-attempts': String(this.attempts),
      'x-lb-span-id': this.spanId,
    }
  }

  /** Records a span for this call or one of its attempts, to be written on the next flush. */
  #span(kind: Span['kind'], name: string, status: SpanStatus, startMs: number, attrs: Span['attrs'], parentId: string | undefined): void {
    this.#spans.push({
      v: 1,
      runId: this.#meta.runId,
      system: this.#meta.system.key,
      spanId: kind === 'gateway.call' ? this.spanId : newSpanId(),
      parentId,
      kind,
      name,
      status,
      startMs,
      endMs: this.#ctx.now(),
      attrs,
    })
  }

  /** Records a model that was passed over, and why. */
  #skip(model: Model, reason: string, extra: Span['attrs'] = {}): void {
    this.#span('gateway.attempt', model.ref, 'skipped', this.#ctx.now(), { provider: model.provider.key, model: model.ref, outcome: reason, ...extra }, this.spanId)
  }

  /** Records an attempt that reached a provider, with its outcome. */
  #attemptSpan(model: Model, startMs: number, status: SpanStatus, attrs: Span['attrs']): void {
    this.#span('gateway.attempt', model.ref, status, startMs, { provider: model.provider.key, model: model.ref, modelId: model.id, ...attrs }, this.spanId)
  }

  /** Writes the recorded spans to Redis, where the trace panel can read them. */
  async #flush(): Promise<void> {
    const spans = this.#spans
    this.#spans = []
    await this.#ctx.spans.emit(spans)
  }

  /** Records the call's own span, with how it ended and the tokens it used, and writes it out. */
  async #close(outcome: Finish, model?: Model, usage?: TokenEstimate): Promise<void> {
    const attrs: Span['attrs'] = {
      alias: this.#alias.name,
      dataClass: this.#meta.dataClass,
      stream: this.#stream,
      attempts: this.attempts,
      estimatedInputTokens: this.#estimate.input,
      maxOutputTokens: this.#estimate.output,
      usage: usage ? 'reported' : 'estimated',
    }
    if (model) {
      attrs.provider = model.provider.key
      attrs.model = model.ref
    }
    if (usage) {
      attrs.inputTokens = usage.input
      attrs.outputTokens = usage.output
    }
    if (outcome.error) attrs.error = outcome.error
    Object.assign(attrs, outcome.attrs)
    this.#span('gateway.call', this.#alias.name, outcome.ok ? 'ok' : 'error', this.startedAt, attrs, this.#meta.parentSpanId)
    await this.#flush()
  }
}
