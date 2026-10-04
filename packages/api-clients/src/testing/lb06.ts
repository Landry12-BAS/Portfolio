// LB-06 Incident Commander as the mock back end plays it: a visitor breaks the shop with a sample or
// a fault of their own, follows the incident over the WebSocket (or by polling its events), approves or
// rejects the proposal, aborts, and reads the postmortem. The answers have the shapes
// services/node-systems/openapi.json documents. What stands behind them is the service's own code over
// the service's own data: the real simulator, the real SLO and correlation, the real orchestrator with
// the golden set's reference agents in place of the models, the real tick data and the real
// postmortem timeline. The daily incident, the global cap, the step cap, the wall-clock cap and the
// proposals' cap are the real service's too. The clock ticks on a timer (a few tens of milliseconds a
// simulated minute, so a whole incident takes seconds), and every event reaches the open sockets the
// moment it is appended.
import { randomUUID } from 'node:crypto'

import { createRun, runScope, spanScope, Tracer } from '../../../common/src/index.ts'
import type { Run, Span } from '../../../common/src/index.ts'
import { LB06_LIMITS, lb06EventSchema, lb06FaultParamsSchema, lb06IncidentViewSchema, lb06ScenarioSchema, lb06StartIncidentRequestSchema } from '../../../contracts/src/index.ts'
import type { Lb06Event, Lb06EventInput, Lb06FaultParams, Lb06IncidentView, Lb06PendingProposal, Lb06Scenario, Lb06SpecialistReport, Lb06State, Lb06StartIncidentRequest } from '../../../contracts/src/index.ts'
import { contextOf, investigate, ModelOutputInvalid, proposeAgain, StepCapReached, writePostmortem } from '../../../../services/node-systems/src/modules/lb06/agents/orchestrator.ts'
import type { Budget } from '../../../../services/node-systems/src/modules/lb06/agents/orchestrator.ts'
import { timelineOf } from '../../../../services/node-systems/src/modules/lb06/agents/postmortem.ts'
import { catalogueView, readSampleCatalogue } from '../../../../services/node-systems/src/modules/lb06/data/samples.ts'
import { healthyStreak, sloAt } from '../../../../services/node-systems/src/modules/lb06/detect/slo.ts'
import { evidenceIndex } from '../../../../services/node-systems/src/modules/lb06/detect/summary.ts'
import { sloViewAt, tickData } from '../../../../services/node-systems/src/modules/lb06/detect/tick.ts'
import { ReferenceAgents } from '../../../../services/node-systems/src/modules/lb06/golden/reference.ts'
import { faultService } from '../../../../services/node-systems/src/modules/lb06/sim/deploys.ts'
import type { Remediation } from '../../../../services/node-systems/src/modules/lb06/sim/faults.ts'
import { buildWorld } from '../../../../services/node-systems/src/modules/lb06/sim/world.ts'

import { errorAnswer } from './lb01.ts'
import type { Answer } from './lb01.ts'
import type { MockSpan } from './spans.ts'

const DAY_MS = 86_400_000
const PAGE = 200
const INVESTIGATION_DELAY_MINUTES = 2
const VERIFY_MINUTES = 12

/** What a test may choose about the mock's LB-06. */
export interface Lb06MockOptions {
  // Wall-clock milliseconds between two simulated minutes: fast by default, so a whole incident takes seconds.
  tickMs?: number
  // The most wall-clock milliseconds an incident may live.
  maxWallMs?: number
  // How long a connection has to say hello, and how long it may be silent after.
  helloTimeoutMs?: number
  idleTimeoutMs?: number
}

/** The ways the mock may be told to misbehave for a test. */
type Misbehaviour = 'agents_down' | 'step_cap'

/** A span writer that keeps every span by run. */
class SpanStore {
  readonly byRun = new Map<string, Span[]>()

  /** Keeps the spans. */
  async write(spans: readonly Span[]): Promise<void> {
    for (const span of spans) {
      const list = this.byRun.get(span.runId) ?? []
      list.push(span)
      this.byRun.set(span.runId, list)
    }
  }
}

