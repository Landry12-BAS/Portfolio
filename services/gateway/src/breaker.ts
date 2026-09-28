// A circuit breaker per model. After repeated failures a model is skipped for a while,
// then admits one probe call; a success closes it, a failure opens it again for twice
// as long. It also honours a provider's Retry-After on 429s.
//
// State is per process: the box runs one gateway, and a restart that forgets an open
// breaker costs at most one probe call.

export interface BreakerOptions {
  failureThreshold: number
  openMs: number
  maxOpenMs: number
}

interface State {
  failures: number
  opens: number
  openUntil: number
  tripped: boolean
  probing: boolean
}

export type Admission = { ok: true } | { ok: false, retryAtMs: number }

export const defaultBreakerOptions: BreakerOptions = { failureThreshold: 3, openMs: 30_000, maxOpenMs: 300_000 }

export class CircuitBreaker {
  readonly #states = new Map<string, State>()
  readonly #options: BreakerOptions
  readonly #now: () => number

  constructor(now: () => number, options: BreakerOptions = defaultBreakerOptions) {
    this.#now = now
    this.#options = options
  }

  #state(ref: string): State {
    let state = this.#states.get(ref)
    if (!state) {
      state = { failures: 0, opens: 0, openUntil: 0, tripped: false, probing: false }
      this.#states.set(ref, state)
    }
    return state
  }

  admit(ref: string): Admission {
    const state = this.#states.get(ref)
    if (!state) return { ok: true }
    const now = this.#now()
    if (now < state.openUntil) return { ok: false, retryAtMs: state.openUntil }
    if (state.tripped) {
      // Half-open: one probe at a time decides whether the model is back.
      if (state.probing) return { ok: false, retryAtMs: now + 1_000 }
      state.probing = true
    }
    return { ok: true }
  }

  success(ref: string): void {
    this.#states.delete(ref)
  }

  failure(ref: string): void {
    const state = this.#state(ref)
    state.failures += 1
    state.probing = false
    if (state.tripped || state.failures >= this.#options.failureThreshold) {
      state.tripped = true
      state.opens += 1
      const openMs = Math.min(this.#options.openMs * 2 ** (state.opens - 1), this.#options.maxOpenMs)
      state.openUntil = Math.max(state.openUntil, this.#now() + openMs)
    }
  }

  /** The provider asked for a pause (429 with Retry-After). Not a failure. */
  coolDown(ref: string, untilMs: number): void {
    const state = this.#state(ref)
    state.probing = false
    state.openUntil = Math.max(state.openUntil, untilMs)
  }

  /** An admitted probe that never reached the provider, such as one stopped by a budget. */
  release(ref: string): void {
    const state = this.#states.get(ref)
    if (state) state.probing = false
  }
}
