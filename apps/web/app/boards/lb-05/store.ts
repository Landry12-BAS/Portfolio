// LB-05's board state: the question on the board and its answer (asked live, or replayed from a
// recording), the visitor's questions left today, the limits the back end enforces and the semantic
// layer. A question is one request that the back end answers when it is done, which takes seconds and
// can take 90: the analyst reports nothing while it works and names its run only in the answer, so the
// board cannot follow the run's trace while it waits. It says so, counts the time, and gives up after
// the time the site's server waits plus a little. When the answer arrives the Scope reads the whole
// trace, which is complete by then. Every answer is checked with its schema before the board uses it.
import type { Exchange, Recording } from '@lb/contracts'
import { defineStore } from 'pinia'
import { ref, shallowRef, watch } from 'vue'
import { z } from 'zod'

import { apiClients, callApi } from '~/board-kit/api'
import { ApiProblem, badAnswerProblem, cookieProblem, isApiProblem, unavailableProblem, verificationProblem } from '~/board-kit/problem'
import { exhausted } from '~/board-kit/quota'
import type { Quota } from '~/board-kit/quota'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import { ASK_PATIENCE_MS, DEFAULT_LIMITS, isAcceptableQuestion, quotaFrom } from './limits'
import { answerSchema, quotaSchema, semanticLayerSchema } from './schemas'
import type { Answer, Limits, SemanticLayer } from './schemas'

// A run's trace is written as the question works and is complete when the answer arrives, but the
// gateway's stream may lag a moment, so "no trace yet" is not an error for this long.
const SCOPE_GRACE_MS = 8_000

/** Where a question came from, which decides how the board presents its answer. */
export type AskSource = 'sample' | 'own' | 'attack' | 'own-attack'

/** A question to ask. */
export interface AskRequest {
  question: string
  source: AskSource
  // The sample's ID, for a curated question or attack.
  sampleId?: string
}

/** What is on the board: nothing, a live question, or a replay. */
export type RunMode = 'idle' | 'live' | 'replay'

/** Where the question stands: nothing yet, being worked on, or answered. */
export type RunPhase = 'idle' | 'asking' | 'done'

/** The path of the one route a question is asked at. */
const ASK_PATH = '/api/lb05/ask'

/** What a recorded request to the ask route carries. */
const recordedQuestionSchema = z.object({ question: z.string().min(1).max(400) })

