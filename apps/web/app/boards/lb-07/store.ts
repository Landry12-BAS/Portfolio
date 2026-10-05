// LB-07's board state: the test run on the board (a curated sample, the visitor's own goal and bugs, or one
// of their runs of the last hour), where it stands, its report, its generated test and its evidence, what
// is left of the visitor's day, and their runs of the hour. The board calls the site's API (`/api/lb07/...`)
// through the typed client and checks every answer with the contracts' schemas. A run is followed by
// polling it: it is queued at once and the service moves it through planning, running, the second engine,
// the reports and the clean shop; nothing is streamed. A replay of a recording hands the same answers back
// through the same functions, so a live run and a replay are drawn by one set of code.
//
// Polling asks one question at a time and the next only after the answer, quickly while the run moves and
// slowly while it waits for other visitors' runs; it stops when the run ends, when the visitor stops
// waiting or leaves, and after a run has taken far longer than any honest one. Every read of a run is
// numbered, and an answer to an older read never replaces what a newer one said, so a slow answer cannot
// move the board backwards; nor can any answer turn a run that has ended into one that goes on.
import type { Exchange, Lb07BugId, Lb07CreateRunRequest, Lb07Engine, Recording } from '@lb/contracts'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'

import { apiClients, callApi } from '~/board-kit/api'
import { ApiProblem, cookieProblem, isApiProblem, unavailableProblem, verificationProblem } from '~/board-kit/problem'
import type { Quota } from '~/board-kit/quota'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'
import { screenshotBytes, screenshotPath } from '#shared/lb07-evidence'

import { factOf } from './exchange'
import type { RecordedFact } from './exchange'
import { pollDelay, READ_FAILURES_ALLOWED, RUN_PATIENCE_MS, SCOPE_END_GRACE_MS, SCOPE_GRACE_MS } from './pace'
import { evidenceNumber, evidenceRefs, isOver } from './run'
import type { EvidenceRef } from './run'
import { lb07EvidenceViewSchema, lb07LimitsViewSchema, lb07ReportSchema, lb07RunViewSchema, lb07TestViewSchema, runListSchema } from './schemas'
import type { Lb07EvidenceView, Lb07LimitsView, Lb07Report, Lb07RunView, Lb07TestView } from './schemas'

/** What is on the board: nothing, a live run, or a replay of a recording. */
export type RunMode = 'idle' | 'live' | 'replay'
/** Where the run on the board stands: none, being started, being followed, or over (ended, or no longer waited for). */
export type RunPhase = 'idle' | 'starting' | 'following' | 'over'
/** Where reading one thing stands. */
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'failed'

/** What the visitor asked to have run. */
export type Asked
  = | { kind: 'sample', sampleId: string }
    | { kind: 'custom' }

/** One piece of evidence as the board shows it: a screenshot with where its picture comes from, or the page's tree as text. */
export interface EvidenceItem {
  id: string
  kind: 'screenshot' | 'snapshot'
  // The step it was taken after (null for the run's end), the engine, and the page, when a finding names it.
  stepIndex: number | null
  engine: Lb07Engine
  path: string | null
  // A screenshot's picture: the site's own address for a live run, a `data:` address of the recorded PNG for a replay. Undefined for a recorded picture that is not a PNG the site may show.
  src?: string
  // The page's tree, for a snapshot.
  text?: string
}

/** The allowance after a run was taken, until the service's own count is read: one more used. */
function afterTaking(limits: Lb07LimitsView | undefined): Lb07LimitsView | undefined {
  if (!limits) return limits
  const used = Math.min(limits.runs.used + 1, limits.runs.limit)
  return { ...limits, runs: { ...limits.runs, used, remaining: Math.max(limits.runs.limit - used, 0) } }
}

/** The allowance after a refusal for a spent day: nothing left, whatever the count said. */
function afterRefusal(limits: Lb07LimitsView | undefined): Lb07LimitsView | undefined {
  return limits ? { ...limits, runs: { limit: limits.runs.limit, used: limits.runs.limit, remaining: 0 } } : limits
}

