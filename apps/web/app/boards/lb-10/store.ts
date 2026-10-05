// LB-10's board state: the five prompts the lab measures, the one chosen and the visitor's edit of it (held in this
// page's memory only: never in the address, the title or the browser's storage), the providers to run it on, the
// run on the board (a live one, a replay of a recording, or one of the visitor's runs of today opened again) with
// its report, what is left of the day and whether a failed run was given back, the visitor's runs of today, and the
// nightly results and baselines. The board calls the site's API (`/api/lb10/...`) through the typed client and
// checks every answer with its schema. A run is started with 202 and followed by polling it; nothing is streamed.
// A replay hands the recorded answers back through the same functions, so a live run and a replay are drawn by one
// set of code.
//
// Polling asks one question at a time and the next only after the answer, quickly while the run moves and slowly
// once it has gone on for a while; it stops when the run ends, when the visitor stops waiting or leaves, and after a
// run has taken longer than the service lets any run take. Every read of a run is numbered, and an answer to an older
// read never replaces what a newer one said, so a slow answer cannot move the board backwards; nor can any answer turn
// a run that has ended into one that goes on.
import type { Exchange, Recording } from '@lb/contracts'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'

import { apiClients, callApi } from '~/board-kit/api'
import type { ApiProblem } from '~/board-kit/problem'
import { cookieProblem, isApiProblem, unavailableProblem, verificationProblem } from '~/board-kit/problem'
import type { Quota } from '~/board-kit/quota'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'
import { LB10_SAMPLES } from '#shared/data/samples/lb10'

import { factOf } from './exchange'
import type { RecordedFact } from './exchange'
import { pollDelay, READ_FAILURES_ALLOWED, RUN_PATIENCE_MS, SCOPE_END_GRACE_MS, SCOPE_GRACE_MS } from './pace'
import { checkPrompt } from './prompt'
import type { PromptIssue } from './prompt'
import { isGivenBack } from './report'
import { baselinesSchema, nightlySchema, quotaSchema, runSchema, runsSchema, startedSchema, targetsSchema } from './schemas'
import type { Lb10Baseline, Lb10Limits, Lb10NightlyRow, Lb10Quota, Lb10Run, Lb10Target, Lb10Targets } from './schemas'
import { isOver, takesView } from './views'

/** What is on the board: nothing, a live run (started here or opened again), or a replay of a recording. */
export type RunMode = 'idle' | 'live' | 'replay'
/** Where the run on the board stands: none, being started, being followed, or over (ended, or no longer waited for). */
export type RunPhase = 'idle' | 'starting' | 'following' | 'over'
/** Where reading one thing stands. */
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'failed'
/** Whether a failed run was given back: not a question, being asked, given back, or not (two a day at most). */
export type RefundState = 'none' | 'checking' | 'given' | 'not_given'

/** The service's refusal of a prompt: the prompt it refused and each problem's code and English sentence. */
export interface RefusedPrompt {
  prompt: string
  problems: readonly { code: string, message: string }[]
}

/** The prompt the board opens on: the datasheet's example, LB-01's reply drafter. */
export const FIRST_TARGET = 'lb01-drafter'
/** The provider a run is on until the visitor chooses: the faster of the two. */
export const FIRST_PROVIDERS: readonly string[] = ['groq']

/** The allowance after a run was taken, until the service's own count is read: what the service said is left. */
function afterTaking(quota: Lb10Quota | undefined, remaining: number): Lb10Quota | undefined {
  if (!quota) return quota
  const limit = quota.limits.runs_per_day
  return { ...quota, remaining, used: Math.max(limit - remaining, 0) }
}

/** The allowance after a refusal for a spent day: nothing left, whatever the count said. */
function afterRefusal(quota: Lb10Quota | undefined, resetsAt: string | undefined): Lb10Quota | undefined {
  if (!quota) return quota
  return { ...quota, used: quota.limits.runs_per_day, remaining: 0, resets_at: resetsAt ?? quota.resets_at }
}

