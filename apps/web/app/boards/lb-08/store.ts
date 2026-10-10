// LB-08's board state: the workflow on the board (opened from a sample, described by a model, or
// picked from the visitor's own), the draft being edited, its validity, its versions, the test
// order, the run being followed with its retries, its dead letters and what the sandbox sent, and
// what is left of the visitor's day. The board calls the site's API (`/api/lb08/...`) through the
// typed client and checks every answer with the contracts' schemas. A run is followed by polling
// its log for the events after the last one seen, quickly while it works and slowly while it waits
// for a person; nothing is streamed. A replay of a recording hands the same answers back through
// the same functions, so a live run and a replay are drawn by one set of code.
//
// The draft may be invalid while it is edited, which is the point: `validateWorkflow` answers on
// every change, the store keeps its problems by place, and a draft that does not pass can be neither
// saved nor run.
import { validateWorkflow } from '@lb/contracts'
import type { BranchLabel, ConnectorId, Exchange, Recording, TriggerEventId, Values, WorkflowGraph, WorkflowNode } from '@lb/contracts'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'

import { apiClients, callApi } from '~/board-kit/api'
import { ApiProblem, cookieProblem, isApiProblem, unavailableProblem, verificationProblem } from '~/board-kit/problem'
import type { Quota } from '~/board-kit/quota'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import { factOf } from './exchange'
import type { RecordedFact } from './exchange'
import { addStep as addStepTo, changeConnector as changeConnectorOf, connect as connectIn, disconnect as disconnectIn, moveStep as moveStepIn, newStep, rename as renameIn, relabel as relabelIn, removeStep as removeStepFrom, replaceStep, sameGraph, triggerEventOf } from './graph/edit'
import type { DefaultTexts, Point, StepKind } from './graph/edit'
import { indexIssues } from './graph/issues'
import { entriesFromValues, exampleEntries, orderFields, orderProblems, valuesOf } from './graph/order'
import type { OrderEntry } from './graph/order'
import { ledgerOf } from './run/effects'
import { applyEvents, isOver, modelFromView, reconcile, waitingForApproval, withStatus } from './run/model'
import type { RunModel } from './run/model'
import { deadLetterListSchema, limitsViewSchema, runEventsPageSchema, runViewSchema, sentListSchema, workflowListSchema, workflowViewSchema } from './schemas'
import type { DeadLetterView, LimitsView, RunEventsPage, RunView, SentView, WorkflowSummary, WorkflowView } from './schemas'

/** How often a run's log is read while the run works, and while it waits for a person. */
export const RUN_POLL_MS = 600
export const APPROVAL_POLL_MS = 1_500
/** How long the board waits for a run to move before it says the system took too long; time spent waiting for a person does not count. */
export const RUN_GIVE_UP_MS = 150_000
// A run's first span appears a moment after it starts, so "no trace yet" is not an error for this long.
const SCOPE_GRACE_MS = 8_000
// Reads that fail for another reason are tried again this many times in a row before the board gives up.
const READ_FAILURES_ALLOWED = 3

/** What is on the board: nothing, a live workflow, or a replay of a recording. */
export type RunMode = 'idle' | 'live' | 'replay'
/** What the board is waiting for: nothing, a workflow being opened or described, a run being started. */
export type Busy = 'idle' | 'opening' | 'describing' | 'starting'
/** Where the run on the board stands: none, being followed, or over. */
export type RunPhase = 'idle' | 'following' | 'over'

/** A step or a connection the visitor has picked, for the inspector. */
export type Selection = { kind: 'node', id: string } | { kind: 'edge', index: number }

/** Builds the quota the limits panel draws from the service's allowance for runs. */
function runQuota(limits: LimitsView | undefined): Quota | undefined {
  return limits ? { ...limits.runs, resetsAt: limits.resetsAt } : undefined
}

/** The allowances after a refusal for being over one: nothing left, whatever the count said. */
function spentAllowance(limits: LimitsView | undefined, kind: 'runs' | 'generations'): LimitsView | undefined {
  if (!limits) return limits
  return { ...limits, [kind]: { limit: limits[kind].limit, used: limits[kind].limit, remaining: 0 } }
}