/** LB-05's board. */
export const useLb05Store = defineStore('lb05', () => {
  const session = useSessionStore()
  const scope = useScopeStore()
  const replay = useReplayStore()

  const quota = shallowRef<Quota>()
  const limits = shallowRef<Limits>(DEFAULT_LIMITS)
  const layer = shallowRef<SemanticLayer>()
  // Whether the semantic layer is still being read, was read, or could not be.
  const layerStatus = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const asked = shallowRef<AskRequest>()
  const runMode = ref<RunMode>('idle')
  const phase = ref<RunPhase>('idle')
  // When the live request began, in Unix milliseconds, for the time the board counts while it waits.
  const askedAt = ref<number>()
  const answer = shallowRef<Answer>()
  const problem = shallowRef<ApiProblem>()
  // Whether the visitor stopped waiting for the last live question, which the back end keeps working on.
  const stoppedWaiting = ref(false)

  // The recorded answer, held back until the replayed trace has played out.
  let recordedAnswer: Answer | undefined
  // Which run is current: starting another makes every read of an older one stop touching the board.
  let generation = 0
  let pending: AbortController | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  // Whether the deadline, and not the visitor, ended the request.
  let expired = false

  /** Reads the visitor's questions left today and the limits the back end enforces. */
  async function loadQuota(): Promise<void> {
    try {
      const today = await callApi(apiClients().flask.GET('/api/lb05/quota'), quotaSchema)
      quota.value = quotaFrom(today)
      limits.value = today.limits
    }
    catch {
      // Without a count the panel says it is counting, and a refusal from the back end still stops a question.
    }
  }

  /** Reads the semantic layer, which a question may use and the browser shows. */
  async function loadLayer(): Promise<void> {
    layerStatus.value = 'loading'
    try {
      layer.value = await callApi(apiClients().flask.GET('/api/lb05/semantic-layer'), semanticLayerSchema)
      layerStatus.value = 'ready'
    }
    catch {
      layer.value = undefined
      layerStatus.value = 'failed'
    }
  }

  /** Cancels the question in progress: its request, its deadline, its replay and its trace reading. */
  function stopRun(): void {
    generation += 1
    pending?.abort()
    pending = undefined
    if (deadline !== undefined) clearTimeout(deadline)
    deadline = undefined
    replay.stop()
    scope.stop()
  }

  /** Empties the board for the next question. */
  function reset(): void {
    stopRun()
    scope.clear()
    replay.clear()
    asked.value = undefined
    runMode.value = 'idle'
    phase.value = 'idle'
    askedAt.value = undefined
    answer.value = undefined
    problem.value = undefined
    stoppedWaiting.value = false
    recordedAnswer = undefined
    expired = false
  }

  /** Works out the allowance after an answer from the questions it says are left. */
  function spend(remaining: number): void {
    const resetsAt = quota.value?.resetsAt ?? session.state?.resetsAt
    if (resetsAt === undefined) return
    const limit = quota.value?.limit ?? limits.value.questions_per_day
    quota.value = { limit, used: Math.max(limit - remaining, 0), remaining, resetsAt }
  }

  /** Sets the allowance to nothing left, when the back end says the day's questions are used. */
  function useUp(resetsAt: string | undefined): void {
    const known = quota.value
    if (known) {
      quota.value = exhausted(known)
      return
    }
    const when = resetsAt ?? session.state?.resetsAt
    if (when !== undefined) quota.value = exhausted({ limit: limits.value.questions_per_day, used: 0, remaining: limits.value.questions_per_day, resetsAt: when })
  }

  /** Takes the answer to a live question: shows it, counts it against the day, and has the Scope read the run's whole trace. */
  function take(next: Answer): void {
    answer.value = next
    phase.value = 'done'
    spend(next.remaining_questions)
    if (next.run_id !== '') scope.follow(next.run_id, { notFoundGraceMs: SCOPE_GRACE_MS })
    scope.settle()
  }

  /**
   * Shows why a live question has no answer. The service counts a question when it takes it and gives it back
   * only if the service itself failed, so a question that was sent and failed leaves the count to be read again.
   */
  function fail(reason: unknown): void {
    const sent = askedAt.value !== undefined
    scope.clear()
    phase.value = 'idle'
    runMode.value = 'idle'
    problem.value = isApiProblem(reason) ? reason : unavailableProblem()
    if (problem.value.code === 'daily_limit') useUp(problem.value.resetsAt)
    else if (sent) void loadQuota()
  }

  /** Makes the request that asks, with a deadline: past it the board stops waiting and says the system took too long. */
  function post(question: string): Promise<Answer> {
    const controller = new AbortController()
    pending = controller
    expired = false
    if (deadline !== undefined) clearTimeout(deadline)
    deadline = setTimeout(() => {
      expired = true
      controller.abort()
    }, ASK_PATIENCE_MS)
    return callApi(apiClients().flask.POST(ASK_PATH, { body: { question }, signal: controller.signal }), answerSchema)
  }

  /**
   * Sends a question to the back end. If the server says the check is needed again (a new day began), runs
   * it and tries once more. If it still says so right after the check passed, the browser is not keeping
   * the session cookie that holds the result, which the visitor can fix, so that is said and not retried.
   * A request that the deadline ended is a timeout, whatever the browser calls it.
   */
  async function send(question: string): Promise<Answer> {
    try {
      return await post(question)
    }
    catch (error) {
      if (expired) throw new ApiProblem(504, 'upstream_timeout', 'The system behind this demo took too long to answer.')
      if (!isApiProblem(error) || error.kind !== 'verification') throw error
      session.forgetVerification()
      if (!(await session.ensureVerified())) throw verificationProblem()
      try {
        return await post(question)
      }
      catch (again) {
        if (expired) throw new ApiProblem(504, 'upstream_timeout', 'The system behind this demo took too long to answer.')
        throw isApiProblem(again) && again.kind === 'verification' ? cookieProblem() : again
      }
    }
    finally {
      if (deadline !== undefined) clearTimeout(deadline)
      deadline = undefined
      pending = undefined
    }
  }

  /** Asks a question live: after the check that the visitor is a person, which runs only now, and spending one of the day's questions. */
  async function ask(request: AskRequest): Promise<void> {
    if (runMode.value === 'live' && phase.value === 'asking') return
    reset()
    runMode.value = 'live'
    phase.value = 'asking'
    asked.value = request
    const reading = generation
    if (!isAcceptableQuestion(request.question)) {
      fail(new ApiProblem(422, 'invalid_request', 'A question is five to 300 characters.'))
      return
    }
    scope.wait()
    if (!(await session.ensureVerified())) {
      if (reading !== generation) return
      fail(session.available ? (session.problem ?? verificationProblem()) : unavailableProblem())
      return
    }
    if (reading !== generation) return
    askedAt.value = Date.now()
    try {
      const next = await send(request.question.trim())
      if (reading !== generation) return
      take(next)
    }
    catch (error) {
      if (reading !== generation) return
      fail(error)
    }
  }

  /**
   * Stops waiting for the live question. Once the question has been sent the analyst keeps working on it
   * and it still counts, so the next must wait for it; before that, while the check that the visitor is a
   * person is still open, nothing was sent, and stopping only empties the board.
   */
  function stopWaiting(): void {
    if (runMode.value !== 'live' || phase.value !== 'asking') return
    const sent = askedAt.value !== undefined
    stopRun()
    scope.clear()
    phase.value = 'idle'
    runMode.value = 'idle'
    askedAt.value = undefined
    stoppedWaiting.value = sent
    // The service counted the question when it took it, so the count is read again to show that.
    if (sent) void loadQuota()
  }

  /** Holds a recorded answer back until the replay has played out, so a replay shows the work first and the answer at its end. */
  function applyExchange(exchange: Exchange): void {
    if (exchange.request.path !== ASK_PATH || exchange.response.status < 200 || exchange.response.status >= 300) return
    const parsed = answerSchema.safeParse(exchange.response.body)
    if (parsed.success) recordedAnswer = parsed.data
    const question = recordedQuestionSchema.safeParse(exchange.request.body)
    if (question.success && asked.value) asked.value = { ...asked.value, question: question.data.question }
  }

  /** Shows the recorded answer when the replay has played out (a replay that was stopped has not), or says it had none. */
  function finishReplay(): void {
    if (runMode.value !== 'replay' || phase.value !== 'asking') return
    if (!scope.replayed || scope.phase !== 'finished') return
    if (recordedAnswer) answer.value = recordedAnswer
    else problem.value = badAnswerProblem()
    phase.value = 'done'
  }

  // A replay ends when the player says it is no longer playing.
  watch(() => replay.playing, (playing) => {
    if (!playing) finishReplay()
  }, { flush: 'sync' })

  /** Replays a recording: no request is made and nothing is spent. */
  function replayRecording(recording: Recording, source: AskSource): void {
    reset()
    runMode.value = 'replay'
    phase.value = 'asking'
    asked.value = { question: '', source, sampleId: recording.sample }
    replay.start(recording, (_, exchange) => applyExchange(exchange))
  }

  /** Shows a problem the board met outside a question, such as a recording that could not be read. */
  function report(reason: ApiProblem): void {
    problem.value = reason
  }

  /** Stops everything the board is doing, for when the visitor leaves it. */
  function dispose(): void {
    stopRun()
  }

  return {
    quota,
    limits,
    layer,
    layerStatus,
    asked,
    runMode,
    phase,
    askedAt,
    answer,
    problem,
    stoppedWaiting,
    loadQuota,
    loadLayer,
    ask,
    stopWaiting,
    replayRecording,
    report,
    reset,
    dispose,
  }
})
