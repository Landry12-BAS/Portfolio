// LB-03's board state: the document on the board (uploaded live, or replayed from a recording), where its
// reading has got to, the field the visitor is looking at, their documents of the hour and what is left of
// their day. The board calls the site's API (`/api/lb03/...`) through the typed client and reads the
// document by polling it once a second until its pipeline has ended: a reading takes seconds to a few
// minutes, and polling needs no connection to keep open, which the site's serverless host could not do
// anyway. Every answer is checked with its schema. The service names a document's run only when the run
// is over, so until then the Scope says it is waiting (followRun), and the steps shown while the document
// is read are the document's own, which the service saves as each stage ends.
import type { Exchange, Recording } from '@lb/contracts'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

import { apiClients, callApi } from '~/board-kit/api'
import { ApiProblem, cookieProblem, isApiProblem, unavailableProblem, verificationProblem } from '~/board-kit/problem'
import { exhausted } from '~/board-kit/quota'
import type { Quota } from '~/board-kit/quota'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import type { InvoiceSample } from '#shared/data/samples/lb03-types'

import { clampPage, pageCount } from './boxes'
import { fieldAt, firstFieldToShow } from './fields'
import { DOCUMENT_GIVE_UP_SECONDS, isFinal } from './progress'
import { documentListSchema, documentSchema, nothingSchema, quotaSchema } from './schemas'
import type { DocumentQuota, DocumentSummary, InvoiceDocument } from './schemas'
import { loadSampleFile } from './upload'

/** How often the document is read while its pipeline runs. */
export const DOCUMENT_POLL_MS = 1_000
/** How long the board waits for a pipeline before it says the system took too long: the service's own limit, and a minute more. */
export const DOCUMENT_GIVE_UP_MS = DOCUMENT_GIVE_UP_SECONDS * 1_000
// A run's first span appears when the run is over, so "no trace yet" is not an error for this long after it is named.
const SCOPE_GRACE_MS = 8_000
// Reads that fail for another reason are tried again this many times in a row before the board gives up.
const READ_FAILURES_ALLOWED = 3

/** What is on the board: nothing, a live document, or a replay. */
export type RunMode = 'idle' | 'live' | 'replay'
/** Where the run stands: nothing yet, the file being sent, the pipeline reading it, or finished with. */
export type RunPhase = 'idle' | 'sending' | 'reading' | 'done'