/** LB-08's board. */
export const useLb08Store = defineStore('lb08', () => {
  const session = useSessionStore()
  const scope = useScopeStore()
  const replay = useReplayStore()

  const runMode = ref<RunMode>('idle')
  const busy = ref<Busy>('idle')
  const problem = shallowRef<ApiProblem>()
  const saveProblem = shallowRef<ApiProblem>()
  const decisionProblem = shallowRef<ApiProblem>()
  const limits = shallowRef<LimitsView>()
  const mine = shallowRef<readonly WorkflowSummary[]>([])
  const mineStatus = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')

  // The workflow as the service holds it, and the copy being edited.
  const workflow = shallowRef<WorkflowView>()
  const draft = shallowRef<WorkflowGraph>()
  const history = shallowRef<readonly WorkflowGraph[]>([])
  const selection = shallowRef<Selection>()
  const saving = ref(false)

  // The test order, and the failures the visitor asked for.
  const orderEntries = shallowRef<Readonly<Record<string, OrderEntry>>>({})
  const orderShown = ref(false)
  const failures = shallowRef<Readonly<Record<string, number>>>({})

  // The run on the board: the chain of a run and its replays, the graph they ran, and what came of them.
  const chain = shallowRef<readonly RunModel[]>([])
  const runGraph = shallowRef<WorkflowGraph>()
  const runPhase = ref<RunPhase>('idle')
  const sent = shallowRef<readonly SentView[]>()
  const deadLetters = shallowRef<readonly DeadLetterView[]>([])
  const deciding = ref<string>()

  // Which run is current: starting another makes every read of an older one stop touching the board.
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const validation = computed(() => (draft.value ? validateWorkflow(draft.value) : undefined))
  const valid = computed(() => validation.value?.ok === true)
  const issues = computed(() => (draft.value ? indexIssues(draft.value, validation.value?.ok === false ? validation.value.issues : []) : undefined))
  const dirty = computed(() => workflow.value !== undefined && draft.value !== undefined && !sameGraph(workflow.value.graph, draft.value))
  const triggerEvent = computed(() => (draft.value ? triggerEventOf(draft.value) : undefined))
  const orderFieldList = computed(() => (triggerEvent.value ? orderFields(triggerEvent.value) : []))
  const orderIssues = computed(() => (triggerEvent.value ? orderProblems(triggerEvent.value, orderFieldList.value, orderEntries.value) : new Map()))
  const quota = computed(() => runQuota(limits.value))
  const currentRun = computed(() => chain.value.at(-1))
  const runOver = computed(() => currentRun.value !== undefined && isOver(currentRun.value.status))
  const ledger = computed(() => ledgerOf(chain.value, sent.value))
  const chainLetters = computed(() => deadLetters.value.filter(letter => chain.value.some(run => run.id === letter.runId)))
  const canEdit = computed(() => runMode.value === 'live' && workflow.value !== undefined && busy.value === 'idle')
  const runsLeft = computed(() => limits.value?.runs.remaining)
  const canStart = computed(() => canEdit.value && valid.value && orderIssues.value.size === 0 && (runsLeft.value ?? 1) > 0 && runPhase.value !== 'following' && !saving.value)
  const canReplay = computed(() => runMode.value === 'live' && runOver.value && (runsLeft.value ?? 1) > 0)

  // The event the test order is for. A new trigger event means a new test order: the old one's fields are not the new one's.
  let orderEvent: TriggerEventId | undefined
  watch(triggerEvent, (event) => {
    if (event === undefined || event === orderEvent || runMode.value !== 'live') return
    orderEvent = event
    orderEntries.value = exampleEntries(event)
  })

  // ---- The visitor's day ----

  /** Reads what is left of the visitor's daily runs and descriptions. A failure leaves the old numbers, which is better than blanking them. */
  async function loadLimits(): Promise<void> {
    try {
      limits.value = await callApi(apiClients().node.GET('/api/lb08/limits'), limitsViewSchema)
    }
    catch {
      // The counters are a nicety: the service still refuses what is over the limit.
    }
  }

  /** Reads the visitor's workflows, so a reload can take up where it left off. */
  async function loadMine(): Promise<void> {
    mineStatus.value = 'loading'
    try {
      mine.value = await callApi(apiClients().node.GET('/api/lb08/workflows'), workflowListSchema)
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

  /** Cancels the run in progress: its polling, its replay and its trace reading. */
  function stopRun(): void {
    generation += 1
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    replay.stop()
    scope.stop()
  }

  /** Empties the board for the next workflow. */
  function reset(): void {
    stopRun()
    scope.clear()
    replay.clear()
    runMode.value = 'idle'
    busy.value = 'idle'
    problem.value = undefined
    saveProblem.value = undefined
    decisionProblem.value = undefined
    workflow.value = undefined
    draft.value = undefined
    history.value = []
    selection.value = undefined
    orderEntries.value = {}
    orderEvent = undefined
    orderShown.value = false
    failures.value = {}
    clearRun()
  }

  /** Forgets the run on the board, but not the workflow. */
  function clearRun(): void {
    chain.value = []
    runGraph.value = undefined
    runPhase.value = 'idle'
    sent.value = undefined
    deadLetters.value = []
    deciding.value = undefined
  }

  // ---- A workflow on the board ----

  /** Puts a workflow on the board as the service holds it: the saved copy, and the draft starting from it. */
  function acceptWorkflow(view: WorkflowView): void {
    const first = workflow.value === undefined || workflow.value.id !== view.id
    workflow.value = view
    draft.value = view.graph
    history.value = []
    selection.value = undefined
    saveProblem.value = undefined
    if (first) {
      failures.value = {}
      orderShown.value = false
      orderEvent = triggerEventOf(view.graph)
      orderEntries.value = exampleEntries(orderEvent)
    }
  }

  /** Starts the test order from values, such as a sample's own. */
  function useOrder(values: Values): void {
    orderEntries.value = entriesFromValues(values)
  }

  /** Opens a curated sample as a new workflow of the visitor's: a hand-written graph, no model call. Needs the check. */
  async function openSample(sampleId: string, order?: Values): Promise<void> {
    if (busy.value !== 'idle') return
    reset()
    runMode.value = 'live'
    busy.value = 'opening'
    const reading = generation
    try {
      const view = await write(() => callApi(apiClients().node.POST('/api/lb08/workflows', { body: { from: 'sample', sampleId } }), workflowViewSchema))
      if (reading !== generation) return
      acceptWorkflow(view)
      if (order) useOrder(order)
      void loadMine()
    }
    catch (error) {
      if (reading !== generation) return
      fail(error)
      runMode.value = 'idle'
    }
    finally {
      if (reading === generation) busy.value = 'idle'
    }
  }

  /** Describes a process in the visitor's own words and has the model write the workflow: up to two model calls. Needs the check. */
  async function describe(description: string): Promise<void> {
    if (busy.value !== 'idle') return
    reset()
    runMode.value = 'live'
    busy.value = 'describing'
    scope.wait()
    const reading = generation
    try {
      const view = await write(() => callApi(apiClients().node.POST('/api/lb08/workflows', { body: { from: 'description', description } }), workflowViewSchema))
      if (reading !== generation) return
      acceptWorkflow(view)
      const trace = view.versions[0]?.traceRunId
      if (trace) scope.follow(trace, { notFoundGraceMs: SCOPE_GRACE_MS })
      else scope.clear()
      void loadMine()
    }
    catch (error) {
      if (reading !== generation) return
      scope.clear()
      fail(error)
      runMode.value = 'idle'
    }
    finally {
      if (reading === generation) {
        busy.value = 'idle'
        void loadLimits()
      }
    }
  }

  /** Opens one of the visitor's workflows from the list. */
  async function openMine(id: string): Promise<void> {
    if (busy.value !== 'idle') return
    reset()
    runMode.value = 'live'
    busy.value = 'opening'
    const reading = generation
    try {
      const view = await callApi(apiClients().node.GET('/api/lb08/workflows/{id}', { params: { path: { id } } }), workflowViewSchema)
      if (reading !== generation) return
      acceptWorkflow(view)
    }
    catch (error) {
      if (reading !== generation) return
      fail(error)
      runMode.value = 'idle'
    }
    finally {
      if (reading === generation) busy.value = 'idle'
    }
  }

  /** Deletes one of the visitor's workflows with its versions, runs and deliveries. Needs the check. */
  async function deleteMine(id: string): Promise<void> {
    try {
      await write(async () => {
        const result = await apiClients().node.DELETE('/api/lb08/workflows/{id}', { params: { path: { id } } })
        if (!result.response.ok) throw new ApiProblem(result.response.status, 'delete_failed', 'The workflow could not be deleted.')
      })
      mine.value = mine.value.filter(item => item.id !== id)
      if (workflow.value?.id === id) reset()
    }
    catch (error) {
      fail(error)
    }
  }

  /** Reads a failure into the problem the board shows. */
  function fail(error: unknown): void {
    problem.value = isApiProblem(error) ? error : unavailableProblem()
    if (problem.value.kind === 'quota') {
      limits.value = spentAllowance(limits.value, problem.value.code === 'daily_limit' && busy.value === 'describing' ? 'generations' : 'runs')
    }
  }

  // ---- Editing ----

  /** Replaces the draft, keeping the one it replaces so it can be undone. */
  function commit(next: WorkflowGraph): void {
    if (!draft.value || !canEdit.value || sameGraph(draft.value, next)) return
    history.value = [...history.value.slice(-49), draft.value]
    draft.value = next
    saveProblem.value = undefined
    if (selection.value?.kind === 'edge' && selection.value.index >= next.edges.length) selection.value = undefined
    if (selection.value?.kind === 'node') {
      const id = selection.value.id
      if (!next.nodes.some(node => node.id === id)) selection.value = undefined
    }
  }

  /** Takes back the last edit. */
  function undo(): void {
    const previous = history.value.at(-1)
    if (!previous || !canEdit.value) return
    history.value = history.value.slice(0, -1)
    draft.value = previous
    if (selection.value?.kind === 'edge') selection.value = undefined
  }

  /** Throws the edits away and goes back to the saved version. */
  function discard(): void {
    if (!workflow.value) return
    draft.value = workflow.value.graph
    history.value = []
    selection.value = undefined
    saveProblem.value = undefined
  }

  /** Picks a step or a connection for the inspector, or nothing. */
  function select(next: Selection | undefined): void {
    selection.value = next
  }

  /** Adds a step of a kind, connected after the picked step when there is one, and picks the new step. */
  function addStep(kind: StepKind, texts: DefaultTexts, after?: string): void {
    if (!draft.value || !canEdit.value) return
    const node = newStep(draft.value, kind, texts)
    commit(addStepTo(draft.value, node, after))
    selection.value = { kind: 'node', id: node.id }
  }

  /** Removes a step with its connections. The trigger stays: a workflow without one cannot run, and its event can be changed instead. */
  function removeStep(id: string): void {
    if (!draft.value || draft.value.nodes.find(node => node.id === id)?.type === 'trigger') return
    commit(removeStepFrom(draft.value, id))
  }

  /** Replaces a step by its changed copy. */
  function updateStep(node: WorkflowNode): void {
    if (draft.value) commit(replaceStep(draft.value, node))
  }

  /** Changes the connector of an action step. */
  function changeConnector(id: string, connector: ConnectorId, texts: DefaultTexts): void {
    if (draft.value) commit(changeConnectorOf(draft.value, id, connector, texts))
  }

  /** Connects two steps. */
  function connect(from: string, to: string, branch?: BranchLabel): void {
    if (draft.value) commit(connectIn(draft.value, from, to, branch))
  }

  /** Cuts a connection. */
  function disconnect(index: number): void {
    if (draft.value) commit(disconnectIn(draft.value, index))
  }

  /** Changes the branch label of a connection. */
  function relabel(index: number, branch: BranchLabel | undefined): void {
    if (draft.value) commit(relabelIn(draft.value, index, branch))
  }

  /** Moves a step on the canvas. */
  function moveStep(id: string, position: Point): void {
    if (draft.value) commit(moveStepIn(draft.value, id, position))
  }

  /** Renames the workflow. */
  function rename(name: string): void {
    if (draft.value) commit(renameIn(draft.value, name))
  }

  /** Saves the draft as the workflow's next version. Refused here, as it would be by the service, while the draft has problems. */
  async function save(): Promise<boolean> {
    const checked = validation.value
    const current = workflow.value
    if (!current || !checked?.ok || !dirty.value || saving.value || runMode.value !== 'live') return false
    saving.value = true
    saveProblem.value = undefined
    const reading = generation
    try {
      const view = await write(() => callApi(apiClients().node.PUT('/api/lb08/workflows/{id}', { params: { path: { id: current.id } }, body: { baseVersion: current.version, graph: checked.graph } }), workflowViewSchema))
      if (reading !== generation) return false
      acceptWorkflow(view)
      void loadMine()
      return true
    }
    catch (error) {
      if (reading === generation) saveProblem.value = isApiProblem(error) ? error : unavailableProblem()
      return false
    }
    finally {
      saving.value = false
    }
  }

  // ---- The test order and the failures ----

  /** Changes one field of the test order. */
  function setOrder(name: string, value: OrderEntry): void {
    orderEntries.value = { ...orderEntries.value, [name]: value }
  }

  /** Puts the examples back into the test order. */
  function resetOrder(): void {
    if (triggerEvent.value) orderEntries.value = exampleEntries(triggerEvent.value)
  }

  /** Says how many times an action step's connector should fail before it works; zero takes the failure off. */
  function setFailures(nodeId: string, times: number): void {
    const others = Object.entries(failures.value).filter(([id]) => id !== nodeId)
    failures.value = Object.fromEntries(times > 0 ? [...others, [nodeId, times]] : others)
  }

  /** The failures to ask for: only for steps of the saved workflow that are actions, since the service refuses any other. */
  function failureRequests(): { nodeId: string, times: number }[] {
    const actions = new Set((workflow.value?.graph.nodes ?? []).filter(node => node.type === 'action').map(node => node.id))
    return Object.entries(failures.value).filter(([nodeId, times]) => times > 0 && actions.has(nodeId)).map(([nodeId, times]) => ({ nodeId, times }))
  }

  // ---- A run ----

  /** Takes the number of runs a start or a replay used out of the visitor's allowance, until the service's own count is read. */
  function spendRun(): void {
    const current = limits.value
    if (!current) return
    const used = Math.min(current.runs.used + 1, current.runs.limit)
    limits.value = { ...current, runs: { ...current.runs, used, remaining: Math.max(current.runs.limit - used, 0) } }
  }

  /** Puts a run in the chain: it starts the chain, or it is a replay that joins it. */
  function acceptRun(view: RunView, live: boolean, replayed: boolean): void {
    const model = modelFromView(view, Date.now())
    chain.value = replayed ? [...chain.value, model] : [model]
    if (!replayed) {
      runGraph.value = workflow.value?.graph
      sent.value = undefined
      deadLetters.value = []
    }
    decisionProblem.value = undefined
    runPhase.value = 'following'
    if (!live) return
    scope.follow(view.id, { notFoundGraceMs: SCOPE_GRACE_MS })
    schedulePoll(view.id, generation, Date.now(), 0, RUN_POLL_MS)
  }

  /** Replaces a run of the chain by its changed copy. */
  function replaceRun(model: RunModel): void {
    chain.value = chain.value.map(run => (run.id === model.id ? model : run))
  }

  /** Brings a run up to date with the full view the service gives of it. */
  function acceptRunView(view: RunView): void {
    const known = chain.value.find(run => run.id === view.id)
    if (known) replaceRun(reconcile(known, view, Date.now()))
  }

  /** Folds a page of a run's log into the run, and learns what to do next: read the whole run for a question, or wrap the run up. */
  function acceptEvents(runId: string, page: RunEventsPage, live: boolean): void {
    const known = chain.value.find(run => run.id === runId)
    if (!known) return
    const next = withStatus(applyEvents(known, page.events, Date.now()), page.status)
    replaceRun(next)
    if (live && waitingForApproval(next).some(step => step.question === undefined)) void readRun(runId)
    if (isOver(next.status)) {
      runPhase.value = 'over'
      if (live) void wrapUp(runId)
    }
  }

  /** Reads the whole of a run, for what the log does not carry. */
  async function readRun(runId: string): Promise<void> {
    const reading = generation
    try {
      const view = await callApi(apiClients().node.GET('/api/lb08/runs/{id}', { params: { path: { id: runId } } }), runViewSchema)
      if (reading === generation) acceptRunView(view)
    }
    catch {
      // The log has what the run view needs; the question of an approval is the one thing it lacks, and the next read tries again.
    }
  }

  /** Reads what a finished run left: the whole run, what the sandbox sent for its chain, the dead letters and what is left of the day. */
  async function wrapUp(runId: string): Promise<void> {
    const reading = generation
    const known = chain.value.find(run => run.id === runId)
    if (!known) return
    // The run writes a root span when it ends, a moment after its log says so: keep reading for it, a few seconds at most.
    scope.settle()
    await Promise.all([readRun(runId), loadLimits()])
    try {
      const rows = await callApi(apiClients().node.GET('/api/lb08/sent', { params: { query: { rootRunId: known.rootRunId } } }), sentListSchema)
      const letters = await callApi(apiClients().node.GET('/api/lb08/dead-letters'), deadLetterListSchema)
      if (reading !== generation) return
      sent.value = rows
      deadLetters.value = letters
    }
    catch {
      // What was sent is shown from the log meanwhile; the next run or replay reads it again.
    }
  }

  /** Waits, then reads a run's log again, unless the board has moved on to something else. */
  function schedulePoll(runId: string, reading: number, startedAt: number, failedReads: number, delayMs: number): void {
    timer = setTimeout(() => void pollRun(runId, reading, startedAt, failedReads), delayMs)
  }

  /** Reads the events of a run after the last one seen, and carries on until the run is over. */
  async function pollRun(runId: string, reading: number, startedAt: number, failedReads: number): Promise<void> {
    const known = chain.value.find(run => run.id === runId)
    if (!known || reading !== generation) return
    try {
      const page = await callApi(apiClients().node.GET('/api/lb08/runs/{id}/events', { params: { path: { id: runId }, query: { after: known.lastSeq } } }), runEventsPageSchema)
      if (reading !== generation) return
      acceptEvents(runId, page, true)
      if (isOver(page.status)) return
      // Time spent waiting for a person is not time the system took.
      const waiting = page.status === 'awaiting_approval'
      if (!waiting && Date.now() - startedAt > RUN_GIVE_UP_MS) return giveUp()
      schedulePoll(runId, reading, waiting ? Date.now() : startedAt, 0, waiting ? APPROVAL_POLL_MS : RUN_POLL_MS)
    }
    catch (error) {
      if (reading !== generation) return
      const failed = failedReads + 1
      if (!isApiProblem(error) || failed >= READ_FAILURES_ALLOWED || error.kind === 'notFound') {
        problem.value = isApiProblem(error) ? error : unavailableProblem()
        runPhase.value = 'over'
        return
      }
      schedulePoll(runId, reading, startedAt, failed, RUN_POLL_MS)
    }
  }

  /** Stops waiting on a run that has not moved for too long, and says so. */
  function giveUp(): void {
    problem.value = new ApiProblem(504, 'upstream_timeout', 'The system behind this demo took too long to answer.')
    runPhase.value = 'over'
    scope.settle()
  }

  /** Reads the visitor's order for the run and says whether it can be sent. */
  function readOrder(): Values | undefined {
    if (orderIssues.value.size > 0) {
      orderShown.value = true
      return undefined
    }
    return valuesOf(orderFieldList.value, orderEntries.value)
  }

  /** Runs the workflow with the test order and the failures asked for. A draft with changes is saved first. Needs the check. */
  async function startRun(): Promise<void> {
    if (!canStart.value) {
      orderShown.value = true
      return
    }
    if (dirty.value && !(await save())) return
    const current = workflow.value
    const input = readOrder()
    if (!current || !input) return
    stopRun()
    clearRun()
    scope.clear()
    busy.value = 'starting'
    problem.value = undefined
    const reading = generation
    const asked = failureRequests()
    try {
      const view = await write(() => callApi(apiClients().node.POST('/api/lb08/workflows/{id}/runs', { params: { path: { id: current.id } }, body: { input, ...(asked.length > 0 ? { failures: asked } : {}) } }), runViewSchema))
      if (reading !== generation) return
      spendRun()
      acceptRun(view, true, false)
    }
    catch (error) {
      if (reading !== generation) return
      fail(error)
    }
    finally {
      if (reading === generation) busy.value = 'idle'
    }
  }

  /** Replays the run on the board, or a dead letter's run: a new run of the same version and order, in the same chain. Counts as a run. Needs the check. */
  async function replayRun(deadLetterId?: string): Promise<void> {
    const original = currentRun.value
    if (!original || !canReplay.value || busy.value !== 'idle') return
    busy.value = 'starting'
    problem.value = undefined
    const reading = generation
    try {
      const view = await write(() => (deadLetterId === undefined
        ? callApi(apiClients().node.POST('/api/lb08/runs/{id}/replay', { params: { path: { id: original.id } } }), runViewSchema)
        : callApi(apiClients().node.POST('/api/lb08/dead-letters/{id}/replay', { params: { path: { id: deadLetterId } } }), runViewSchema)))
      if (reading !== generation) return
      spendRun()
      acceptRun(view, true, true)
    }
    catch (error) {
      if (reading !== generation) return
      fail(error)
    }
    finally {
      if (reading === generation) busy.value = 'idle'
    }
  }

  /** Records a person's answer to an approval step, and has the run read quickly again. Needs the check. */
  async function decide(nodeId: string, decision: 'approved' | 'rejected'): Promise<void> {
    const run = currentRun.value
    if (!run || runMode.value !== 'live' || deciding.value !== undefined) return
    deciding.value = nodeId
    decisionProblem.value = undefined
    const reading = generation
    try {
      const view = await write(() => callApi(apiClients().node.POST('/api/lb08/runs/{id}/steps/{nodeId}/decision', { params: { path: { id: run.id, nodeId } }, body: { decision } }), runViewSchema))
      if (reading !== generation) return
      acceptRunView(view)
      if (timer !== undefined) clearTimeout(timer)
      schedulePoll(run.id, reading, Date.now(), 0, 0)
    }
    catch (error) {
      if (reading === generation) decisionProblem.value = isApiProblem(error) ? error : unavailableProblem()
    }
    finally {
      deciding.value = undefined
    }
  }

  // ---- A replay of a recording ----

  /** Applies one recorded answer to the board, as if the API had just said it. */
  function applyFact(fact: RecordedFact): void {
    switch (fact.kind) {
      case 'workflow':
        acceptWorkflow(fact.view)
        break
      case 'run-started':
        useOrder(fact.view.input)
        acceptRun(fact.view, false, fact.replay)
        break
      case 'run-view':
        acceptRunView(fact.view)
        break
      case 'events':
        acceptEvents(fact.runId, fact.page, false)
        break
      case 'sent':
        sent.value = fact.rows
        break
      case 'dead-letters':
        deadLetters.value = fact.rows
        break
    }
  }

  /** Replays a recording: no request is made and nothing is spent. */
  function replayRecording(recording: Recording): void {
    reset()
    runMode.value = 'replay'
    replay.start(recording, (_, exchange: Exchange) => {
      const fact = factOf(exchange)
      if (fact) applyFact(fact)
    })
  }

  /** Shows a problem the board met outside a call, such as a recording that could not be read. */
  function report(reason: ApiProblem): void {
    problem.value = reason
  }

  /** Stops everything the board is doing, for when the visitor leaves it. */
  function dispose(): void {
    stopRun()
  }

  return {
    runMode,
    busy,
    problem,
    saveProblem,
    decisionProblem,
    limits,
    quota,
    mine,
    mineStatus,
    workflow,
    draft,
    history,
    selection,
    saving,
    validation,
    valid,
    issues,
    dirty,
    triggerEvent,
    orderEntries,
    orderFieldList,
    orderIssues,
    orderShown,
    failures,
    chain,
    runGraph,
    runPhase,
    currentRun,
    runOver,
    sent,
    deadLetters,
    chainLetters,
    ledger,
    deciding,
    canEdit,
    canStart,
    canReplay,
    loadLimits,
    loadMine,
    openSample,
    describe,
    openMine,
    deleteMine,
    select,
    addStep,
    removeStep,
    updateStep,
    changeConnector,
    connect,
    disconnect,
    relabel,
    moveStep,
    rename,
    undo,
    discard,
    save,
    setOrder,
    resetOrder,
    setFailures,
    startRun,
    replayRun,
    decide,
    replayRecording,
    report,
    reset,
    dispose,
  }
})