/** One incident the mock runs. */
class MockIncident {
  readonly id = randomUUID()
  readonly log: Lb06Event[] = []
  state: Lb06State = 'detecting'
  endReason: Lb06IncidentView['endReason'] = null
  minute: number
  modelCalls: number
  proposalsMade = 0
  pending: Lb06PendingProposal | null = null
  rerank = false
  remediations: Remediation[] = []
  remediatedAt: number | null = null
  alertMinute: number | null = null
  recoveredMinute: number | null = null
  reports: Lb06SpecialistReport[] = []
  working: Promise<void> | undefined
  timer: ReturnType<typeof setInterval> | undefined
  readonly createdAt: number
  readonly deadlineAt: number
  readonly expiresAt: number
  readonly session: string
  readonly origin: 'sample' | 'custom'
  readonly sampleId: string | null
  readonly scenario: Lb06Scenario
  readonly guard: Lb06IncidentView['guard']

  /** Makes an incident at its fault minute. */
  constructor(session: string, origin: 'sample' | 'custom', sampleId: string | null, scenario: Lb06Scenario, guard: Lb06IncidentView['guard'], modelCalls: number, now: number, maxWallMs: number) {
    this.session = session
    this.origin = origin
    this.sampleId = sampleId
    this.scenario = scenario
    this.guard = guard
    this.minute = scenario.baselineMinutes
    this.modelCalls = modelCalls
    this.createdAt = now
    this.deadlineAt = now + maxWallMs
    this.expiresAt = now + LB06_LIMITS.keptHours * 3_600_000
  }

  /** The run its calls belong to. */
  run(): Run {
    return createRun({ system: 'lb-06', runId: this.id, session: this.session, dataClass: this.origin === 'sample' ? 'synthetic' : 'visitor' })
  }

  /** Whether it has ended. */
  get ended(): boolean {
    return this.state === 'closed' || this.state === 'aborted' || this.state === 'failed'
  }
}

/** What listens to an incident's events. */
export interface Lb06Listener {
  send: (event: Lb06Event) => void
}

/** The mock's LB-06. */
export class Lb06Mock {
  readonly #now: () => number
  readonly #options: Required<Lb06MockOptions>
  readonly #incidents = new Map<string, MockIncident>()
  readonly #usage = new Map<string, number>()
  readonly #listeners = new Map<string, Set<Lb06Listener>>()
  readonly #spans = new SpanStore()
  readonly #tracer: Tracer
  readonly #catalogue = readSampleCatalogue()
  #misbehaviour: Misbehaviour | undefined

  /** Makes the mock's LB-06 with its clock and settings. */
  constructor(now: () => number, options: Lb06MockOptions = {}) {
    this.#now = now
    this.#options = { tickMs: options.tickMs ?? 60, maxWallMs: options.maxWallMs ?? 90_000, helloTimeoutMs: options.helloTimeoutMs ?? 10_000, idleTimeoutMs: options.idleTimeoutMs ?? 15 * 60_000 }
    this.#tracer = new Tracer(this.#spans)
  }

