// The visitor's anonymous session as the boards see it: whether this deployment has a back end,
// whether the visitor has passed the invisible Turnstile check today, and when the day's quotas
// start again. The session itself is the server's signed cookie (docs/SECURITY.md, section 2);
// this store only asks the server about it and runs the check once, before a visitor's first
// live run, never for the catalog, the datasheets or a replay.
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

import { sessionStateSchema } from '#shared/schema/session'
import type { SessionState } from '#shared/schema/session'
import { TEST_TURNSTILE_STAND_IN } from '#shared/turnstile-stand-in'

import { getJson, postJson } from '~/board-kit/api'
import { isApiProblem } from '~/board-kit/problem'
import type { ApiProblem } from '~/board-kit/problem'

/** How the check stands: not needed yet, running (the widget has the floor), or failed (try again). */
export type ChallengeState = 'idle' | 'running' | 'failed'

/** The visitor's session, shared by every board. */
export const useSessionStore = defineStore('session', () => {
  const state = shallowRef<SessionState>()
  const loading = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const challenge = ref<ChallengeState>('idle')
  const problem = shallowRef<ApiProblem>()

  const verified = computed(() => state.value?.verified === true)
  // Unknown counts as unavailable until the server has said otherwise.
  const available = computed(() => state.value?.available === true)

  // The read of the session's state, and the check, while they are running, so a second ask joins the first.
  let loadInFlight: Promise<void> | undefined
  let inFlight: Promise<boolean> | undefined
  let waitingForToken: ((token: string | undefined) => void) | undefined

  /** Reads the session's state from the server. */
  async function readState(): Promise<void> {
    loading.value = 'loading'
    try {
      state.value = await getJson('/api/session', sessionStateSchema)
      loading.value = 'ready'
    }
    catch (error) {
      problem.value = isApiProblem(error) ? error : undefined
      loading.value = 'failed'
    }
  }

  /** Asks the server for the session's state: this creates the session cookie the first time a board opens. */
  function load(): Promise<void> {
    loadInFlight ??= readState().finally(() => {
      loadInFlight = undefined
    })
    return loadInFlight
  }

  /** Waits for a Turnstile token: the test build's stand-in at once, or what the widget hands to `provideToken`. */
  function tokenFromVisitor(): Promise<string | undefined> {
    if (__LB_TEST_BUILD__ && state.value?.testMode) return Promise.resolve(TEST_TURNSTILE_STAND_IN)
    return new Promise((resolve) => {
      waitingForToken = resolve
    })
  }

  /** Called by the check's widget with the token it made, or with nothing when it could not. */
  function provideToken(token: string | undefined): void {
    waitingForToken?.(token)
    waitingForToken = undefined
  }

  /** Sends the token to the server, which checks it with Cloudflare, and keeps the session it answers with. */
  async function submitToken(token: string): Promise<boolean> {
    try {
      state.value = await postJson('/api/session/verify', { token }, sessionStateSchema)
      return state.value.verified
    }
    catch (error) {
      problem.value = isApiProblem(error) ? error : undefined
      return false
    }
  }

  /** Runs the check from start to end. */
  async function runCheck(): Promise<boolean> {
    challenge.value = 'running'
    problem.value = undefined
    const token = await tokenFromVisitor()
    const passed = token !== undefined && await submitToken(token)
    challenge.value = passed ? 'idle' : 'failed'
    return passed
  }

  /**
   * Makes sure the visitor has passed the check, running it if they have not, and says whether
   * they have. Asked twice at once, it runs once. It answers false when this deployment has no
   * back end, so a board never starts a run it cannot finish.
   */
  async function ensureVerified(): Promise<boolean> {
    if (state.value === undefined) await load()
    if (verified.value) return true
    if (!available.value) return false
    inFlight ??= runCheck().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  /** Takes back the "verified" a board believed, after the server said the check is still needed (a new day began). */
  function forgetVerification(): void {
    if (state.value) state.value = { ...state.value, verified: false }
  }

  /** Forgets everything, for a visitor who leaves or a test that starts over. */
  function reset(): void {
    state.value = undefined
    loading.value = 'idle'
    challenge.value = 'idle'
    problem.value = undefined
    waitingForToken = undefined
    inFlight = undefined
    loadInFlight = undefined
  }

  return { state, loading, challenge, problem, verified, available, load, ensureVerified, provideToken, forgetVerification, reset }
})