/** LB-03's board. */
export const useLb03Store = defineStore('lb03', () => {
  const session = useSessionStore()
  const scope = useScopeStore()
  const replay = useReplayStore()

  const onBoard = shallowRef<InvoiceDocument>()
  const documents = shallowRef<readonly DocumentSummary[]>([])
  // Whether the list of the visitor's documents is still being read, was read, or could not be.
  const documentsStatus = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const quota = shallowRef<DocumentQuota>()
  const allowance = shallowRef<Quota>()
  const runMode = ref<RunMode>('idle')
  const phase = ref<RunPhase>('idle')
  const problem = shallowRef<ApiProblem>()
  // When the file was accepted, in Unix milliseconds, for the clock beside the stages.
  const startedAt = ref<number>()
  // The field the visitor is looking at, and the page it is on.
  const selectedPath = ref<string>()
  const page = ref(1)
  // The sample whose recording is being replayed: its page pictures are static files, a replay has no document at the service.
  const replaySample = ref<string>()
  // A correction being sent, the field it is for, and why the last one was refused.
  const correcting = ref(false)
  const correctionProblem = shallowRef<ApiProblem>()
  const deleting = ref(false)

  // Which run is current: starting another makes every read of an older one stop touching the board.
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const finished = computed(() => onBoard.value !== undefined && isFinal(onBoard.value.state))
  const ready = computed(() => onBoard.value?.state === 'ready')
  const selectedField = computed(() => fieldAt(onBoard.value?.fields ?? null, selectedPath.value))
  const pages = computed(() => pageCount(onBoard.value?.pages ?? null))
  // The documents the visitor may correct, export and delete are their own, so a replay has none of these.
  const live = computed(() => runMode.value === 'live')
  const canRead = computed(() => quota.value?.can_read !== false)

  /** Reads what is left of the visitor's day, and the limits the service enforces. A failure leaves the old numbers. */
  async function loadQuota(): Promise<void> {
    try {
      const read = await callApi(apiClients().flask.GET('/api/lb03/quota'), quotaSchema)
      quota.value = read
      allowance.value = { limit: read.limits.documents_per_day, used: read.used, remaining: read.remaining, resetsAt: read.resets_at }
    }
    catch {
      // Without a count the panel says it is counting, and a refusal from the service still stops an upload.
    }
  }

  /** Reads the visitor's documents of the hour. A failure leaves the shelf as it was. */
  async function loadDocuments(): Promise<void> {
    if (documentsStatus.value === 'idle') documentsStatus.value = 'loading'
    try {
      documents.value = (await callApi(apiClients().flask.GET('/api/lb03/documents'), documentListSchema)).documents
      documentsStatus.value = 'ready'
    }
    catch {
      documentsStatus.value = documentsStatus.value === 'ready' ? 'ready' : 'failed'
    }
  }

  /** Cancels the run in progress: its polling, its replay and its trace reading. */
  function stopRun(): void {
    generation += 1
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    replay.stop()
    scope.stop()
  }

  /** Empties the board for the next run. The visitor's documents of the hour and their allowance stay. */
  function reset(): void {
    stopRun()
    scope.clear()
    replay.clear()
    onBoard.value = undefined
    runMode.value = 'idle'
    phase.value = 'idle'
    problem.value = undefined
    startedAt.value = undefined
    selectedPath.value = undefined
    page.value = 1
    replaySample.value = undefined
    correctionProblem.value = undefined
  }

  /** Looks at a field: lights its box and shows its page. A field that was not found on a page leaves the page as it is. */
  function select(path: string | undefined): void {
    selectedPath.value = path
    const box = fieldAt(onBoard.value?.fields ?? null, path)?.box
    if (box) page.value = clampPage(box.page, pages.value)
  }

  /** Shows another page of the document. */
  function showPage(number: number): void {
    page.value = clampPage(number, pages.value)
  }

  /** Points the viewer at the field most worth looking at first, once a reading is done. */
  function pointAtFirstField(): void {
    if (onBoard.value === undefined || selectedPath.value !== undefined) return
    select(firstFieldToShow(onBoard.value.fields, onBoard.value.checks))
  }

  /** The pipeline has ended: the Scope stops waiting, the viewer points at a field, and the counters and the allowance are read again. */
  function finish(): void {
    phase.value = 'done'
    scope.settle()
    pointAtFirstField()
    void loadQuota()
    void loadDocuments()
  }

  /** Stops waiting on the document and says why. */
  function giveUp(reason: ApiProblem): void {
    problem.value = reason
    phase.value = 'done'
    scope.settle()
  }

  /**
   * Starts reading the run's trace as soon as the document names the run. The service names it when the run is
   * over, so until then the Scope says it is waiting. A run that is already being followed is left alone.
   */
  function followRun(current: InvoiceDocument): void {
    if (current.run_id === null) {
      if (scope.phase === 'idle') scope.wait()
      return
    }
    if (scope.runId !== current.run_id) scope.follow(current.run_id, { notFoundGraceMs: SCOPE_GRACE_MS })
  }

  /** Reads the document until its pipeline has ended, once a second. */
  async function poll(id: string, reading: number, since: number, failures: number): Promise<void> {
    let failed = failures
    try {
      const next = await callApi(apiClients().flask.GET('/api/lb03/documents/{document_id}', { params: { path: { document_id: id } } }), documentSchema)
      if (reading !== generation) return
      onBoard.value = next
      followRun(next)
      failed = 0
      if (isFinal(next.state)) {
        finish()
        return
      }
    }
    catch (error) {
      if (reading !== generation) return
      failed += 1
      if (!isApiProblem(error) || failed >= READ_FAILURES_ALLOWED || error.kind === 'notFound') {
        giveUp(isApiProblem(error) ? error : unavailableProblem())
        return
      }
    }
    if (Date.now() - since > DOCUMENT_GIVE_UP_MS) {
      giveUp(new ApiProblem(504, 'upstream_timeout', 'The system behind this demo took too long to answer.'))
      return
    }
    timer = setTimeout(() => void poll(id, reading, since, failed), DOCUMENT_POLL_MS)
  }

  /** Starts following a document the service has taken. */
  function begin(taken: InvoiceDocument): void {
    onBoard.value = taken
    phase.value = 'reading'
    startedAt.value = Date.now()
    followRun(taken)
    if (allowance.value) allowance.value = { ...allowance.value, used: allowance.value.used + 1, remaining: Math.max(allowance.value.remaining - 1, 0) }
    const reading = generation
    timer = setTimeout(() => void poll(taken.id, reading, Date.now(), 0), DOCUMENT_POLL_MS)
    void loadDocuments()
  }

  /**
   * Makes a call that changes something. If the server says the check is needed again (a new day began), runs it
   * and tries once more. If it still says so right after the check passed, the browser is not keeping the session
   * cookie that holds the result, which the visitor can fix, so that is said and not retried.
   */
  async function withCheck<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    }
    catch (error) {
      if (!isApiProblem(error) || error.kind !== 'verification') throw error
      session.forgetVerification()
      if (!(await session.ensureVerified())) throw verificationProblem()
      try {
        return await call()
      }
      catch (again) {
        throw isApiProblem(again) && again.kind === 'verification' ? cookieProblem() : again
      }
    }
  }

  /** Sends a file to the service. The form is built for each attempt, so a second attempt sends the file whole. */
  function send(file: File): Promise<InvoiceDocument> {
    const post = () => {
      const form = new FormData()
      form.append('file', file, file.name)
      // The typed client wants the body the OpenAPI document describes; what travels is the form.
      return callApi(apiClients().flask.POST('/api/lb03/documents', { body: { file: file.name }, bodySerializer: () => form }), documentSchema)
    }
    return withCheck(post)
  }

  /** Puts a failure on the board and takes the run off it. A refusal for being over the day's allowance spends the rest of it. */
  function refuse(error: unknown): void {
    phase.value = 'idle'
    runMode.value = 'idle'
    problem.value = isApiProblem(error) ? error : unavailableProblem()
    if (problem.value.code === 'daily_limit' && allowance.value) allowance.value = exhausted(allowance.value)
  }

  /** Uploads a file live: after the check that the visitor is a person, which runs only now, and spends one of the day's documents. */
  async function upload(file: File | Promise<File>): Promise<void> {
    if (phase.value === 'sending') return
    reset()
    runMode.value = 'live'
    phase.value = 'sending'
    const sending = generation
    if (!(await session.ensureVerified())) {
      phase.value = 'idle'
      runMode.value = 'idle'
      problem.value = session.available ? (session.problem ?? verificationProblem()) : unavailableProblem()
      return
    }
    try {
      const taken = await send(await file)
      if (sending !== generation) return
      begin(taken)
    }
    catch (error) {
      if (sending !== generation) return
      refuse(error)
    }
  }

  /** Runs a curated sample live: its file, from the site's own static files, is uploaded as if the visitor had chosen it. */
  function uploadSample(sample: Pick<InvoiceSample, 'file' | 'mime' | 'bytes'>): Promise<void> {
    return upload(loadSampleFile(sample))
  }

  /** Opens one of the visitor's documents of the hour, and follows it if it is still being read. */
  async function open(id: string): Promise<void> {
    if (phase.value === 'sending') return
    reset()
    runMode.value = 'live'
    phase.value = 'reading'
    const reading = generation
    try {
      const found = await callApi(apiClients().flask.GET('/api/lb03/documents/{document_id}', { params: { path: { document_id: id } } }), documentSchema)
      if (reading !== generation) return
      onBoard.value = found
      followRun(found)
      if (isFinal(found.state)) finish()
      else timer = setTimeout(() => void poll(id, reading, Date.now(), 0), DOCUMENT_POLL_MS)
    }
    catch (error) {
      if (reading !== generation) return
      phase.value = 'idle'
      runMode.value = 'idle'
      problem.value = isApiProblem(error) ? error : unavailableProblem()
      void loadDocuments()
    }
  }

  /**
   * Corrects one field of the document on the board and takes the service's answer, which is the whole document
   * with every check run again. Says whether the correction was taken; if not, `correctionProblem` says why.
   */
  async function correct(path: string, value: string): Promise<boolean> {
    const current = onBoard.value
    if (current === undefined || !live.value || correcting.value) return false
    correcting.value = true
    correctionProblem.value = undefined
    try {
      const body = { path, value }
      const corrected = await withCheck(() => callApi(apiClients().flask.POST('/api/lb03/documents/{document_id}/corrections', { params: { path: { document_id: current.id } }, body }), documentSchema))
      onBoard.value = corrected
      void loadDocuments()
      return true
    }
    catch (error) {
      correctionProblem.value = isApiProblem(error) ? error : unavailableProblem()
      return false
    }
    finally {
      correcting.value = false
    }
  }

  /** Deletes a document that has ended, with its files, and clears the board if it was the one on it. */
  async function remove(id: string): Promise<void> {
    if (deleting.value) return
    deleting.value = true
    try {
      await withCheck(() => callApi(apiClients().flask.DELETE('/api/lb03/documents/{document_id}', { params: { path: { document_id: id } } }), nothingSchema))
      if (onBoard.value?.id === id) reset()
    }
    catch (error) {
      problem.value = isApiProblem(error) ? error : unavailableProblem()
    }
    finally {
      deleting.value = false
      void loadDocuments()
    }
  }

  /** Applies one recorded answer to the board, as if the API had just said it. Only documents matter to LB-03's board. */
  function applyExchange(exchange: Exchange): void {
    if (exchange.response.status < 200 || exchange.response.status >= 300) return
    const parsed = documentSchema.safeParse(exchange.response.body)
    if (!parsed.success) return
    onBoard.value = parsed.data
    if (isFinal(parsed.data.state)) {
      phase.value = 'done'
      pointAtFirstField()
    }
  }

  /** Replays a recording: no request is made and nothing is spent. */
  function replayRecording(recording: Recording): void {
    reset()
    runMode.value = 'replay'
    phase.value = 'reading'
    replaySample.value = recording.sample
    startedAt.value = undefined
    replay.start(recording, (_, exchange) => applyExchange(exchange))
  }

  /** Shows a problem the board met outside a run, such as a recording that could not be read. */
  function fail(reason: ApiProblem): void {
    problem.value = reason
  }

  /** Stops everything the board is doing, for when the visitor leaves it. */
  function dispose(): void {
    stopRun()
  }

  return {
    onBoard,
    documents,
    documentsStatus,
    quota,
    allowance,
    runMode,
    phase,
    problem,
    startedAt,
    selectedPath,
    selectedField,
    page,
    pages,
    replaySample,
    correcting,
    correctionProblem,
    deleting,
    finished,
    ready,
    live,
    canRead,
    loadQuota,
    loadDocuments,
    upload,
    uploadSample,
    open,
    correct,
    remove,
    select,
    showPage,
    replayRecording,
    fail,
    reset,
    dispose,
  }
})
