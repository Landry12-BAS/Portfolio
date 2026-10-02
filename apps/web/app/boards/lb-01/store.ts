// LB-01's board state: the synthetic customers, the ticket on the board (filed live, or replayed
// from a recording), where its pipeline has got to, the visitor's counters and what is left of
// their day. The board calls the site's API (`/api/lb01/...`) through the typed client and reads
// the ticket by polling it once a second until the pipeline has finished with it: the pipeline
// takes a few seconds to tens of seconds, and polling needs no connection to keep open, which
// the site's serverless host could not do anyway. Every answer is checked with its schema. The
// run's trace is read once the ticket names its run, which Django does only when the pipeline has
// finished; until then the Scope says it is waiting (followRun).
import type { Exchange, Recording } from '@lb/contracts'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { z } from 'zod'

import { apiClients, callApi } from '~/board-kit/api'
import { ApiProblem, isApiProblem, unavailableProblem, verificationProblem } from '~/board-kit/problem'
import { exhausted, quotaFromRuns } from '~/board-kit/quota'
import type { Quota } from '~/board-kit/quota'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import { customerSchema, statsSchema, ticketSchema, ticketSummarySchema } from './schemas'
import type { Customer, Stats, Ticket } from './schemas'

/** How many tickets a visitor may file in a day: the back end's own limit (services/django-systems/lb01/api.py). */
export const TICKETS_PER_DAY = 20
/** How often the ticket is read while its pipeline runs. */
export const TICKET_POLL_MS = 1_000
/** How long the board waits for a pipeline before it says the system took too long. */
export const TICKET_GIVE_UP_MS = 120_000
// A run's first span appears a moment after the ticket is filed, so "no trace yet" is not an error for this long.
const SCOPE_GRACE_MS = 8_000
// Reads that fail for another reason are tried again this many times in a row before the board gives up.
const READ_FAILURES_ALLOWED = 3

/** What is on the board: nothing, a live run, or a replay. */
export type RunMode = 'idle' | 'live' | 'replay'
/** Where the run stands: nothing yet, the ticket being filed, the pipeline working, or finished with. */
export type RunPhase = 'idle' | 'filing' | 'running' | 'done'
/** What the visitor may do with a draft. */
export type DecisionAction = 'approve' | 'edit' | 'escalate'

/** A ticket to file. */
export interface NewTicket {
  customer: string
  language: 'en' | 'cs'
  body: string
}

/** Tells whether the pipeline has finished with a ticket: it waits for a person, or it is settled. */
export function isFinished(ticket: Ticket | undefined): boolean {
  return ticket !== undefined && ticket.status !== 'received' && ticket.status !== 'processing'
}