/** Builds what the board shows of a piece of evidence the service sent: a live screenshot is read from the site's own route, a recorded one from its own bytes. */
function itemOf(evidence: Lb07EvidenceView, runId: string, live: boolean, ref: EvidenceRef | undefined): EvidenceItem {
  const known = { id: evidence.id, stepIndex: evidence.stepIndex, engine: evidence.engine, path: ref?.path ?? null }
  if (evidence.kind === 'snapshot') return { ...known, kind: 'snapshot', text: evidence.text }
  if (live) return { ...known, kind: 'screenshot', src: screenshotPath(runId, evidence.id) }
  return { ...known, kind: 'screenshot', src: screenshotBytes(evidence.base64) ? `data:image/png;base64,${evidence.base64}` : undefined }
}

/** Puts evidence in the order the run kept it. */
function inOrder(items: readonly EvidenceItem[]): EvidenceItem[] {
  return [...items].sort((a, b) => evidenceNumber(a.id) - evidenceNumber(b.id))
}

/** LB-07's board. */
export const useLb07Store = defineStore('lb07', () => {
  const session = useSessionStore()
  const scope = useScopeStore()
  const replay = useReplayStore()

  const runMode = ref<RunMode>('idle')
  const phase = ref<RunPhase>('idle')
  const asked = shallowRef<Asked>()
  const problem = shallowRef<ApiProblem>()
  const actionProblem = shallowRef<ApiProblem>()
  const limits = shallowRef<Lb07LimitsView>()
  const mine = shallowRef<readonly Lb07RunView[]>([])
  const mineStatus = ref<LoadStatus>('idle')

  const run = shallowRef<Lb07RunView>()
  const report = shallowRef<Lb07Report>()
  const reportStatus = ref<LoadStatus>('idle')
  const test = shallowRef<Lb07TestView>()
  const testStatus = ref<LoadStatus>('idle')
  const evidence = shallowRef<readonly EvidenceItem[]>([])
  const evidenceStatus = ref<LoadStatus>('idle')
  // When the live run began on the board, in Unix milliseconds, for the board's own patience.
  const followedSince = ref<number>()
  // Whether the visitor stopped waiting for the live run, which the service goes on with.
  const stoppedWaiting = ref(false)
  const deleting = ref(false)

  // Which run is current: starting another makes every read of an older one stop touching the board.
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  // The number of the last read of the run that was sent, and of the newest one whose answer was taken.
  let readsSent = 0
  let newestShown = 0
  // Whether the Scope follows the run's trace yet: it waits while the run is in the queue.
  let scopeFollows = false
  // Whether the request that starts the current run has been sent, so a failure after it reads the day's count again.
  let sent = false
  // The pieces of evidence the report names, for the path each was taken on.
  let namedEvidence: EvidenceRef[] = []

  const quota = computed<Quota | undefined>(() => (limits.value ? { ...limits.value.runs, resetsAt: limits.value.resetsAt } : undefined))
  const busy = computed(() => runMode.value === 'live' && (phase.value === 'starting' || phase.value === 'following'))

  // ---- The visitor's day and their runs ----

  /** Reads what is left of the visitor's day. A failure leaves the old numbers, which is better than blanking them. */
  async function loadLimits(): Promise<void> {
    try {
      limits.value = await callApi(apiClients().node.GET('/api/lb07/limits'), lb07LimitsViewSchema)
    }
    catch {
      // The counter is a nicety: the service still refuses what is over the limit.
    }
  }

  /** Reads the visitor's runs of the last hour, so a reload can take up where it left off. */
  async function loadMine(): Promise<void> {
    mineStatus.value = 'loading'
    try {
      mine.value = await callApi(apiClients().node.GET('/api/lb07/runs'), runListSchema)
      mineStatus.value = 'ready'
    }
    catch {
      mine.value = []
      mineStatus.value = 'failed'
    }
  }

  /** Keeps the visitor's list of runs in step with the live run on the board, so a new run is listed at once. */
  function noteMine(view: Lb07RunView): void {
    mine.value = [view, ...mine.value.filter(item => item.id !== view.id)].slice(0, 10)
  }

  // ---- Calls that change something ----

  /**
   * Makes a call that changes something. It first makes sure the visitor has passed the check that they are a
   * person. If the service says the check is needed again (a new day began), runs it and tries once more. If
   * it still says so right after the check passed, the browser is not keeping the session cookie that holds the
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
    report.value = undefined
    reportStatus.value = 'idle'
    test.value = undefined
    testStatus.value = 'idle'
    evidence.value = []
    evidenceStatus.value = 'idle'
    namedEvidence = []
    followedSince.value = undefined
    readsSent = 0
    newestShown = 0
    scopeFollows = false
  }

  /** Empties the board for the next run. */
  function reset(): void {
    stopRun()
    scope.clear()
    replay.clear()
    clearRun()
    runMode.value = 'idle'
    phase.value = 'idle'
    asked.value = undefined
    problem.value = undefined
    actionProblem.value = undefined
    stoppedWaiting.value = false
    deleting.value = false
    sent = false
  }

  /** Shows why a run could not be started or followed. A refusal for a spent day sets the counter to nothing left; any other failure after something was sent reads the count again. */
  function fail(reason: unknown): void {
    problem.value = isApiProblem(reason) ? reason : unavailableProblem()
    if (run.value === undefined) {
      scope.clear()
      runMode.value = 'idle'
      phase.value = 'idle'
    }
    else {
      phase.value = 'over'
      scope.settle()
    }
    if (problem.value.code === 'daily_limit') limits.value = afterRefusal(limits.value)
    else if (sent) void loadLimits()
  }

  // ---- A run on the board ----

  /** Takes the service's view of the run, unless it is older than the newest view taken, or would turn an ended run back into a running one. */
  function acceptView(view: Lb07RunView, read?: number): void {
    const current = run.value
    if (current !== undefined && current.id !== view.id) return
    if (read !== undefined) {
      if (read < newestShown) return
      newestShown = read
    }
    if (current !== undefined && isOver(current.state) && !isOver(view.state)) return
    run.value = view
    if (runMode.value === 'live') noteMine(view)
  }

  /** Has the Scope wait while the run is in the queue, and follow the run's trace once it has started. */
  function scopeFor(view: Lb07RunView): void {
    if (scopeFollows) return
    if (view.startedAt === null && view.state === 'queued') {
      if (scope.phase !== 'waiting') scope.wait()
      return
    }
    scopeFollows = true
    scope.follow(view.runId, { notFoundGraceMs: SCOPE_GRACE_MS })
  }

  /** Starts following a live run on the board. */
  function follow(view: Lb07RunView, reading: number, polls: number): void {
    phase.value = 'following'
    followedSince.value = Date.now()
    scopeFor(view)
    schedulePoll(view, reading, Date.now(), 0, polls)
  }

  /** Waits, then reads the run again, unless the board has moved on to something else. */
  function schedulePoll(view: Lb07RunView, reading: number, since: number, failedReads: number, polls: number): void {
    timer = setTimeout(() => void pollRun(view.id, reading, since, failedReads, polls), pollDelay(view, polls))
  }

  /** Reads where a run stands and carries on until it is over. */
  async function pollRun(id: string, reading: number, since: number, failedReads: number, polls: number): Promise<void> {
    if (reading !== generation) return
    readsSent += 1
    const read = readsSent
    try {
      const view = await callApi(apiClients().node.GET('/api/lb07/runs/{id}', { params: { path: { id } } }), lb07RunViewSchema)
      if (reading !== generation) return
      acceptView(view, read)
      const current = run.value ?? view
      scopeFor(current)
      if (isOver(current.state)) return wrapUp(current, reading)
      if (Date.now() - since > RUN_PATIENCE_MS) return giveUp()
      schedulePoll(current, reading, since, 0, polls + 1)
    }
    catch (error) {
      if (reading !== generation) return
      const failed = failedReads + 1
      if (!isApiProblem(error) || failed >= READ_FAILURES_ALLOWED || error.kind === 'notFound') {
        fail(error)
        return
      }
      const current = run.value
      if (current) schedulePoll(current, reading, since, failed, polls + 1)
    }
  }

  /** Stops waiting on a run that has not ended for far too long, and says so. The service ends every run on its own. */
  function giveUp(): void {
    problem.value = new ApiProblem(504, 'run_timeout', 'The run is taking longer than expected.')
    phase.value = 'over'
    scope.settle()
    void loadLimits()
  }

  /** Reads what an ended run leaves: the report and the test of a run that is done, what is left of the day, and the visitor's list; and has the Scope read the trace to its end. */
  async function wrapUp(view: Lb07RunView, reading: number): Promise<void> {
    phase.value = 'over'
    // A run that never left the queue was never followed, and a Scope that gave up looking (a long queue) looks again: the root span is written as the run ends.
    if (!scopeFollows || scope.phase === 'missing' || scope.phase === 'stalled' || scope.phase === 'failed') {
      scopeFollows = true
      scope.follow(view.runId, { keepSpans: scope.runId === view.runId, notFoundGraceMs: SCOPE_END_GRACE_MS })
    }
    scope.settle()
    void loadLimits()
    void loadMine()
    if (view.state !== 'done') return
    await Promise.all([loadReport(view, reading), loadTest(view, reading)])
  }

  /** Reads the report of a finished run, then its evidence. */
  async function loadReport(view: Lb07RunView, reading: number): Promise<void> {
    reportStatus.value = 'loading'
    try {
      const answer = await callApi(apiClients().node.GET('/api/lb07/runs/{id}/report', { params: { path: { id: view.id } } }), lb07ReportSchema)
      if (reading !== generation) return
      report.value = answer
      reportStatus.value = 'ready'
      await loadEvidence(view, answer, reading)
    }
    catch {
      if (reading === generation) reportStatus.value = 'failed'
    }
  }

  /** Reads the generated test of a finished run. */
  async function loadTest(view: Lb07RunView, reading: number): Promise<void> {
    testStatus.value = 'loading'
    try {
      const answer = await callApi(apiClients().node.GET('/api/lb07/runs/{id}/test', { params: { path: { id: view.id } } }), lb07TestViewSchema)
      if (reading !== generation) return
      test.value = answer
      testStatus.value = 'ready'
    }
    catch {
      if (reading === generation) testStatus.value = 'failed'
    }
  }

  /**
   * Reads the evidence of a finished run. The screenshots the findings name are shown from the site's own
   * route, which needs no read here; the two pieces the run keeps at its end are read to learn what they are
   * (a screenshot, or the page's tree as text), one after the other, stopping at the first that is not there.
   */
  async function loadEvidence(view: Lb07RunView, answer: Lb07Report, reading: number): Promise<void> {
    evidenceStatus.value = 'loading'
    const { named, closing } = evidenceRefs(answer)
    namedEvidence = named
    const items: EvidenceItem[] = named.map(ref => ({ id: ref.id, kind: 'screenshot', stepIndex: ref.stepIndex, engine: ref.engine ?? 'chromium', path: ref.path, src: screenshotPath(view.id, ref.id) }))
    for (const id of closing) {
      try {
        const piece = await callApi(apiClients().node.GET('/api/lb07/runs/{id}/evidence/{evidenceId}', { params: { path: { id: view.id, evidenceId: id } } }), lb07EvidenceViewSchema)
        if (reading !== generation) return
        items.push(itemOf(piece, view.id, true, undefined))
      }
      catch {
        if (reading !== generation) return
        break
      }
    }
    evidence.value = inOrder(items)
    evidenceStatus.value = 'ready'
  }

  // ---- Starting a run ----

  /** Starts a run live: it takes one of the visitor's runs for the day and costs its model calls. Needs the check. */
  async function start(request: Lb07CreateRunRequest, what: Asked): Promise<void> {
    if (busy.value) return
    reset()
    runMode.value = 'live'
    phase.value = 'starting'
    asked.value = what
    scope.wait()
    const reading = generation
    try {
      const view = await write(() => {
        sent = true
        return callApi(apiClients().node.POST('/api/lb07/runs', { body: request }), lb07RunViewSchema)
      })
      if (reading !== generation) return
      limits.value = afterTaking(limits.value)
      acceptView(view)
      if (isOver(view.state)) return wrapUp(view, reading)
      follow(view, reading, 0)
    }
    catch (error) {
      if (reading === generation) fail(error)
    }
  }

  /** Runs one of the curated samples live. */
  function runSample(sampleId: string): Promise<void> {
    return start({ from: 'sample', sampleId }, { kind: 'sample', sampleId })
  }

  /** Runs the visitor's own goal with the bugs they switched on. */
  function runCustom(goal: string, bugs: readonly Lb07BugId[]): Promise<void> {
    return start({ from: 'custom', goal: goal.trim(), bugs: [...bugs] }, { kind: 'custom' })
  }

  /** Takes up one of the visitor's own runs of the last hour, as it stands: a finished one is read whole, one still going is followed. */
  async function openRun(id: string): Promise<void> {
    if (busy.value) return
    reset()
    runMode.value = 'live'
    phase.value = 'starting'
    const reading = generation
    try {
      const view = await callApi(apiClients().node.GET('/api/lb07/runs/{id}', { params: { path: { id } } }), lb07RunViewSchema)
      if (reading !== generation) return
      asked.value = view.origin === 'sample' && view.sampleId !== null ? { kind: 'sample', sampleId: view.sampleId } : { kind: 'custom' }
      acceptView(view)
      if (isOver(view.state)) return wrapUp(view, reading)
      follow(view, reading, 1)
    }
    catch (error) {
      if (reading === generation) fail(error)
    }
  }

  /** Stops waiting for the live run. The service goes on with it and it still counts, so the board says so and lists it. */
  function stopWaiting(): void {
    if (runMode.value !== 'live' || !busy.value) return
    const queued = run.value !== undefined
    stopRun()
    scope.clear()
    clearRun()
    phase.value = 'idle'
    runMode.value = 'idle'
    stoppedWaiting.value = queued
    if (queued || sent) void loadLimits()
    if (queued) void loadMine()
  }

  /** Deletes the live run on the board now, instead of at the end of its hour. It does not give back the visitor's run. Needs the check. */
  async function deleteRun(): Promise<void> {
    const current = run.value
    if (!current || runMode.value !== 'live' || deleting.value) return
    deleting.value = true
    actionProblem.value = undefined
    try {
      await write(async () => {
        const result = await apiClients().node.DELETE('/api/lb07/runs/{id}', { params: { path: { id: current.id } } })
        if (!result.response.ok && result.response.status !== 404) throw new ApiProblem(result.response.status, 'delete_failed', 'The run could not be deleted.')
      })
      reset()
      void loadMine()
      void loadLimits()
    }
    catch (error) {
      actionProblem.value = isApiProblem(error) ? error : unavailableProblem()
    }
    finally {
      deleting.value = false
    }
  }

  // ---- A replay of a recording ----

  /** Applies one recorded answer to the board, as if the API had just said it. */
  function applyFact(fact: RecordedFact): void {
    switch (fact.kind) {
      case 'started':
        acceptView(fact.view)
        phase.value = 'following'
        break
      case 'view':
        acceptView(fact.view)
        break
      case 'report':
        report.value = fact.report
        reportStatus.value = 'ready'
        namedEvidence = evidenceRefs(fact.report).named
        evidenceStatus.value = 'ready'
        break
      case 'test':
        test.value = fact.test
        testStatus.value = 'ready'
        break
      case 'evidence': {
        const runId = run.value?.id ?? ''
        const ref = namedEvidence.find(candidate => candidate.id === fact.evidence.id)
        evidence.value = inOrder([...evidence.value.filter(item => item.id !== fact.evidence.id), itemOf(fact.evidence, runId, false, ref)])
        evidenceStatus.value = 'ready'
        break
      }
    }
  }

  // A replay ends when the player says it is no longer playing: what was recorded is all there is, so the run is over.
  watch(() => replay.playing, (playing) => {
    if (!playing && runMode.value === 'replay' && phase.value === 'following') phase.value = 'over'
  }, { flush: 'sync' })

  /** Replays a recording: no request is made and nothing is spent. */
  function replayRecording(recording: Recording, request: Asked): void {
    reset()
    runMode.value = 'replay'
    phase.value = 'starting'
    asked.value = request
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

  return {
    runMode,
    phase,
    asked,
    problem,
    actionProblem,
    limits,
    quota,
    mine,
    mineStatus,
    run,
    report,
    reportStatus,
    test,
    testStatus,
    evidence,
    evidenceStatus,
    followedSince,
    stoppedWaiting,
    deleting,
    busy,
    loadLimits,
    loadMine,
    runSample,
    runCustom,
    openRun,
    stopWaiting,
    deleteRun,
    replayRecording,
    showProblem,
    reset,
    dispose,
  }
})
