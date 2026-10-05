// LB-06's board state: the incident on the board (a curated sample or a fault of the visitor's own),
// the log of events it has produced, what the agents did and what waits for the visitor, the
// postmortem, and what is left of the visitor's day. The board calls the site's API (`/api/lb06/...`)
// through the typed client and checks every answer with the contracts' schemas.
//
// An incident is followed over a WebSocket: the visitor's pass goes in its first frame, the server
// answers with the incident as it stands, and every event the simulator appends arrives as it
// happens. If the connection cannot be made or is lost for good, the store carries on by polling the
// log's pages, so a network that blocks WebSockets only makes the dashboards a little slower. A
// replay of a recording hands the same answers back through the same functions, so a live incident
// and a replay are drawn by one set of code.
//
// Nothing the visitor wrote is kept here beyond the request that was sent, and nothing is ever
// executed: every cell is an event the service validated and the board validated again.
import type { Exchange, Lb06StartIncidentRequest, Recording } from '@lb/contracts'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { apiClients, callApi, postJson } from '~/board-kit/api'
import { ApiProblem, cookieProblem, isApiProblem, unavailableProblem, verificationProblem } from '~/board-kit/problem'
import type { Quota } from '~/board-kit/quota'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'
import { socketGrantSchema } from '#shared/schema/session'
import { factOf } from './exchange'
import type { RecordedFact } from './exchange'
import { agentRows, discardedEvidence, isEnded, lastSeqOf, latestHypotheses, latestSlo, markersOf, mergeEvents, minuteOf, modelCallsOf, pendingProposalOf, stateOf, timelineEvents } from './incident'
import { incidentListSchema, lb06EventsPageSchema, lb06IncidentViewSchema, lb06LimitsViewSchema, lb06PostmortemViewSchema } from './schemas'
import type { Lb06Event, Lb06IncidentView, Lb06LimitsView, Lb06PostmortemView } from './schemas'
import { ticksOf } from './series'
import { IncidentSocket } from './socket'
import type { ConnectionStatus, End } from './socket'
import type { ServerFrame } from './wire'

/** How often the log is read when the socket is out of reach. A simulated minute takes two seconds of the wall clock, so a read a little faster keeps up. */
export const POLL_MS = 1_500
/** How long the board waits after an event that changes the incident's view before it reads the view, so a burst of events costs one read. */
export const VIEW_REFRESH_MS = 250
/** How long a trace that is not there yet is taken to mean "not yet": the incident's first span appears a moment after it starts. */
const SCOPE_GRACE_MS = 8_000
/** How many reads of the log may fail in a row before the board gives up on following the incident. */
const READ_FAILURES_ALLOWED = 3
/** The events after which the incident's own view is read again, since the view says what the log cannot (the cost, the guard's verdict, the cache). */
const REFRESH_AFTER = new Set<Lb06Event['kind']>([
  'investigation.started',
  'proposal.made',
  'proposal.approved',
  'proposal.rejected',
  'remediation.applied',
  'slo.recovered',
  'postmortem.written',
  'incident.closed',
  'incident.aborted',
  'incident.failed',
])

/** Whether the board is empty, following a live incident, or playing a recording. */
export type RunMode = 'idle' | 'live' | 'replay'
/** What a call that changes something is doing. */
export type Busy = 'idle' | 'starting' | 'deciding' | 'aborting' | 'opening'
/** Where the incident's feed stands: the socket's states, and polling when the socket is out of reach. */
export type Feed = ConnectionStatus | 'polling'
/** Whether an incident is being followed or is over. */
export type RunPhase = 'idle' | 'following' | 'over'

/** Builds the quota the limits panel draws from the service's allowance for incidents. */
function incidentQuota(limits: Lb06LimitsView | undefined): Quota | undefined {
  return limits ? { ...limits.incidents, resetsAt: limits.resetsAt } : undefined
}

/** The allowance after a refusal for being over it: nothing left, whatever the count said. */
function spentAllowance(limits: Lb06LimitsView | undefined): Lb06LimitsView | undefined {
  return limits ? { ...limits, incidents: { limit: limits.incidents.limit, used: limits.incidents.limit, remaining: 0 } } : limits
}

