// A circuit breaker per model. After repeated failures a model is skipped for a while,
// then admits one probe call; a success closes it, a failure opens it again for twice
// as long. It also honours a provider's Retry-After on 429s.
//
// State is per process: the box runs one gateway, and a restart that forgets an open
// breaker costs at most one probe call.

/** How quickly the breaker trips and how long it stays open. */
export interface BreakerOptions {
  // Consecutive failures before the model is skipped.
  failureThreshold: number
  // The first pause after tripping; each failed probe doubles it.
  openMs: number
  // The longest pause, however many probes fail.
  maxOpenMs: number
}

/** What the breaker remembers about one model. */
interface State {
  failures: number
  // How many times the breaker has opened in a row, for the doubling pause.
  opens: number
  // No calls go to the model before this time.
  openUntil: number
  // True once the threshold was reached, until a call succeeds.
  tripped: boolean
  // True while the single half-open probe call is in flight.
  probing: boolean
}

/** The breaker's answer to "may this call go to the model now?". */
export type Admission = { ok: true } | { ok: false, retryAtMs: number }

/** Three failures trip it; it opens for 30 seconds at first and 5 minutes at most. */
export const defaultBreakerOptions: BreakerOptions = { failureThreshold: 3, openMs: 30_000, maxOpenMs: 300_000 }

/** Tracks every model's health and decides which models may take calls right now. */
export class CircuitBreaker {
  readonly #states = new Map<string, State>()
  readonly #options: BreakerOptions
  readonly #now: () => number

  constructor(now: () => number, options: BreakerOptions = defaultBreakerOptions) {
    this.#now = now
    this.#options = options
  }

  /** Returns the model's state, creating a healthy one on first use. */
  #state(ref: string): State {
    let state = this.#states.get(ref)
    if (!state) {
      state = { failures: 0, opens: 0, openUntil: 0, tripped: false, probing: false }
      this.#states.set(ref, state)
    }
    return state
  }

  /** Says whether a call may go to the model now, or when it may try again. */
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

  /** Records a successful call: the model is healthy again and its history is cleared. */
  success(ref: string): void {
    this.#states.delete(ref)
  }

  /** Records a failed call, and opens the breaker when the model keeps failing. */
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

  /** Pauses the model until the time the provider asked for (a 429 with Retry-After). Not a failure. */
  coolDown(ref: string, untilMs: number): void {
    const state = this.#state(ref)
    state.probing = false
    state.openUntil = Math.max(state.openUntil, untilMs)
  }

  /** Frees the probe slot of a call that never reached the provider, such as one stopped by a budget. */
  release(ref: string): void {
    const state = this.#states.get(ref)
    if (state) state.probing = false
  }
}