/** LB-10's board. */
export const useLb10Store = defineStore('lb10', () => {
  const session = useSessionStore()
  const scope = useScopeStore()
  const replay = useReplayStore()

  const targets = shallowRef<Lb10Targets>()
  const targetsStatus = ref<LoadStatus>('idle')
  const quotaView = shallowRef<Lb10Quota>()
  const mine = shallowRef<readonly Lb10Run[]>([])
  const mineStatus = ref<LoadStatus>('idle')
  const nightly = shallowRef<readonly Lb10NightlyRow[]>([])
  const nightlyStatus = ref<LoadStatus>('idle')
  const baselines = shallowRef<readonly Lb10Baseline[]>([])
  const baselinesStatus = ref<LoadStatus>('idle')

  // The visitor's choice and edit: in memory only.
  const pack = ref<string>(FIRST_TARGET)
  const draft = ref('')
  const providers = ref<string[]>([...FIRST_PROVIDERS])
  const sampleId = ref<string>()

  const runMode = ref<RunMode>('idle')
  const phase = ref<RunPhase>('idle')
  const run = shallowRef<Lb10Run>()
  const problem = shallowRef<ApiProblem>()
  const refused = shallowRef<RefusedPrompt>()
  const refund = ref<RefundState>('none')
  // When the live run began on the board, in Unix milliseconds, for the board's own patience and the "slow" note.
  const followedSince = ref<number>()
  // Whether the visitor stopped waiting for the live run, and whether the board did, past the service's own deadline.
  const stoppedWaiting = ref(false)
  const gaveUp = ref(false)
  // Whether the run on the board was opened again from the visitor's runs, which shows its report and not their prompt.
  const reopened = ref(false)

  // Which run is current: starting another makes every read of an older one stop touching the board.
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  // The number of the last read of the run that was sent, and of the newest one whose answer was taken.
  let readsSent = 0
  let newestShown = 0
  // Whether the request that starts the current run has been sent, so a failure after it reads the day's count again.
  let sent = false
  // What the service said was left of the day once the run was taken: a refund shows as more than that afterwards.
  let remainingAfterStart: number | undefined

  const target = computed<Lb10Target | undefined>(() => targets.value?.targets.find(candidate => candidate.pack === pack.value))
  const limits = computed<Lb10Limits | undefined>(() => targets.value?.limits ?? quotaView.value?.limits)
  const issues = computed<PromptIssue[]>(() => {
    const chosen = target.value
    const max = limits.value?.max_prompt_chars
    return chosen && max !== undefined ? checkPrompt(draft.value, chosen.variables, max) : []
  })
  const unchanged = computed(() => target.value !== undefined && draft.value === target.value.system_prompt)
  const quota = computed<Quota | undefined>(() => (quotaView.value
    ? { limit: quotaView.value.limits.runs_per_day, used: quotaView.value.used, remaining: quotaView.value.remaining, resetsAt: quotaView.value.resets_at }
    : undefined))
  const busy = computed(() => runMode.value === 'live' && (phase.value === 'starting' || phase.value === 'following'))
  const canRun = computed(() => targets.value?.can_run === true)
  const ready = computed(() => target.value !== undefined && issues.value.length === 0 && providers.value.length > 0 && !busy.value)

  // ---- What the board reads when it opens ----

  /** Reads the five prompts and the limits; a failure is said where the prompts would be. */
  async function loadTargets(): Promise<void> {
    targetsStatus.value = 'loading'
    try {
      targets.value = await callApi(apiClients().flask.GET('/api/lb10/targets'), targetsSchema)
      targetsStatus.value = 'ready'
      if (!target.value) pack.value = targets.value.targets[0]?.pack ?? FIRST_TARGET
      if (draft.value === '') draft.value = target.value?.system_prompt ?? ''
    }
    catch {
      targetsStatus.value = 'failed'
    }
  }

  /** Reads what is left of the visitor's day. A failure leaves the old numbers, which is better than blanking them. */
  async function loadQuota(): Promise<void> {
    try {
      quotaView.value = await callApi(apiClients().flask.GET('/api/lb10/quota'), quotaSchema)
    }
    catch {
      // The counter is a nicety: the service still refuses what is over the limit.
    }
  }

  /** Reads the visitor's runs of today, so a reload can take up where it left off. */
  async function loadMine(): Promise<void> {
    mineStatus.value = 'loading'
    try {
      mine.value = (await callApi(apiClients().flask.GET('/api/lb10/runs'), runsSchema)).runs
      mineStatus.value = 'ready'
    }
    catch {
      mine.value = []
      mineStatus.value = 'failed'
    }
  }

  /** Reads the stored nightly results and the committed baselines, which need no model and change once a night at most. */
  async function loadStored(): Promise<void> {
    nightlyStatus.value = 'loading'
    baselinesStatus.value = 'loading'
    const [rows, committed] = await Promise.allSettled([
      callApi(apiClients().flask.GET('/api/lb10/nightly'), nightlySchema),
      callApi(apiClients().flask.GET('/api/lb10/baselines'), baselinesSchema),
    ])
    if (rows.status === 'fulfilled') nightly.value = rows.value.results
    nightlyStatus.value = rows.status === 'fulfilled' ? 'ready' : 'failed'
    if (committed.status === 'fulfilled') baselines.value = committed.value.baselines
    baselinesStatus.value = committed.status === 'fulfilled' ? 'ready' : 'failed'
  }

  /** Reads everything the board shows before a run: the prompts, the day's count, the visitor's runs and the stored results. */
  async function load(): Promise<void> {
    await Promise.all([loadTargets(), loadQuota(), loadMine(), loadStored()])
  }

  /** Keeps the visitor's list of runs in step with the live run on the board, so a new run is listed at once. */
  function noteMine(view: Lb10Run): void {
    mine.value = [view, ...mine.value.filter(item => item.run_id !== view.run_id)].slice(0, 20)
  }

  // ---- The visitor's choice and edit ----

  /** Chooses the prompt to measure, and starts the edit again from its production prompt. */
  function chooseTarget(name: string): void {
    const chosen = targets.value?.targets.find(candidate => candidate.pack === name)
    if (!chosen) return
    pack.value = name
    draft.value = chosen.system_prompt
    sampleId.value = undefined
    refused.value = undefined
  }

  /** Takes the visitor's edit as they type it. A refusal stays beside the prompt until the prompt it was about is changed. */
  function setDraft(text: string): void {
    draft.value = text
    if (refused.value && refused.value.prompt !== text) refused.value = undefined
  }

  /** Puts production's prompt back in the editor. */
  function resetDraft(): void {
    if (target.value) setDraft(target.value.system_prompt)
  }

  /** Chooses or drops a provider. At least one must be chosen to run; the service takes two at most. */
  function setProvider(id: string, chosen: boolean): void {
    const without = providers.value.filter(item => item !== id)
    providers.value = chosen ? [...without, id] : without
  }

  /** Puts a prepared edit in the editor: its prompt, its edit and its providers. */
  function chooseSample(id: string): void {
    const sample = LB10_SAMPLES.find(candidate => candidate.id === id)
    if (!sample) return
    pack.value = sample.pack
    draft.value = sample.prompt
    providers.value = [...sample.providers]
    sampleId.value = id
    refused.value = undefined
  }

  // ---- Calls that change something ----

  /**
   * Makes a call that changes something. It first makes sure the visitor has passed the check that they are a
   * person. If the service says the check is needed again (a new day began), runs it and tries once more. If it
   * still says so right after the check passed, the browser is not keeping the session cookie that holds the
   * result, which the visitor can fix, so that is said and not retried.
   */
  async function write<T>(make: () => Promise<T>): Promise<T> {
    if (!(await session.ensureVerified())) throw session.available ? (session.problem ?? verificationProblem()) : unavailableProblem()
    try {
      return await make()
    }
    catch (error) {
      if (!isApiProblem(error) || error.kind !== 'verification') throw error
      session.forgetVerification()
      if (!(await session.ensureVerified())) throw verificationProblem()
      try {
        return await make()
      }
      catch (again) {
        throw isApiProblem(again) && again.kind === 'verification' ? cookieProblem() : again
      }
    }
  }

  // ---- Stopping and starting over ----

  /** Cancels what the board is doing for the current run: its polling, its replay and its trace reading. */
  function stopRun(): void {
    generation += 1
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    replay.stop()
    scope.stop()
  }

  /** Forgets the run on the board and what was read of it. */
  function clearRun(): void {
    run.value = undefined
    followedSince.value = undefined
    readsSent = 0
    newestShown = 0
    remainingAfterStart = undefined
  }

  /** Empties the board for the next run, keeping the visitor's choice and edit. */
  function reset(): void {
    stopRun()
    scope.clear()
    replay.clear()
    clearRun()
    runMode.value = 'idle'
    phase.value = 'idle'
    problem.value = undefined
    refund.value = 'none'
    stoppedWaiting.value = false
    gaveUp.value = false
    reopened.value = false
    sent = false
  }

  /** Shows why a run could not be started or followed. A refused prompt goes beside the prompt; a spent day sets the count to nothing left. */
  function fail(reason: unknown, prompt: string | undefined): void {
    const failure = isApiProblem(reason) ? reason : unavailableProblem()
    if (failure.code === 'invalid_prompt' && prompt !== undefined) {
      refused.value = { prompt, problems: failure.problems.map(item => ({ code: item.code, message: item.message })) }
      if (refused.value.problems.length === 0) refused.value = { prompt, problems: [{ code: 'other', message: failure.message }] }
    }
    else {
      problem.value = failure
    }
    if (run.value === undefined) {
      scope.clear()
      runMode.value = 'idle'
      phase.value = 'idle'
    }
    else {
      phase.value = 'over'
      scope.settle()
    }
    if (failure.code === 'daily_limit') quotaView.value = afterRefusal(quotaView.value, failure.resetsAt)
    else if (sent) void loadQuota()
  }

  // ---- A run on the board ----

  /** Takes the service's view of the run, unless it is older than the newest view taken, or would turn an ended run back into a running one. */
  function acceptView(view: Lb10Run, read?: number): void {
    if (!takesView(run.value, view, read, newestShown)) return
    if (read !== undefined) newestShown = read
    run.value = view
    if (runMode.value === 'live') noteMine(view)
  }

  /** Starts following a live run on the board, and its trace: the service names the run when it starts it. */
  function follow(view: Lb10Run, reading: number, polls: number): void {
    phase.value = 'following'
    followedSince.value = Date.now()
    scope.follow(view.run_id, { notFoundGraceMs: SCOPE_GRACE_MS })
    schedulePoll(view.run_id, reading, Date.now(), 0, polls)
  }

  /** Waits, then reads the run again, unless the board has moved on to something else. */
  function schedulePoll(runId: string, reading: number, since: number, failedReads: number, polls: number): void {
    timer = setTimeout(() => void pollRun(runId, reading, since, failedReads, polls), pollDelay(polls))
  }

  /** Reads where a run stands and carries on until it is over. */
  async function pollRun(runId: string, reading: number, since: number, failedReads: number, polls: number): Promise<void> {
    if (reading !== generation) return
    readsSent += 1
    const read = readsSent
    try {
      const view = await callApi(apiClients().flask.GET('/api/lb10/runs/{run_id}', { params: { path: { run_id: runId } } }), runSchema)
      if (reading !== generation) return
      acceptView(view, read)
      const current = run.value ?? view
      if (isOver(current.state)) return wrapUp(current)
      if (Date.now() - since > RUN_PATIENCE_MS) return giveUp()
      schedulePoll(runId, reading, since, 0, polls + 1)
    }
    catch (error) {
      if (reading !== generation) return
      const failed = failedReads + 1
      if (!isApiProblem(error) || failed >= READ_FAILURES_ALLOWED || error.kind === 'notFound') {
        fail(error, undefined)
        return
      }
      schedulePoll(runId, reading, since, failed, polls + 1)
    }
  }

  /** Stops waiting on a run that has not ended past the moment the service ends any run, and says so. */
  function giveUp(): void {
    gaveUp.value = true
    phase.value = 'over'
    scope.settle()
    void loadQuota()
    void loadMine()
  }

  /**
   * Reads what an ended run changes: the day's count (and from it, for a failure the service gives back, whether it
   * was given back) and the visitor's list; and has the Scope read the trace to its end, looking again if it had
   * stopped (the root span is written as the run ends).
   */
  async function wrapUp(view: Lb10Run): Promise<void> {
    phase.value = 'over'
    if (scope.runId !== view.run_id || scope.phase === 'missing' || scope.phase === 'stalled' || scope.phase === 'failed') {
      scope.follow(view.run_id, { keepSpans: scope.runId === view.run_id, notFoundGraceMs: SCOPE_END_GRACE_MS })
    }
    scope.settle()
    void loadMine()
    const asks = view.state === 'failed' && isGivenBack(view.failure) && remainingAfterStart !== undefined
    if (asks) refund.value = 'checking'
    await loadQuota()
    if (asks && refund.value === 'checking') {
      refund.value = (quotaView.value?.remaining ?? 0) > (remainingAfterStart ?? 0) ? 'given' : 'not_given'
    }
  }

  // ---- Starting a run ----

  /** Runs the edit in the editor live, on the chosen providers: it takes the visitor's run of the day and costs model calls. Needs the check. */
  async function runLive(): Promise<void> {
    const chosen = target.value
    if (busy.value || !chosen || !ready.value) return
    const prompt = draft.value
    const body = { target: chosen.pack, prompt, providers: [...providers.value] }
    reset()
    refused.value = undefined
    runMode.value = 'live'
    phase.value = 'starting'
    scope.wait()
    const reading = generation
    try {
      const started = await write(() => {
        sent = true
        return callApi(apiClients().flask.POST('/api/lb10/runs', { body }), startedSchema)
      })
      if (reading !== generation) return
      remainingAfterStart = started.remaining_runs
      quotaView.value = afterTaking(quotaView.value, started.remaining_runs)
      acceptView(started.run)
      if (isOver(started.run.state)) return wrapUp(started.run)
      follow(started.run, reading, 0)
    }
    catch (error) {
      if (reading === generation) fail(error, prompt)
    }
  }

  /** Takes up one of the visitor's runs of today, as it stands: a finished one shows its report, one still going is followed. */
  async function openRun(runId: string): Promise<void> {
    if (busy.value) return
    reset()
    runMode.value = 'live'
    phase.value = 'starting'
    reopened.value = true
    const reading = generation
    try {
      const view = await callApi(apiClients().flask.GET('/api/lb10/runs/{run_id}', { params: { path: { run_id: runId } } }), runSchema)
      if (reading !== generation) return
      if (targets.value?.targets.some(candidate => candidate.pack === view.pack)) pack.value = view.pack
      acceptView(view)
      if (isOver(view.state)) return wrapUp(view)
      follow(view, reading, 1)
    }
    catch (error) {
      if (reading === generation) fail(error, undefined)
    }
  }

  /** Stops waiting for the live run. The service goes on with it and it still counts, so the board says so and lists it. */
  function stopWaiting(): void {
    if (runMode.value !== 'live' || !busy.value) return
    const taken = run.value !== undefined
    stopRun()
    scope.clear()
    clearRun()
    phase.value = 'idle'
    runMode.value = 'idle'
    stoppedWaiting.value = taken
    if (taken || sent) void loadQuota()
    if (taken) void loadMine()
  }

  // ---- A replay of a recording ----

  /** Applies one recorded answer to the board, as if the API had just said it. */
  function applyFact(fact: RecordedFact): void {
    if (fact.kind === 'started') {
      acceptView(fact.started.run)
      phase.value = 'following'
      return
    }
    acceptView(fact.run)
  }

  // A replay ends when the player says it is no longer playing: what was recorded is all there is, so the run is over.
  watch(() => replay.playing, (playing) => {
    if (!playing && runMode.value === 'replay' && phase.value === 'following') phase.value = 'over'
  }, { flush: 'sync' })

  /** Replays a recording of a prepared edit, with that edit in the editor: no request is made and nothing is spent. */
  function replayRecording(recording: Recording, id: string): void {
    reset()
    chooseSample(id)
    runMode.value = 'replay'
    phase.value = 'starting'
    replay.start(recording, (_, exchange: Exchange) => {
      const fact = factOf(exchange)
      if (fact) applyFact(fact)
    })
  }

  /** Shows a problem the board met outside a call, such as a recording that could not be read. */
  function showProblem(reason: ApiProblem): void {
    problem.value = reason
  }

  /** Stops everything the board is doing, for when the visitor leaves it. */
  function dispose(): void {
    stopRun()
  }

  /** Forgets everything, the visitor's edit included, for a board opened afresh. */
  function clearAll(): void {
    reset()
    refused.value = undefined
    pack.value = FIRST_TARGET
    draft.value = ''
    providers.value = [...FIRST_PROVIDERS]
    sampleId.value = undefined
  }

  return {
    targets,
    targetsStatus,
    quotaView,
    quota,
    mine,
    mineStatus,
    nightly,
    nightlyStatus,
    baselines,
    baselinesStatus,
    pack,
    draft,
    providers,
    sampleId,
    target,
    limits,
    issues,
    unchanged,
    runMode,
    phase,
    run,
    problem,
    refused,
    refund,
    followedSince,
    stoppedWaiting,
    gaveUp,
    reopened,
    busy,
    canRun,
    ready,
    load,
    loadTargets,
    loadQuota,
    loadMine,
    loadStored,
    chooseTarget,
    setDraft,
    resetDraft,
    setProvider,
    chooseSample,
    runLive,
    openRun,
    stopWaiting,
    replayRecording,
    showProblem,
    reset,
    clearAll,
    dispose,
  }
})