/** LB-01's board. */
export const useLb01Store = defineStore('lb01', () => {
  const session = useSessionStore()
  const scope = useScopeStore()
  const replay = useReplayStore()

  const customers = shallowRef<readonly Customer[]>([])
  // Whether the list of customers is still being read, was read, or could not be.
  const customersStatus = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const ticket = shallowRef<Ticket>()
  const runMode = ref<RunMode>('idle')
  const phase = ref<RunPhase>('idle')
  const problem = shallowRef<ApiProblem>()
  const decisionProblem = shallowRef<ApiProblem>()
  const deciding = ref(false)
  const stats = shallowRef<Stats>()
  const quota = shallowRef<Quota>()

  // Which run is current: starting another makes every read of an older one stop touching the board.
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const finished = computed(() => isFinished(ticket.value))
  const runOver = computed(() => finished.value || scope.phase === 'finished')
  const canDecide = computed(() => runMode.value === 'live' && ticket.value?.status === 'awaiting_approval' && ticket.value.decision === null)

  /** Reads the synthetic customers a visitor can file tickets as. */
  async function loadCustomers(): Promise<void> {
    customersStatus.value = 'loading'
    try {
      customers.value = await callApi(apiClients().django.GET('/api/lb01/customers'), z.array(customerSchema).max(100))
      customersStatus.value = 'ready'
    }
    catch {
      customers.value = []
      customersStatus.value = 'failed'
    }
  }

  /** Reads the visitor's counters. A failure leaves the old numbers, which is better than blanking them. */
  async function loadStats(): Promise<void> {
    try {
      stats.value = await callApi(apiClients().django.GET('/api/lb01/stats'), statsSchema)
    }
    catch {
      // The counters are a nicety: the run does not depend on them.
    }
  }

  /** Counts the tickets the visitor has filed today from their list, against the daily limit. */
  async function loadQuota(): Promise<void> {
    const resetsAt = session.state?.resetsAt
    if (resetsAt === undefined) return
    try {
      const tickets = await callApi(apiClients().django.GET('/api/lb01/tickets'), z.array(ticketSummarySchema).max(1_000))
      quota.value = quotaFromRuns(tickets.map(item => item.created_at), TICKETS_PER_DAY, resetsAt)
    }
    catch {
      // Without a count the panel says it is counting, and a refusal from the back end still stops a run.
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

  /** Empties the board for the next run. */
  function reset(): void {
    stopRun()
    scope.clear()
    replay.clear()
    ticket.value = undefined
    runMode.value = 'idle'
    phase.value = 'idle'
    problem.value = undefined
    decisionProblem.value = undefined
  }

  /** The pipeline has finished with the ticket: the Scope stops waiting, and the counters and the allowance are read again. */
  function finish(): void {
    phase.value = 'done'
    scope.settle()
    void loadStats()
    void loadQuota()
  }

  /** Stops waiting on the ticket and says why. */
  function giveUp(reason: ApiProblem): void {
    problem.value = reason
    phase.value = 'done'
    scope.settle()
  }

  /**
   * Starts reading the run's trace as soon as the ticket names the run. A back end may name it in
   * the answer to filing, and the Scope then fills in step by step; Django names it only when the
   * pipeline has finished, and the Scope then shows the whole trace at the end. Until the run has a
   * name the Scope says it is waiting. A run that is already being followed is left alone.
   */
  function followRun(current: Ticket): void {
    if (current.run_id === '') {
      if (scope.phase === 'idle') scope.wait()
      return
    }
    if (scope.runId !== current.run_id) scope.follow(current.run_id, { notFoundGraceMs: SCOPE_GRACE_MS })
  }

  /** Reads the ticket until its pipeline has finished with it, once a second. */
  async function poll(id: string, reading: number, startedAt: number, failures: number): Promise<void> {
    let failed = failures
    try {
      const next = await callApi(apiClients().django.GET('/api/lb01/tickets/{ticket_id}', { params: { path: { ticket_id: id } } }), ticketSchema)
      if (reading !== generation) return
      ticket.value = next
      followRun(next)
      failed = 0
      if (isFinished(next)) {
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
    if (Date.now() - startedAt > TICKET_GIVE_UP_MS) {
      giveUp(new ApiProblem(504, 'upstream_timeout', 'The system behind this demo took too long to answer.'))
      return
    }
    timer = setTimeout(() => void poll(id, reading, startedAt, failed), TICKET_POLL_MS)
  }

  /** Starts following a ticket that was just filed. */
  function begin(filed: Ticket): void {
    ticket.value = filed
    phase.value = 'running'
    followRun(filed)
    if (quota.value) quota.value = { ...quota.value, used: quota.value.used + 1, remaining: Math.max(quota.value.remaining - 1, 0) }
    const reading = generation
    timer = setTimeout(() => void poll(filed.id, reading, Date.now(), 0), TICKET_POLL_MS)
  }

  /** Sends a ticket to the back end. If the server says the check is needed again (a new day began), runs it and tries once more. */
  async function send(request: NewTicket): Promise<Ticket> {
    const post = () => callApi(apiClients().django.POST('/api/lb01/tickets', { body: request }), ticketSchema)
    try {
      return await post()
    }
    catch (error) {
      if (!isApiProblem(error) || error.kind !== 'verification') throw error
      session.forgetVerification()
      if (!(await session.ensureVerified())) throw verificationProblem()
      return post()
    }
  }

  /** Files a ticket live: after the check that the visitor is a person, which runs only now, and spends one of the day's tickets. */
  async function file(request: NewTicket): Promise<void> {
    if (phase.value === 'filing') return
    reset()
    runMode.value = 'live'
    phase.value = 'filing'
    const reading = generation
    if (!(await session.ensureVerified())) {
      phase.value = 'idle'
      runMode.value = 'idle'
      problem.value = session.available ? (session.problem ?? verificationProblem()) : unavailableProblem()
      return
    }
    try {
      const filed = await send(request)
      if (reading !== generation) return
      begin(filed)
    }
    catch (error) {
      if (reading !== generation) return
      phase.value = 'idle'
      runMode.value = 'idle'
      problem.value = isApiProblem(error) ? error : unavailableProblem()
      if (problem.value.kind === 'quota' && quota.value) quota.value = exhausted(quota.value)
    }
  }

  /** Applies one recorded answer to the board, as if the API had just said it. Only tickets matter to LB-01's board. */
  function applyExchange(exchange: Exchange): void {
    if (exchange.response.status < 200 || exchange.response.status >= 300) return
    const parsed = ticketSchema.safeParse(exchange.response.body)
    if (!parsed.success) return
    ticket.value = parsed.data
    if (isFinished(parsed.data)) phase.value = 'done'
  }

  /** Replays a recording: no request is made and nothing is spent. */
  function replayRecording(recording: Recording): void {
    reset()
    runMode.value = 'replay'
    phase.value = 'running'
    replay.start(recording, (_, exchange) => applyExchange(exchange))
  }

  /** Records a person's decision about the draft: approve it, edit it, or hand it to a senior agent. */
  async function decide(action: DecisionAction, text?: string): Promise<void> {
    const current = ticket.value
    if (!current || !canDecide.value || deciding.value) return
    deciding.value = true
    decisionProblem.value = undefined
    try {
      const body = action === 'edit' ? { action, text } : { action }
      ticket.value = await callApi(apiClients().django.POST('/api/lb01/tickets/{ticket_id}/decision', { params: { path: { ticket_id: current.id } }, body }), ticketSchema)
      void loadStats()
    }
    catch (error) {
      decisionProblem.value = isApiProblem(error) ? error : unavailableProblem()
    }
    finally {
      deciding.value = false
    }
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
    customers,
    customersStatus,
    ticket,
    runMode,
    phase,
    problem,
    decisionProblem,
    deciding,
    stats,
    quota,
    finished,
    runOver,
    canDecide,
    loadCustomers,
    loadStats,
    loadQuota,
    file,
    replayRecording,
    decide,
    fail,
    reset,
    dispose,
  }
})
