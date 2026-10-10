// LB-04's board state: the contract on the board (a sample, a file the visitor sent, or one of their own
// from the last hour), the state of its review, its pages' text, its PDF, its report with the redlines made
// so far, what is left of the visitor's day and the playbook the review is read against. The board calls
// the site's API (`/api/lb04/...`) through the typed client and checks every answer with the contracts'
// schemas. A review is followed by polling the contract: it is queued at once and the service moves it
// through reading, analysing and verifying; nothing is streamed. A replay of a recording hands the same
// answers back through the same functions, so a live review and a replay are drawn by one set of code.
//
// The PDF and the page text are fetched when the review has got far enough to have them, and the PDF
// only when the viewer asks for it, since it is the largest thing the service sends. A file the visitor
// sent is kept in the browser as well, so the viewer needs no second copy from the service.
import type { Exchange, Lb04State, Recording } from '@lb/contracts'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'

import { apiClients, callApi } from '~/board-kit/api'
import { ApiProblem, cookieProblem, isApiProblem, unavailableProblem, verificationProblem } from '~/board-kit/problem'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import { factOf } from './exchange'
import type { RecordedFact } from './exchange'
import { fromBase64, prepareFile } from './file'
import type { FileProblem } from './file'
import { afterRefusal, afterTaking, pollDelay, quotaFrom, READ_FAILURES_ALLOWED, REVIEW_PATIENCE_MS, SCOPE_GRACE_MS } from './limits'
import { contractListSchema, lb04ContractViewSchema, lb04FileViewSchema, lb04LimitsViewSchema, lb04PagesViewSchema, lb04PlaybookViewSchema, lb04RedlineSchema, lb04ReportSchema } from './schemas'
import type { Lb04ContractView, Lb04LimitsView, Lb04PlaybookView, Lb04Redline, Lb04Report } from './schemas'

/** What is on the board: nothing, a live review, or a replay of a recording. */
export type RunMode = 'idle' | 'live' | 'replay'
/** Where the review on the board stands: none, being started, being followed, or over (done, failed, or not waited for any longer). */
export type ReviewPhase = 'idle' | 'starting' | 'following' | 'over'

/** What the visitor asked to have reviewed. */
export type Asked
  = | { kind: 'sample', sampleId: string }
    | { kind: 'file', filename: string, size: number }

/** One page of a contract's text. */
export interface ContractPage {
  page: number
  text: string
}

/** A moment the viewer is asked to go to: a finding's passage. Each ask has its own tick, so asking for the same finding again is still an ask. */
export interface Focus {
  findingId: string
  tick: number
}

/** The failures that need the visitor's own file turned into the problem the board says it with. */
const FILE_PROBLEMS: Readonly<Record<FileProblem, ApiProblem>> = {
  empty: new ApiProblem(415, 'not_a_pdf', 'The file is empty.'),
  tooLarge: new ApiProblem(413, 'file_too_large', 'The file is too large.'),
  notPdf: new ApiProblem(415, 'not_a_pdf', 'The file is not a PDF.'),
}

// The longest file name the service takes.
const MAX_FILENAME = 200

/** Tells whether a state is the end of a review. */
function isOver(state: Lb04State): boolean {
  return state === 'done' || state === 'failed'
}