/** LB-06's board. */
export const useLb06Store = defineStore('lb06', () => {
  const session = useSessionStore()
  const scope = useScopeStore()
  const replay = useReplayStore()

  const runMode = ref<RunMode>('idle')
  const busy = ref<Busy>('idle')
  const problem = shallowRef<ApiProblem>()
  const decisionProblem = shallowRef<ApiProblem>()
  const limits = shallowRef<Lb06LimitsView>()
  const mine = shallowRef<readonly Lb06IncidentView[]>([])
  const mineStatus = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')

  const incident = shallowRef<Lb06IncidentView>()
  const events = shallowRef<readonly Lb06Event[]>([])
  const postmortem = shallowRef<Lb06PostmortemView>()
  const runPhase = ref<RunPhase>('idle')
  const feed = ref<Feed>('idle')
  const feedEnd = ref<End['reason']>()
  // The visitor can freeze the dashboards: events keep arriving, and the charts show the log up to this number until the visitor resumes.
  const paused = ref(false)
  const pausedAt = ref(0)

  const state = computed(() => (incident.value ? stateOf(events.value, incident.value.state) : undefined))
  const ended = computed(() => state.value !== undefined && isEnded(state.value))
  const shownEvents = computed(() => (paused.value ? events.value.filter(event => event.seq <= pausedAt.value) : events.value))
  const ticks = computed(() => ticksOf(shownEvents.value))
  const markers = computed(() => markersOf(shownEvents.value))
  const steps = computed(() => agentRows(events.value))
  const hypotheses = computed(() => latestHypotheses(events.value))
  const discarded = computed(() => discardedEvidence(events.value))
  const timeline = computed(() => timelineEvents(events.value))
  const slo = computed(() => latestSlo(events.value) ?? incident.value?.slo ?? undefined)
  const pending = computed(() => (ended.value ? undefined : (events.value.length > 0 ? pendingProposalOf(events.value) : (incident.value?.pendingProposal ?? undefined))))
  const minute = computed(() => Math.max(incident.value?.minute ?? 0, minuteOf(events.value)))
  const modelCalls = computed(() => Math.max(incident.value?.modelCalls ?? 0, modelCallsOf(events.value)))
  const quota = computed(() => incidentQuota(limits.value))
  const canStart = computed(() => busy.value === 'idle' && runPhase.value !== 'following' && (quota.value?.remaining ?? 1) > 0)
  const canAbort = computed(() => runMode.value === 'live' && runPhase.value === 'following' && busy.value === 'idle')

  // Which incident the board is following: a newer one makes every older callback stop touching the store.
  let generation = 0
  let socket: IncidentSocket | undefined
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let refreshing = false

  // ---- The visitor's day ----

  /** Reads what is left of the visitor's day. A failure leaves the old numbers, which is better than blanking them. */
  async function loadLimits(): Promise<void> {
    try {
      limits.value = await callApi(apiClients().node.GET('/api/lb06/limits'), lb06LimitsViewSchema)
    }
    catch {
      // The counters are a nicety: the service still refuses what is over the limit.
    }
  }

  /** Reads the visitor's incidents of the day, so a reload can take up where it left off. */
  async function loadMine(): Promise<void> {
    mineStatus.value = 'loading'
    try {
      mine.value = await callApi(apiClients().node.GET('/api/lb06/incidents'), incidentListSchema)
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

  /** Reads a failure into the problem the board shows, and counts the day's allowance as spent when the service says it is. */
  function fail(error: unknown): void {
    problem.value = isApiProblem(error) ? error : unavailableProblem()
    if (problem.value.kind === 'quota') limits.value = spentAllowance(limits.value)
  }

  // ---- Stopping and starting over ----

  /** Cancels the incident being followed: its socket, its polling, its replay and its trace reading. */
  function stopRun(): void {
    generation += 1
    socket?.dispose()
    socket = undefined
    if (pollTimer !== undefined) clearTimeout(pollTimer)
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    pollTimer = undefined
    refreshTimer = undefined
    refreshing = false
    feed.value = 'idle'
    replay.stop()
    scope.stop()
  }

  /** Forgets the incident on the board. */
  function clearRun(): void {
    incident.value = undefined
    events.value = []
    postmortem.value = undefined
    runPhase.value = 'idle'
    feed.value = 'idle'
    feedEnd.value = undefined
    paused.value = false
    pausedAt.value = 0
    decisionProblem.value = undefined
  }

  /** Empties the board for the next incident. */
  function reset(): void {
    stopRun()
    scope.clear()
    replay.clear()
    runMode.value = 'idle'
    busy.value = 'idle'
    problem.value = undefined
    clearRun()
  }

  // ---- An incident ----

  /** Keeps the visitor's list of the day's incidents in step with the live one on the board, so a new incident is listed at once and not only after a reload. */
  function noteMine(view: Lb06IncidentView): void {
    mine.value = [view, ...mine.value.filter(item => item.id !== view.id)]
  }

  /** Takes the service's view of the incident: where it stands, what it has cost, and what the guard said. */
  function acceptView(view: Lb06IncidentView): void {
    if (incident.value !== undefined && incident.value.id !== view.id) return
    incident.value = view
    if (runMode.value === 'live') noteMine(view)
    wrapUpIfOver()
  }

  /** Takes events from the feed, a polled page or a recording, and does what they call for. */
  function acceptEvents(incoming: readonly Lb06Event[]): void {
    if (incoming.length === 0) return
    events.value = mergeEvents(events.value, incoming)
    if (runMode.value === 'live' && incoming.some(event => REFRESH_AFTER.has(event.kind))) scheduleRefresh()
    wrapUpIfOver()
  }

  /** Reads the incident's view again soon, once however many events asked for it in the meantime. */
  function scheduleRefresh(): void {
    if (refreshTimer !== undefined) return
    const reading = generation
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void refreshView(reading)
    }, VIEW_REFRESH_MS)
  }

  /** Reads the incident's view and takes it. */
  async function refreshView(reading: number): Promise<void> {
    const current = incident.value
    if (!current || refreshing || reading !== generation) return
    refreshing = true
    try {
      const view = await callApi(apiClients().node.GET('/api/lb06/incidents/{id}', { params: { path: { id: current.id } } }), lb06IncidentViewSchema)
      if (reading === generation) acceptView(view)
    }
    catch {
      // The log has what the dashboards need; the next event asks for the view again.
    }
    finally {
      refreshing = false
    }
  }

  /** When the incident is over, stops following it, lets the Scope finish, and reads what a closed incident leaves behind. */
  function wrapUpIfOver(): void {
    if (!ended.value || runPhase.value === 'over') return
    runPhase.value = 'over'
    socket?.dispose()
    socket = undefined
    if (pollTimer !== undefined) clearTimeout(pollTimer)
    pollTimer = undefined
    feed.value = 'idle'
    if (runMode.value !== 'live') return
    scope.settle()
    // The last events change what the view says (the calls spent, why it ended), so read it at once instead of after the usual wait.
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    refreshTimer = undefined
    void refreshView(generation)
    void loadLimits()
    if (state.value === 'closed') void loadPostmortem(generation)
  }

  /** Reads the postmortem of a closed incident. */
  async function loadPostmortem(reading: number): Promise<void> {
    const current = incident.value
    if (!current || postmortem.value !== undefined) return
    try {
      const view = await callApi(apiClients().node.GET('/api/lb06/incidents/{id}/postmortem', { params: { path: { id: current.id } } }), lb06PostmortemViewSchema)
      if (reading === generation) postmortem.value = view
    }
    catch {
      // The timeline in the log says the same; the page tells the visitor the postmortem could not be read.
    }
  }

  /** Puts a new incident on the board: its view, an empty log, the Scope on its run, and the feed. */
  function begin(view: Lb06IncidentView): void {
    incident.value = view
    if (runMode.value === 'live') noteMine(view)
    events.value = []
    postmortem.value = undefined
    runPhase.value = isEnded(view.state) ? 'over' : 'following'
    scope.follow(view.runId, { notFoundGraceMs: SCOPE_GRACE_MS })
    if (runPhase.value === 'following') openFeed(view.id)
  }

  /** Starts an incident: a curated sample, or a fault of the visitor's own. Counts as the day's incident. Needs the check. */
  async function start(request: Lb06StartIncidentRequest): Promise<void> {
    if (!canStart.value) return
    stopRun()
    clearRun()
    scope.clear()
    replay.clear()
    runMode.value = 'live'
    busy.value = 'starting'
    problem.value = undefined
    const reading = generation
    try {
      const view = await write(() => callApi(apiClients().node.POST('/api/lb06/incidents', { body: request }), lb06IncidentViewSchema))
      if (reading !== generation) return
      if (limits.value) limits.value = { ...limits.value, incidents: { ...limits.value.incidents, used: limits.value.incidents.used + 1, remaining: Math.max(0, limits.value.incidents.remaining - 1) } }
      begin(view)
    }
    catch (error) {
      if (reading !== generation) return
      runMode.value = 'idle'
      fail(error)
    }
    finally {
      if (reading === generation) busy.value = 'idle'
    }
  }

  /** Opens an incident the visitor started earlier (after a reload): reads its whole log, and follows it if it is still going. */
  async function openMine(view: Lb06IncidentView): Promise<void> {
    if (busy.value !== 'idle') return
    stopRun()
    clearRun()
    scope.clear()
    replay.clear()
    runMode.value = 'live'
    busy.value = 'opening'
    problem.value = undefined
    const reading = generation
    incident.value = view
    try {
      let after = 0
      for (let page = 0; page < 8; page += 1) {
        const answer = await callApi(apiClients().node.GET('/api/lb06/incidents/{id}/events', { params: { path: { id: view.id }, query: { after } } }), lb06EventsPageSchema)
        if (reading !== generation) return
        events.value = mergeEvents(events.value, answer.events)
        after = lastSeqOf(events.value)
        if (!answer.more) break
      }
      const fresh = await callApi(apiClients().node.GET('/api/lb06/incidents/{id}', { params: { path: { id: view.id } } }), lb06IncidentViewSchema)
      if (reading !== generation) return
      incident.value = fresh
      runPhase.value = ended.value ? 'over' : 'following'
      scope.follow(fresh.runId, { notFoundGraceMs: SCOPE_GRACE_MS })
      if (runPhase.value === 'following') openFeed(fresh.id)
      else {
        scope.settle()
        if (state.value === 'closed') void loadPostmortem(reading)
      }
    }
    catch (error) {
      if (reading !== generation) return
      runMode.value = 'idle'
      clearRun()
      fail(error)
    }
    finally {
      if (reading === generation) busy.value = 'idle'
    }
  }

  /** Answers the proposal that waits: approving it applies the action, rejecting it sends the agents back to work. Needs the check. */
  async function decide(decision: 'approve' | 'reject'): Promise<void> {
    const current = incident.value
    const proposal = pending.value
    if (!current || !proposal || runMode.value !== 'live' || busy.value !== 'idle') return
    busy.value = 'deciding'
    decisionProblem.value = undefined
    const reading = generation
    try {
      const view = await write(() => callApi(apiClients().node.POST('/api/lb06/incidents/{id}/proposals/{proposalId}/decision', { params: { path: { id: current.id, proposalId: proposal.id } }, body: { decision } }), lb06IncidentViewSchema))
      if (reading === generation) acceptView(view)
    }
    catch (error) {
      if (reading === generation) decisionProblem.value = isApiProblem(error) ? error : unavailableProblem()
    }
    finally {
      if (reading === generation) busy.value = 'idle'
    }
  }

  /** Ends the incident early. The day's incident stays used. Needs the check. */
  async function abort(): Promise<void> {
    const current = incident.value
    if (!current || !canAbort.value) return
    busy.value = 'aborting'
    const reading = generation
    try {
      const view = await write(() => callApi(apiClients().node.POST('/api/lb06/incidents/{id}/abort', { params: { path: { id: current.id } } }), lb06IncidentViewSchema))
      if (reading === generation) acceptView(view)
    }
    catch (error) {
      if (reading === generation) decisionProblem.value = isApiProblem(error) ? error : unavailableProblem()
    }
    finally {
      if (reading === generation) busy.value = 'idle'
    }
  }

  // ---- The feed ----

  /** Asks the site for a new pass for the socket. */
  async function fetchGrant(): Promise<{ url: string, token: string }> {
    const grant = await postJson('/api/tokens/lb-06', undefined, socketGrantSchema)
    return { url: grant.socketUrl, token: grant.token }
  }

  /** Follows the incident over a WebSocket, from the event after the last one the board holds. */
  function openFeed(incidentId: string): void {
    socket?.dispose()
    const reading = generation
    feed.value = 'connecting'
    socket = new IncidentSocket(
      { grant: fetchGrant, connect: url => new WebSocket(url), random: Math.random },
      {
        status: (status) => {
          if (reading === generation) feed.value = status
        },
        frame: (frame) => {
          if (reading === generation) onFrame(frame)
        },
        ended: (end) => {
          if (reading === generation) onSocketEnded(end, incidentId, reading)
        },
      },
    )
    socket.open(incidentId, lastSeqOf(events.value))
  }

  /** Takes one frame from the socket. */
  function onFrame(frame: ServerFrame): void {
    if (frame.type === 'ready') {
      acceptView(frame.incident)
      acceptEvents(frame.events)
    }
    else if (frame.type === 'event') acceptEvents([frame.event])
  }

  /** The socket stopped for good: say why, and carry on by polling unless the incident is over or gone. */
  function onSocketEnded(end: End, incidentId: string, reading: number): void {
    socket = undefined
    if (end.reason === 'visitor') return
    feedEnd.value = end.reason
    if (end.reason === 'not_found') {
      problem.value = new ApiProblem(404, 'incident_not_found', 'There is no such incident, or it has been deleted.')
      runPhase.value = 'over'
      feed.value = 'closed'
      return
    }
    if (runPhase.value === 'over') return
    feed.value = 'polling'
    schedulePoll(incidentId, reading, 0, 0)
  }

  /** Waits, then reads the log's next page. */
  function schedulePoll(incidentId: string, reading: number, failedReads: number, delayMs: number): void {
    pollTimer = setTimeout(() => void poll(incidentId, reading, failedReads), delayMs)
  }

  /** Reads the events after the last one the board holds, and carries on until the incident is over. */
  async function poll(incidentId: string, reading: number, failedReads: number): Promise<void> {
    if (reading !== generation) return
    try {
      const page = await callApi(apiClients().node.GET('/api/lb06/incidents/{id}/events', { params: { path: { id: incidentId }, query: { after: lastSeqOf(events.value) } } }), lb06EventsPageSchema)
      if (reading !== generation) return
      acceptEvents(page.events)
      if (isEnded(page.state)) {
        await refreshView(reading)
        return
      }
      schedulePoll(incidentId, reading, 0, page.more ? 0 : POLL_MS)
    }
    catch (error) {
      if (reading !== generation) return
      const failed = failedReads + 1
      if (!isApiProblem(error) || failed >= READ_FAILURES_ALLOWED || error.kind === 'notFound') {
        problem.value = isApiProblem(error) ? error : unavailableProblem()
        runPhase.value = 'over'
        feed.value = 'closed'
        return
      }
      schedulePoll(incidentId, reading, failed, POLL_MS)
    }
  }

  // ---- The dashboards' pause ----

  /** Freezes the dashboards at the event the board holds now: nothing is lost, and the log keeps filling behind them. */
  function pause(): void {
    pausedAt.value = lastSeqOf(events.value)
    paused.value = true
  }

  /** Lets the dashboards catch up with the log. */
  function resume(): void {
    paused.value = false
  }

  // ---- A replay of a recording ----

  /** Applies one recorded answer to the board, as if the API had just said it. */
  function applyFact(fact: RecordedFact): void {
    switch (fact.kind) {
      case 'started':
        incident.value = fact.view
        events.value = []
        postmortem.value = undefined
        runPhase.value = 'following'
        break
      case 'view':
        acceptView(fact.view)
        break
      case 'events':
        acceptEvents(fact.page.events)
        break
      case 'postmortem':
        postmortem.value = fact.view
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
    decisionProblem,
    limits,
    quota,
    mine,
    mineStatus,
    incident,
    events,
    postmortem,
    runPhase,
    feed,
    feedEnd,
    paused,
    state,
    ended,
    ticks,
    markers,
    steps,
    hypotheses,
    discarded,
    timeline,
    slo,
    pending,
    minute,
    modelCalls,
    canStart,
    canAbort,
    loadLimits,
    loadMine,
    start,
    openMine,
    decide,
    abort,
    pause,
    resume,
    replayRecording,
    report,
    reset,
    dispose,
  }
})