  /** The socket settings, for the hub. */
  get socketOptions(): { helloTimeoutMs: number, idleTimeoutMs: number } {
    return { helloTimeoutMs: this.#options.helloTimeoutMs, idleTimeoutMs: this.#options.idleTimeoutMs }
  }

  /** Forgets every incident and stops every clock. */
  reset(): void {
    for (const incident of this.#incidents.values()) if (incident.timer) clearInterval(incident.timer)
    this.#incidents.clear()
    this.#usage.clear()
    this.#listeners.clear()
    this.#spans.byRun.clear()
    this.#misbehaviour = undefined
  }

  /** Makes the next incident's agents fail (`agents_down`) or reach the step cap (`step_cap`). */
  misbehave(how: Misbehaviour | undefined): void {
    this.#misbehaviour = how
  }

  /** The spans of an incident's trace, for the Scope. */
  spansOf(runId: string): MockSpan[] | undefined {
    const spans = this.#spans.byRun.get(runId)
    return spans ? spans.map(span => ({ ...span, system: 'lb-06' as const }) as MockSpan) : undefined
  }

  /** Adds a listener to an incident's events; returns how to stop. */
  listen(incidentId: string, listener: Lb06Listener): () => void {
    const set = this.#listeners.get(incidentId) ?? new Set()
    set.add(listener)
    this.#listeners.set(incidentId, set)
    return () => {
      set.delete(listener)
    }
  }

  /** The day's key of a session. */
  #dayKey(session: string): string {
    return `${session}:${new Date(this.#now()).toISOString().slice(0, 10)}`
  }

  /** How many incidents run now. */
  #running(): number {
    return [...this.#incidents.values()].filter(incident => !incident.ended && incident.expiresAt > this.#now()).length
  }

  /** The visitor's day and the limits. */
  limits(session: string): Answer {
    const used = this.#usage.get(this.#dayKey(session)) ?? 0
    const day = new Date(this.#now()).toISOString().slice(0, 10)
    return { status: 200, body: {
      incidents: { limit: LB06_LIMITS.incidentsPerVisitorPerDay, used, remaining: Math.max(0, LB06_LIMITS.incidentsPerVisitorPerDay - used) },
      stepCap: LB06_LIMITS.stepCap,
      maxConcurrentIncidents: LB06_LIMITS.maxConcurrentIncidents,
      maxWallMinutes: Math.max(1, Math.round(this.#options.maxWallMs / 60_000)),
      keptHours: LB06_LIMITS.keptHours,
      running: this.#running(),
      resetsAt: new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString(),
    } }
  }

  /** The faults and the samples. */
  catalogue(): Answer {
    return { status: 200, body: catalogueView(this.#catalogue, this.#options.tickMs) }
  }

  /** An incident of a visitor, or undefined. */
  #own(session: string, id: string): MockIncident | undefined {
    const incident = this.#incidents.get(id)
    return incident && incident.session === session && incident.expiresAt > this.#now() ? incident : undefined
  }

  /** The view of an incident. */
  #view(incident: MockIncident): Lb06IncidentView {
    const world = buildWorld(incident.scenario, incident.remediations, incident.minute + 1)
    return lb06IncidentViewSchema.parse({
      id: incident.id,
      runId: incident.id,
      origin: incident.origin,
      sampleId: incident.sampleId,
      scenario: incident.scenario,
      state: incident.state,
      endReason: incident.endReason,
      minute: incident.minute,
      faultMinute: incident.scenario.baselineMinutes,
      guard: incident.guard,
      modelCalls: incident.modelCalls,
      cached: false,
      proposalsMade: incident.proposalsMade,
      pendingProposal: incident.pending,
      remediations: incident.remediations,
      slo: sloViewAt(world, incident.minute),
      healthyStreak: healthyStreak(world, incident.minute),
      alertMinute: incident.alertMinute,
      recoveredMinute: incident.recoveredMinute,
      lastSeq: incident.log.length,
      createdAt: new Date(incident.createdAt).toISOString(),
      deadlineAt: new Date(incident.deadlineAt).toISOString(),
      expiresAt: new Date(incident.expiresAt).toISOString(),
    })
  }

  /** The view of a visitor's incident, for the socket. */
  viewOf(session: string, id: string): Lb06IncidentView | undefined {
    const incident = this.#own(session, id)
    return incident ? this.#view(incident) : undefined
  }

  /** The events of a visitor's incident after a number, for the socket. */
  eventsAfter(session: string, id: string, after: number): Lb06Event[] {
    const incident = this.#own(session, id)
    return incident ? incident.log.filter(event => event.seq > after) : []
  }

  /** Appends an event and tells the listeners. */
  #append(incident: MockIncident, input: Lb06EventInput): Lb06Event {
    const event = lb06EventSchema.parse({ ...input, seq: incident.log.length + 1, at: new Date(this.#now()).toISOString() })
    incident.log.push(event)
    for (const listener of this.#listeners.get(incident.id) ?? []) listener.send(event)
    return event
  }

  /** Starts an incident. */
  start(session: string, body: unknown): Answer {
    const request = lb06StartIncidentRequestSchema.safeParse(body)
    if (!request.success) return errorAnswer(422, 'invalid_request', 'The request is not valid.')
    const asked = this.#scenario(request.data)
    if (!asked) return errorAnswer(404, 'unknown_sample', 'There is no sample with that id.')
    const key = this.#dayKey(session)
    const used = this.#usage.get(key) ?? 0
    if (used >= LB06_LIMITS.incidentsPerVisitorPerDay) {
      const day = new Date(this.#now()).toISOString().slice(0, 10)
      const reset = new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS)
      return { status: 429, body: { error: { code: 'daily_limit', message: 'You have started 1 incident today, which is the limit. It starts again at 00:00 UTC.', resets_at: reset.toISOString() } }, headers: { 'retry-after': String(Math.ceil((reset.getTime() - this.#now()) / 1000)) } }
    }
    if (this.#running() >= LB06_LIMITS.maxConcurrentIncidents) return { ...errorAnswer(503, 'too_many_incidents', '8 incidents are running already, which is as many as this demo runs at once. Try again in a few minutes.'), headers: { 'retry-after': '60' } }
    this.#usage.set(key, used + 1)
    // The injection screen, as the mock plays it: a string that says "ignore" is flagged and replaced.
    const params = asked.scenario.params
    const texts = [params.version, params.flag].filter((text): text is string => text !== undefined)
    const flagged = texts.some(text => /ignore/i.test(text))
    const screened: Lb06FaultParams = flagged ? lb06FaultParamsSchema.parse({ ...(params.version === undefined ? {} : { version: 'screened-by-guard' }), ...(params.flag === undefined ? {} : { flag: 'screened-by-guard' }) }) : params
    const guard: Lb06IncidentView['guard'] = texts.length === 0 ? 'not_needed' : flagged ? 'flagged' : 'clean'
    const scenario = { ...asked.scenario, params: screened }
    const incident = new MockIncident(session, asked.origin, asked.sampleId, scenario, guard, texts.length === 0 ? 0 : 1, this.#now(), this.#options.maxWallMs)
    this.#incidents.set(incident.id, incident)
    const faultMinute = scenario.baselineMinutes
    const world = buildWorld(scenario, [], faultMinute + 1)
    this.#append(incident, { kind: 'incident.started', minute: 0, data: scenario })
    for (let minute = 0; minute < faultMinute; minute += 1) this.#append(incident, { kind: 'tick', minute, data: tickData(world, minute) })
    this.#append(incident, { kind: 'fault.injected', minute: faultMinute, data: { fault: scenario.fault, service: faultService(scenario.fault) } })
    this.#append(incident, { kind: 'tick', minute: faultMinute, data: tickData(world, faultMinute) })
    if (guard !== 'not_needed') void runScope(incident.run(), () => this.#tracer.span('injection screen', async span => span.set('flagged', flagged)))
    incident.timer = setInterval(() => this.#tick(incident), this.#options.tickMs)
    return { status: 201, body: this.#view(incident) }
  }

  /** The scenario a request asks for. */
  #scenario(request: Lb06StartIncidentRequest): { scenario: Lb06Scenario, origin: 'sample' | 'custom', sampleId: string | null } | undefined {
    if (request.from === 'sample') {
      const scenario = this.#catalogue.scenarioOf(request.sampleId)
      return scenario ? { scenario, origin: 'sample', sampleId: request.sampleId } : undefined
    }
    const scenario = lb06ScenarioSchema.parse({ seed: request.seed ?? Math.floor(this.#now() % 1_000_000), fault: request.fault, params: request.params ?? {}, baselineMinutes: LB06_LIMITS.baselineMinutes })
    return { scenario, origin: 'custom', sampleId: null }
  }

  /** Ends an incident, stops its clock and writes its root span. */
  #end(incident: MockIncident, state: 'closed' | 'aborted' | 'failed', reason: Lb06IncidentView['endReason']): void {
    if (incident.ended) return
    incident.state = state
    incident.endReason = reason
    incident.pending = null
    if (incident.timer) clearInterval(incident.timer)
    incident.timer = undefined
    if (state !== 'closed') this.#append(incident, { kind: state === 'aborted' ? 'incident.aborted' : 'incident.failed', minute: incident.minute, data: { reason: reason ?? 'lost' } })
    void runScope(incident.run(), () => this.#tracer.record({ name: 'incident', kind: 'system.run', status: state === 'closed' ? 'ok' : 'error', spanId: rootSpanId(incident.id), startMs: incident.createdAt, endMs: this.#now(), attrs: { outcome: reason ?? state, origin: incident.origin, minutes: incident.minute, model_calls: incident.modelCalls, proposals: incident.proposalsMade, cached: false } }))
  }

  /** One tick of an incident's clock: the state machine of the real job. */
  #tick(incident: MockIncident): void {
    if (incident.ended) return
    const minute = incident.minute + 1
    if (this.#now() >= incident.deadlineAt || minute >= LB06_LIMITS.maxSimulatedMinutes) {
      this.#end(incident, 'aborted', 'timed_out')
      return
    }
    incident.minute = minute
    const world = buildWorld(incident.scenario, incident.remediations, minute + 1)
    this.#append(incident, { kind: 'tick', minute, data: tickData(world, minute) })
    let work: 'investigate' | 'rerank' | 'postmortem' | undefined
    if (incident.state === 'detecting') {
      const slo = sloAt(world, minute)
      if (incident.alertMinute === null && slo.alerting) {
        this.#append(incident, { kind: 'alert.fired', minute, data: { burn: slo.burns[0] as NonNullable<(typeof slo.burns)[0]> } })
        incident.alertMinute = minute
      }
      if (incident.alertMinute !== null && minute >= incident.alertMinute + INVESTIGATION_DELAY_MINUTES) {
        this.#append(incident, { kind: 'investigation.started', minute, data: { snapshotMinute: minute } })
        incident.state = 'investigating'
        work = 'investigate'
      }
    }
    else if (incident.state === 'investigating' && !incident.working) {
      work = incident.rerank ? 'rerank' : 'investigate'
    }
    else if (incident.state === 'remediating') {
      incident.state = 'verifying'
    }
    else if (incident.state === 'verifying') {
      const streak = healthyStreak(world, minute)
      if (streak >= LB06_LIMITS.recoveryMinutes) {
        this.#append(incident, { kind: 'slo.recovered', minute, data: { healthyMinutes: streak } })
        incident.recoveredMinute = minute
        incident.state = 'writing_postmortem'
        work = 'postmortem'
      }
      else if (incident.remediatedAt !== null && minute - incident.remediatedAt >= VERIFY_MINUTES) {
        if (incident.proposalsMade >= LB06_LIMITS.maxProposals) {
          this.#end(incident, 'aborted', 'proposals_spent')
          return
        }
        incident.state = 'investigating'
        incident.rerank = true
        work = 'rerank'
      }
    }
    else if (incident.state === 'writing_postmortem' && !incident.working) {
      work = 'postmortem'
    }
    if (work && !incident.working) {
      const kind = work
      incident.working = runScope(incident.run(), () => spanScope(rootSpanId(incident.id), () => this.#work(incident, kind))).catch((error: unknown) => {
        if (error instanceof StepCapReached) this.#end(incident, 'aborted', 'step_cap')
        else if (error instanceof ModelOutputInvalid || (error instanceof Error && error.name === 'AgentsDown')) this.#end(incident, 'failed', 'agents_unavailable')
        else throw error
      }).finally(() => {
        incident.working = undefined
      })
    }
  }

  /** The agents' work beside the clock, on the snapshot of the moment it was called for. */
  async #work(incident: MockIncident, kind: 'investigate' | 'rerank' | 'postmortem'): Promise<void> {
    const agents = this.#agents()
    const budget: Budget = { cap: this.#misbehaviour === 'step_cap' ? 2 : LB06_LIMITS.stepCap, used: incident.modelCalls }
    const deps = { models: { reason: agents, tools: agents }, tracer: this.#tracer, emit: async (event: Lb06EventInput) => {
      if (!incident.ended) this.#append(incident, event)
    } }
    if (kind === 'postmortem') {
      const prose = await writePostmortem(deps, timelineOf(incident.log), budget, incident.minute)
      if (incident.state !== 'writing_postmortem') return
      incident.modelCalls = Math.min(LB06_LIMITS.stepCap, budget.used)
      this.#append(incident, { kind: 'postmortem.written', minute: incident.minute, data: { prose, modelCalls: incident.modelCalls } })
      this.#append(incident, { kind: 'incident.closed', minute: incident.minute, data: { modelCalls: incident.modelCalls, proposals: Math.max(1, incident.proposalsMade) } })
      this.#end(incident, 'closed', null)
      return
    }
    const world = buildWorld(incident.scenario, incident.remediations, incident.minute + 1)
    const context = contextOf(world, evidenceIndex(world, [...new Set(incident.log.map(event => event.kind))]))
    const tried = incident.log.filter(event => event.kind === 'proposal.made').map(event => JSON.stringify(event.data.action))
    let result: Awaited<ReturnType<typeof proposeAgain>>
    if (kind === 'investigate') {
      const investigation = await investigate(deps, context, budget)
      incident.reports = investigation.reports
      result = investigation
    }
    else {
      result = await proposeAgain(deps, context, budget, incident.reports, tried)
    }
    if (incident.state !== 'investigating') return
    const id = `p${incident.proposalsMade + 1}` as Lb06PendingProposal['id']
    incident.pending = { id, hypothesisId: result.proposal.hypothesisId, action: result.proposal.action, rationale: result.proposal.rationale }
    incident.proposalsMade += 1
    incident.modelCalls = Math.min(LB06_LIMITS.stepCap, budget.used)
    incident.rerank = false
    incident.state = 'awaiting_approval'
    this.#append(incident, { kind: 'proposal.made', minute: incident.minute, data: { proposalId: id, hypothesisId: incident.pending.hypothesisId, action: incident.pending.action, rationale: incident.pending.rationale } })
  }

  /** The reference agents, or ones that cannot be reached when a test asked for that. */
  #agents(): ReferenceAgents {
    const agents = new ReferenceAgents()
    if (this.#misbehaviour !== 'agents_down') return agents
    return new Proxy(agents, { get: (target, property) => (property === 'ask'
      ? async () => {
        const error = new Error('the agents cannot be reached')
        error.name = 'AgentsDown'
        throw error
      }
      : Reflect.get(target, property)) })
  }

  /** The visitor's incidents, newest first. */
  list(session: string): Answer {
    const mine = [...this.#incidents.values()].filter(incident => incident.session === session && incident.expiresAt > this.#now()).sort((a, b) => b.createdAt - a.createdAt)
    return { status: 200, body: mine.map(incident => this.#view(incident)) }
  }

  /** One incident. */
  get(session: string, id: string): Answer {
    const incident = this.#own(session, id)
    return incident ? { status: 200, body: this.#view(incident) } : errorAnswer(404, 'incident_not_found', 'There is no such incident, or it has been deleted.')
  }

  /** A page of events after a number. */
  events(session: string, id: string, search: URLSearchParams): Answer {
    const incident = this.#own(session, id)
    if (!incident) return errorAnswer(404, 'incident_not_found', 'There is no such incident, or it has been deleted.')
    const after = Number.parseInt(search.get('after') ?? '0', 10)
    if (!Number.isInteger(after) || after < 0) return errorAnswer(422, 'invalid_request', 'The query string is not accepted.')
    const following = incident.log.filter(event => event.seq > after)
    const page = following.slice(0, PAGE)
    return { status: 200, body: { events: page, cursor: page.at(-1)?.seq ?? after, more: following.length > PAGE, state: incident.state } }
  }

  /** The decision on the pending proposal. */
  decide(session: string, id: string, proposalId: string, body: unknown): Answer {
    const incident = this.#own(session, id)
    if (!incident) return errorAnswer(404, 'incident_not_found', 'There is no such incident, or it has been deleted.')
    const decision = (body as { decision?: unknown } | null)?.decision
    if (decision !== 'approve' && decision !== 'reject') return errorAnswer(422, 'invalid_request', 'The request is not valid.')
    if (incident.state !== 'awaiting_approval' || !incident.pending || incident.pending.id !== proposalId) return errorAnswer(409, 'proposal_settled', 'This proposal is not waiting for a decision.')
    const pending = incident.pending
    if (decision === 'approve') {
      this.#append(incident, { kind: 'proposal.approved', minute: incident.minute, data: { proposalId } })
      this.#append(incident, { kind: 'remediation.applied', minute: incident.minute, data: { proposalId, action: pending.action } })
      incident.remediations.push({ minute: incident.minute, action: pending.action })
      incident.remediatedAt = incident.minute
      incident.pending = null
      incident.state = 'remediating'
    }
    else {
      this.#append(incident, { kind: 'proposal.rejected', minute: incident.minute, data: { proposalId } })
      incident.pending = null
      if (incident.proposalsMade >= LB06_LIMITS.maxProposals) this.#end(incident, 'aborted', 'proposals_spent')
      else {
        incident.state = 'investigating'
        incident.rerank = true
      }
    }
    return { status: 200, body: this.#view(incident) }
  }

  /** The abort. */
  abort(session: string, id: string): Answer {
    const incident = this.#own(session, id)
    if (!incident) return errorAnswer(404, 'incident_not_found', 'There is no such incident, or it has been deleted.')
    if (incident.ended) return errorAnswer(409, 'incident_ended', 'This incident has ended already.')
    this.#end(incident, 'aborted', 'visitor')
    return { status: 200, body: this.#view(incident) }
  }

  /** The postmortem. */
  postmortem(session: string, id: string): Answer {
    const incident = this.#own(session, id)
    if (!incident) return errorAnswer(404, 'incident_not_found', 'There is no such incident, or it has been deleted.')
    if (incident.state !== 'closed') return errorAnswer(409, 'not_ready', 'The incident has not closed yet, so there is no postmortem.')
    const written = incident.log.find(event => event.kind === 'postmortem.written')
    return { status: 200, body: { incidentId: incident.id, timeline: timelineOf(incident.log), prose: written?.kind === 'postmortem.written' ? written.data.prose : null, modelCalls: incident.modelCalls, proposals: incident.proposalsMade, recoveredMinute: incident.recoveredMinute } }
  }
}

/** The root span's id of an incident, as the real service makes it. */
function rootSpanId(incidentId: string): string {
  return `${incidentId.replace(/-/g, '').slice(0, 16)}`
}