/** LB-04's board. */
export const useLb04Store = defineStore('lb04', () => {
  const session = useSessionStore()
  const scope = useScopeStore()
  const replay = useReplayStore()

  const runMode = ref<RunMode>('idle')
  const phase = ref<ReviewPhase>('idle')
  const asked = shallowRef<Asked>()
  const problem = shallowRef<ApiProblem>()
  const redlineProblem = shallowRef<ApiProblem>()
  const limits = shallowRef<Lb04LimitsView>()
  const playbook = shallowRef<Lb04PlaybookView>()
  const playbookStatus = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const mine = shallowRef<readonly Lb04ContractView[]>([])
  const mineStatus = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')

  // The contract on the board, and what has been read of it.
  const contract = shallowRef<Lb04ContractView>()
  const pages = shallowRef<readonly ContractPage[]>()
  const pdf = shallowRef<Uint8Array>()
  const pdfStatus = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const report = shallowRef<Lb04Report>()
  const redlining = ref<string>()
  const focus = shallowRef<Focus>()
  // When the live review began, in Unix milliseconds, for the time the board counts while it waits.
  const startedAt = ref<number>()
  // Whether the visitor stopped waiting for the live review, which the service goes on with.
  const stoppedWaiting = ref(false)

  // Which review is current: starting another makes every read of an older one stop touching the board.
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  // Whether the pages are being, or have been, asked for in the current review.
  let pagesAsked = false
  // Whether the current review's request to start has been sent, so a failure after that leaves the day's count to be read again.
  let sent = false
  let tick = 0

  const quota = computed(() => quotaFrom(limits.value))
  const failure = computed(() => contract.value?.failure ?? undefined)
  const busy = computed(() => runMode.value === 'live' && (phase.value === 'starting' || phase.value === 'following'))
  const canRedline = computed(() => runMode.value === 'live' && report.value !== undefined && (contract.value?.redlinesLeft ?? 0) > 0 && redlining.value === undefined)

  // ---- The visitor's day, the playbook and the visitor's contracts ----

  /** Reads what is left of the visitor's day. A failure leaves the old numbers, which is better than blanking them. */
  async function loadLimits(): Promise<void> {
    try {
      limits.value = await callApi(apiClients().node.GET('/api/lb04/limits'), lb04LimitsViewSchema)
    }
    catch {
      // The counter is a nicety: the service still refuses what is over the limit.
    }
  }

  /** Reads the playbook the reviews are read against. */
  async function loadPlaybook(): Promise<void> {
    if (playbookStatus.value === 'loading' || playbookStatus.value === 'ready') return
    playbookStatus.value = 'loading'
    try {
      playbook.value = await callApi(apiClients().node.GET('/api/lb04/playbook'), lb04PlaybookViewSchema)
      playbookStatus.value = 'ready'
    }
    catch {
      playbook.value = undefined
      playbookStatus.value = 'failed'
    }
  }

  /** Reads the visitor's contracts of the last hour, so a reload can take up where it left off. */
  async function loadMine(): Promise<void> {
    mineStatus.value = 'loading'
    try {
      mine.value = await callApi(apiClients().node.GET('/api/lb04/contracts'), contractListSchema)
      mineStatus.value = 'ready'
    }
    catch {
      mine.value = []
      mineStatus.value = 'failed'
    }
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

  /** Cancels the review in progress: its polling, its replay and its trace reading. */
  function stopRun(): void {
    generation += 1
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    replay.stop()
    scope.stop()
  }

  /** Empties the board for the next contract. */
  function reset(): void {
    stopRun()
    scope.clear()
    replay.clear()
    runMode.value = 'idle'
    phase.value = 'idle'
    asked.value = undefined
    problem.value = undefined
    redlineProblem.value = undefined
    contract.value = undefined
    pages.value = undefined
    pdf.value = undefined
    pdfStatus.value = 'idle'
    report.value = undefined
    redlining.value = undefined
    focus.value = undefined
    startedAt.value = undefined
    stoppedWaiting.value = false
    pagesAsked = false
    sent = false
  }

  /**
   * Shows why a review could not be started or followed. A refusal for a spent day sets the counter to
   * nothing left; any other failure after something was sent leaves the count to be read again, since the
   * service may have taken a place or given it back.
   */
  function fail(reason: unknown): void {
    scope.clear()
    phase.value = contract.value === undefined ? 'idle' : 'over'
    if (contract.value === undefined) runMode.value = 'idle'
    problem.value = isApiProblem(reason) ? reason : unavailableProblem()
    if (problem.value.code === 'daily_limit') limits.value = afterRefusal(limits.value)
    else if (sent) void loadLimits()
  }

  // ---- A review on the board ----

  /** Puts a contract that has just been queued on the board, and starts following it when it is live. */
  function acceptStarted(view: Lb04ContractView, live: boolean): void {
    contract.value = view
    phase.value = 'following'
    if (!live) return
    limits.value = afterTaking(limits.value)
    startedAt.value = Date.now()
    scope.follow(view.runId, { notFoundGraceMs: SCOPE_GRACE_MS })
    schedulePoll(view.id, generation, Date.now(), 0, 0)
  }

  /** Brings the contract up to date with the service's account of it, and reads what its new state has made known. */
  function acceptView(view: Lb04ContractView, live: boolean): void {
    contract.value = view
    if (isOver(view.state)) phase.value = 'over'
    if (!live) return
    if (view.state !== 'queued' && view.state !== 'extracting' && view.state !== 'failed' && !pagesAsked) void loadPages(view.id)
    if (view.state === 'done') void wrapUp(view.id)
    if (view.state === 'failed') {
      scope.settle()
      void loadLimits()
    }
  }

  /** Reads the text of the contract's pages, once the review has read the file. */
  async function loadPages(id: string): Promise<void> {
    pagesAsked = true
    const reading = generation
    try {
      const view = await callApi(apiClients().node.GET('/api/lb04/contracts/{id}/pages', { params: { path: { id } } }), lb04PagesViewSchema)
      if (reading === generation) pages.value = view.pages
    }
    catch {
      // Not ready yet, or the review failed since: the next read of the contract asks again if it must.
      if (reading === generation) pagesAsked = false
    }
  }

  /** Reads the finished report, what is left of the day and the visitor's list, and has the Scope read the trace to its end. */
  async function wrapUp(id: string): Promise<void> {
    const reading = generation
    scope.settle()
    await Promise.all([loadReport(id), loadLimits()])
    if (reading === generation) void loadMine()
  }

  /** Reads the report of a finished review. */
  async function loadReport(id: string): Promise<void> {
    const reading = generation
    try {
      const view = await callApi(apiClients().node.GET('/api/lb04/contracts/{id}/report', { params: { path: { id } } }), lb04ReportSchema)
      if (reading === generation) report.value = view
    }
    catch (error) {
      if (reading === generation) fail(error)
    }
  }

  /** Reads the contract's PDF for the viewer, unless the board already holds it. */
  async function loadPdf(): Promise<void> {
    const current = contract.value
    if (!current || pdf.value !== undefined || pdfStatus.value === 'loading' || runMode.value !== 'live') return
    pdfStatus.value = 'loading'
    const reading = generation
    try {
      const view = await callApi(apiClients().node.GET('/api/lb04/contracts/{id}/file', { params: { path: { id: current.id } } }), lb04FileViewSchema)
      if (reading !== generation) return
      const bytes = fromBase64(view.base64)
      if (!bytes) throw new ApiProblem(502, 'bad_answer', 'The file was not what the demo expected.')
      pdf.value = bytes
      pdfStatus.value = 'ready'
    }
    catch {
      if (reading === generation) pdfStatus.value = 'failed'
    }
  }

  /** Waits, then reads the contract again, unless the board has moved on to something else. */
  function schedulePoll(id: string, reading: number, since: number, failedReads: number, polls: number): void {
    timer = setTimeout(() => void pollContract(id, reading, since, failedReads, polls), pollDelay(polls))
  }

  /** Reads where a review stands and carries on until it is over. */
  async function pollContract(id: string, reading: number, since: number, failedReads: number, polls: number): Promise<void> {
    if (reading !== generation) return
    try {
      const view = await callApi(apiClients().node.GET('/api/lb04/contracts/{id}', { params: { path: { id } } }), lb04ContractViewSchema)
      if (reading !== generation) return
      acceptView(view, true)
      if (isOver(view.state)) return
      if (Date.now() - since > REVIEW_PATIENCE_MS) return giveUp()
      schedulePoll(id, reading, since, 0, polls + 1)
    }
    catch (error) {
      if (reading !== generation) return
      const failed = failedReads + 1
      if (!isApiProblem(error) || failed >= READ_FAILURES_ALLOWED || error.kind === 'notFound') {
        fail(error)
        return
      }
      schedulePoll(id, reading, since, failed, polls + 1)
    }
  }

  /** Stops waiting on a review that has not ended for too long, and says so. The service goes on with it. */
  function giveUp(): void {
    problem.value = new ApiProblem(504, 'review_timeout', 'The review is taking longer than expected.')
    phase.value = 'over'
    scope.settle()
    void loadLimits()
  }

  // ---- Starting a review ----

  /** Reviews one of the curated samples live: it takes one of the visitor's contracts for the day, and costs the model calls of a review. Needs the check. */
  async function reviewSample(sampleId: string): Promise<void> {
    if (busy.value) return
    reset()
    runMode.value = 'live'
    phase.value = 'starting'
    asked.value = { kind: 'sample', sampleId }
    scope.wait()
    const reading = generation
    try {
      const view = await write(() => {
        sent = true
        return callApi(apiClients().node.POST('/api/lb04/contracts', { body: { from: 'sample', sampleId } }), lb04ContractViewSchema)
      })
      if (reading !== generation) return
      acceptStarted(view, true)
    }
    catch (error) {
      if (reading === generation) fail(error)
    }
  }

  /** Reviews a PDF the visitor chose: checked here first, so a file the service would refuse is not sent, then sent as base64. It takes one of the day's contracts and one of its files. Needs the check. */
  async function reviewFile(chosen: Blob, filename: string): Promise<void> {
    if (busy.value) return
    reset()
    runMode.value = 'live'
    phase.value = 'starting'
    asked.value = { kind: 'file', filename, size: chosen.size }
    const reading = generation
    const prepared = await prepareFile(chosen)
    if (reading !== generation) return
    if ('problem' in prepared) {
      fail(FILE_PROBLEMS[prepared.problem])
      return
    }
    scope.wait()
    const name = filename.trim().slice(0, MAX_FILENAME) || 'contract.pdf'
    try {
      const view = await write(() => {
        sent = true
        return callApi(apiClients().node.POST('/api/lb04/contracts', { body: { from: 'upload', filename: name, contentBase64: prepared.file.base64 } }), lb04ContractViewSchema)
      })
      if (reading !== generation) return
      pdf.value = prepared.file.bytes
      pdfStatus.value = 'ready'
      acceptStarted(view, true)
    }
    catch (error) {
      if (reading === generation) fail(error)
    }
  }

  /** Takes up one of the visitor's own contracts of the last hour, as it stands: a finished one is read whole, one still being reviewed is followed. */
  async function openContract(id: string): Promise<void> {
    if (busy.value) return
    reset()
    runMode.value = 'live'
    phase.value = 'starting'
    const reading = generation
    try {
      const view = await callApi(apiClients().node.GET('/api/lb04/contracts/{id}', { params: { path: { id } } }), lb04ContractViewSchema)
      if (reading !== generation) return
      asked.value = view.origin === 'sample' && view.sampleId !== null ? { kind: 'sample', sampleId: view.sampleId } : { kind: 'file', filename: view.title, size: 0 }
      contract.value = view
      phase.value = isOver(view.state) ? 'over' : 'following'
      scope.follow(view.runId, { notFoundGraceMs: SCOPE_GRACE_MS })
      if (isOver(view.state)) {
        acceptView(view, true)
        return
      }
      startedAt.value = Date.now()
      acceptView(view, true)
      schedulePoll(view.id, reading, Date.now(), 0, 1)
    }
    catch (error) {
      if (reading === generation) fail(error)
    }
  }

  /** Deletes the contract on the board now, instead of at the end of its hour. It does not give back the visitor's place for the day. */
  async function deleteContract(): Promise<void> {
    const current = contract.value
    if (!current || runMode.value !== 'live') return
    try {
      await write(async () => {
        const result = await apiClients().node.DELETE('/api/lb04/contracts/{id}', { params: { path: { id: current.id } } })
        if (!result.response.ok && result.response.status !== 404) throw new ApiProblem(result.response.status, 'delete_failed', 'The contract could not be deleted.')
      })
      reset()
      void loadMine()
    }
    catch (error) {
      problem.value = isApiProblem(error) ? error : unavailableProblem()
    }
  }

  /** Stops waiting for the live review. The service goes on with it and it still counts, so the board says so. */
  function stopWaiting(): void {
    if (runMode.value !== 'live' || !busy.value) return
    const queued = contract.value !== undefined
    stopRun()
    scope.clear()
    contract.value = undefined
    pages.value = undefined
    pdf.value = undefined
    pdfStatus.value = 'idle'
    pagesAsked = false
    phase.value = 'idle'
    runMode.value = 'idle'
    startedAt.value = undefined
    stoppedWaiting.value = queued
    if (queued || sent) void loadLimits()
    if (queued) void loadMine()
  }

  // ---- Redlines ----

  /** Merges a redline into the report, once: a finding has at most one. */
  function takeRedline(redline: Lb04Redline): void {
    const current = report.value
    if (!current || current.redlines.some(made => made.findingId === redline.findingId)) return
    report.value = { ...current, redlines: [...current.redlines, redline] }
  }

  /** Asks for a proposed wording for one finding. It costs one model call and one of the contract's three redlines, unless the finding already has one. Needs the check. */
  async function makeRedline(findingId: string): Promise<void> {
    const current = contract.value
    if (!current || !report.value || runMode.value !== 'live' || redlining.value !== undefined) return
    redlining.value = findingId
    redlineProblem.value = undefined
    const reading = generation
    try {
      const redline = await write(() => callApi(apiClients().node.POST('/api/lb04/contracts/{id}/findings/{findingId}/redline', { params: { path: { id: current.id, findingId } } }), lb04RedlineSchema))
      if (reading !== generation) return
      takeRedline(redline)
      void refreshContract(current.id)
    }
    catch (error) {
      if (reading === generation) redlineProblem.value = isApiProblem(error) ? error : unavailableProblem()
    }
    finally {
      if (reading === generation) redlining.value = undefined
    }
  }

  /** Reads the contract again, for the number of redlines it has left. */
  async function refreshContract(id: string): Promise<void> {
    const reading = generation
    try {
      const view = await callApi(apiClients().node.GET('/api/lb04/contracts/{id}', { params: { path: { id } } }), lb04ContractViewSchema)
      if (reading === generation) contract.value = view
    }
    catch {
      // The number of redlines left is read again with the next one; the service refuses past the limit.
    }
  }

  // ---- Looking at the contract ----

  /** Asks the viewer to show a finding's passage. */
  function show(findingId: string): void {
    tick += 1
    focus.value = { findingId, tick }
    void loadPdf()
  }

  // ---- A replay of a recording ----

  /** Applies one recorded answer to the board, as if the API had just said it. */
  function applyFact(fact: RecordedFact): void {
    switch (fact.kind) {
      case 'started':
        acceptStarted(fact.view, false)
        break
      case 'view':
        acceptView(fact.view, false)
        break
      case 'pages':
        pages.value = fact.pages
        break
      case 'file': {
        const bytes = fromBase64(fact.file.base64)
        if (bytes) {
          pdf.value = bytes
          pdfStatus.value = 'ready'
        }
        break
      }
      case 'report':
        report.value = fact.report
        break
      case 'redline':
        takeRedline(fact.redline)
        break
    }
  }

  // A replay ends when the player says it is no longer playing: what was recorded is all there is, so the review is over.
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
    redlineProblem,
    limits,
    quota,
    playbook,
    playbookStatus,
    mine,
    mineStatus,
    contract,
    failure,
    pages,
    pdf,
    pdfStatus,
    report,
    redlining,
    focus,
    startedAt,
    stoppedWaiting,
    busy,
    canRedline,
    loadLimits,
    loadPlaybook,
    loadMine,
    reviewSample,
    reviewFile,
    openContract,
    deleteContract,
    stopWaiting,
    makeRedline,
    show,
    loadPdf,
    replayRecording,
    showProblem,
    reset,
    dispose,
  }
})
