// A small stand-in for LB-08's workflow engine, for the mock back end: it runs a workflow graph
// with the real engine's rules and writes the real engine's events, in the real order, so the
// site's run view, its retries, its dead-letter list, its replay and its "sent once" proof can be
// driven end to end without Postgres, Redis or a worker. The rules are the ones in
// services/node-systems/src/modules/lb08/engine (flow.ts, settle.ts, steps.ts, sandbox.ts):
// a step starts when every edge into it has an answer and one is live; a skipped branch ripples
// down; a connector that is down is retried with a doubling wait and then dead-lettered; a write
// goes out under the key `<root run>:<step>` and a second delivery under it is recognised and
// not repeated.
//
// It does not run on its own. A run moves one wave when `wave()` is called (the mock calls it each
// time the site asks for the run's events, as LB-01's mock moves a ticket on as it is polled), so a
// test controls time. Nothing here measures anything: the spans it writes have made-up timings.
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { evaluateCondition, parseReference, renderTemplate, SANDBOX_EMAIL } from '../../../contracts/src/index.ts'
import type { ActionNode, BranchLabel, ConnectorId, NewRunEvent, RunEvent, RunStatus, Scalar, StepStatus, Values, WorkflowGraph, WorkflowNode } from '../../../contracts/src/index.ts'

import type { StockSeed } from './lb08-seed.ts'

// The sandbox's mailbox domain for team addresses, as the real engine writes it.
const TEAM_MAILBOX_DOMAIN = 'basalt-bean.test'
// Attempts a step gets, and the wait before the first retry, as the real engine's defaults.
export const MAX_ATTEMPTS = 3
export const BACKOFF_MS = 1_000
// Days from an order to its arrival when the product is on the shelf.
const DISPATCH_DAYS = 2

/** One delivery the sandbox recorded: what a write connector "sent", under its idempotency key. */
export interface Delivery {
  id: string
  key: string
  session: string
  rootRunId: string
  nodeId: string
  connector: ConnectorId
  payload: Values
  messageId: string
  // The run that sent it first.
  firstRunId: string
  sentAt: number
}

/** A step that used all its attempts. */
export interface DeadLetter {
  id: string
  session: string
  runId: string
  workflowId: string
  nodeId: string
  attempts: number
  code: string
  message: string
  createdAt: number
  replayedRunId: string | null
}

/** One span of a mock run, in the format the Scope route returns. */
export interface Lb08Span {
  v: 1
  runId: string
  system: 'lb-08'
  spanId: string
  parentId?: string
  kind: 'system.run' | 'system.step' | 'system.tool' | 'gateway.call' | 'gateway.attempt'
  name: string
  status: 'ok' | 'error' | 'skipped'
  startMs: number
  endMs: number
  attrs: Record<string, string | number | boolean>
}

/** What the engine shares with the mock that owns it: the clock, the stock list, the failures asked for and the sandbox's table. */
export interface EngineEnvironment {
  now: () => number
  stock: readonly StockSeed[]
  // Failures still to come, by `<root run>:<step>`: how many more times that step's connector fails.
  faults: Map<string, number>
  // The sandbox's deliveries, by idempotency key.
  deliveries: Map<string, Delivery>
  deadLetters: DeadLetter[]
}

/** Where one step stands. */
export interface StepState {
  nodeId: string
  status: StepStatus
  attempts: number
  output: Values | null
  error: { code: string, message: string } | null
  startedAt: number | null
  finishedAt: number | null
  // Which way a condition or an approval went.
  branch: BranchLabel | null
}

/** Why a step failed, and whether another attempt could help. */
class StepProblem extends Error {
  readonly code: string
  readonly retryable: boolean

  /** Names the failure by its stable code. */
  constructor(code: string, message: string, retryable: boolean) {
    super(message)
    this.name = 'StepProblem'
    this.code = code
    this.retryable = retryable
  }
}

/** What a run is made of. */
export interface RunSetup {
  workflowId: string
  workflowName: string
  version: number
  graph: WorkflowGraph
  session: string
  rootRunId: string | undefined
  replayOf: string | null
  input: Values
}

/** Reads a rendered quantity as kilograms: a number above zero and within bounds, or the step fails for good. */
function quantityOf(text: string): number {
  const kilograms = Number(text)
  if (!Number.isFinite(kilograms) || kilograms <= 0 || kilograms > 100_000) {
    throw new StepProblem('invalid_quantity', 'The quantity isn\'t a number of kilograms above zero.', false)
  }
  return kilograms
}

/** Makes a span ID of 16 hex digits that is the same for the same run and key. */
export function spanIdOf(runId: string, key: string): string {
  return createHash('sha256').update(`${runId}:${key}`).digest('hex').slice(0, 16)
}

/** Says how long the queue waits after a step's `attempt`-th try fails: the base wait, doubled for each try already made. */
export function retryDelayMs(attempt: number): number {
  return BACKOFF_MS * 2 ** (attempt - 1)
}

/** The mock's run: its steps, its log, its spans and the rules that move it on. */
export class Lb08Run {
  readonly id = randomUUID()
  readonly workflowId: string
  readonly workflowName: string
  readonly version: number
  readonly graph: WorkflowGraph
  readonly session: string
  readonly rootRunId: string
  readonly replayOf: string | null
  readonly input: Values
  readonly createdAt: number
  readonly steps = new Map<string, StepState>()
  readonly events: RunEvent[] = []
  readonly spans: Lb08Span[] = []
  status: RunStatus = 'queued'
  finishedAt: number | null = null
  readonly #env: EngineEnvironment
  #startedLogged = false
  #spanCount = 0

  /** Creates the run: its trigger done with the payload as its output, and the steps after it settled. */
  constructor(env: EngineEnvironment, setup: RunSetup) {
    this.#env = env
    this.workflowId = setup.workflowId
    this.workflowName = setup.workflowName
    this.version = setup.version
    this.graph = setup.graph
    this.session = setup.session
    this.rootRunId = setup.rootRunId ?? this.id
    this.replayOf = setup.replayOf
    this.input = setup.input
    this.createdAt = env.now()
    const trigger = setup.graph.nodes.find(node => node.type === 'trigger')
    for (const node of setup.graph.nodes) {
      const isTrigger = node.id === trigger?.id
      this.steps.set(node.id, {
        nodeId: node.id,
        status: isTrigger ? 'succeeded' : 'pending',
        attempts: 0,
        output: isTrigger ? setup.input : null,
        error: null,
        startedAt: isTrigger ? this.createdAt : null,
        finishedAt: isTrigger ? this.createdAt : null,
        branch: null,
      })
    }
    this.#emit({ type: 'run.queued', version: setup.version, replayOf: setup.replayOf })
    if (trigger) this.#emit({ type: 'step.succeeded', nodeId: trigger.id, attempt: 0, output: setup.input })
    this.#settle()
  }

  /** Tells whether the run has finished. */
  get over(): boolean {
    return this.status === 'succeeded' || this.status === 'failed'
  }

  /** Moves the run on by one wave: the steps started last time are resolved, then the steps that are ready are started. */
  wave(): void {
    if (this.over) return
    for (const node of this.graph.nodes) {
      if (node.type === 'action' && this.#step(node.id).status === 'running') this.#resolve(node)
    }
    for (const node of this.graph.nodes) {
      const status = this.#step(node.id).status
      if (node.type === 'action' && (status === 'ready' || status === 'queued')) this.#start(node)
    }
    this.#syncStatus()
  }

  /** Records a person's answer to an approval step and carries the run on down the branch chosen. Returns false when nothing waits there. */
  decide(nodeId: string, decision: 'approved' | 'rejected'): boolean {
    const step = this.steps.get(nodeId)
    const node = this.graph.nodes.find(candidate => candidate.id === nodeId)
    if (!step || node?.type !== 'approval' || step.status !== 'awaiting_approval' || this.over) return false
    const output: Values = { ...step.output, branch: decision }
    step.status = 'succeeded'
    step.output = output
    step.branch = decision
    step.finishedAt = this.#env.now()
    this.#emit({ type: 'step.decided', nodeId, decision })
    this.#emit({ type: 'step.succeeded', nodeId, attempt: 0, output })
    this.#settle()
    return true
  }

  /** The run's steps in the graph's order. */
  stepList(): StepState[] {
    return this.graph.nodes.map(node => this.#step(node.id))
  }

  /** The events after a sequence number. */
  eventsAfter(after: number): RunEvent[] {
    return this.events.filter(event => event.seq > after)
  }

  /** Reads one step's state; every node of the graph has one. */
  #step(nodeId: string): StepState {
    const step = this.steps.get(nodeId)
    if (!step) throw new Error('A node of the graph has no step.')
    return step
  }

  /** Adds an event to the log, numbered, timed and labelled with the run. */
  #emit(event: NewRunEvent): void {
    this.events.push({ ...event, seq: this.events.length + 1, at: new Date(this.#env.now()).toISOString(), runId: this.id } as RunEvent)
  }

  /** Writes the span of one attempt of a step. Timings are made up: each attempt is placed after the last. */
  #span(node: ActionNode, attempt: number, status: 'ok' | 'error', outcome: string | undefined): void {
    const startMs = this.createdAt + this.#spanCount * 40
    this.#spanCount += 1
    this.spans.push({
      v: 1,
      runId: this.id,
      system: 'lb-08',
      spanId: spanIdOf(this.id, `${node.id}.${attempt}`),
      kind: 'system.step',
      name: `step.${node.id}`,
      status,
      startMs,
      endMs: startMs + 25,
      attrs: { connector: node.connector, attempt, ...(outcome === undefined ? {} : { outcome }) },
    })
  }

  /** Claims a step for a worker: counts the attempt and logs that it started. */
  #start(node: ActionNode): void {
    const step = this.#step(node.id)
    step.status = 'running'
    step.attempts += 1
    step.startedAt ??= this.#env.now()
    this.#logRunStarted()
    this.#emit({ type: 'step.started', nodeId: node.id, attempt: step.attempts })
  }

  /** Logs the start of the run, once, the first time a worker begins on it. */
  #logRunStarted(): void {
    if (this.#startedLogged) return
    this.#startedLogged = true
    this.#emit({ type: 'run.started' })
  }

  /** Calls the step's connector and records how the attempt ended. */
  #resolve(node: ActionNode): void {
    const step = this.#step(node.id)
    const attempt = step.attempts
    try {
      const result = this.#callConnector(node)
      if (result.delivery) {
        const effect = { nodeId: node.id, connector: node.connector, messageId: result.delivery.messageId }
        this.#emit(result.created
          ? { type: 'effect.sent', ...effect }
          : { type: 'effect.duplicate_suppressed', ...effect, originalRunId: result.delivery.firstRunId })
      }
      step.status = 'succeeded'
      step.output = result.output
      step.error = null
      step.finishedAt = this.#env.now()
      this.#emit({ type: 'step.succeeded', nodeId: node.id, attempt, output: result.output })
      this.#span(node, attempt, 'ok', result.delivery === null ? 'read' : result.created ? 'sent' : 'duplicate_suppressed')
    }
    catch (error) {
      if (!(error instanceof StepProblem)) throw error
      this.#fail(node, attempt, error)
      this.#span(node, attempt, 'error', undefined)
    }
    this.#settle()
  }

  /** Records a failed attempt: a retry is scheduled while attempts are left, otherwise the step fails, and a retryable one is dead-lettered. */
  #fail(node: ActionNode, attempt: number, problem: StepProblem): void {
    const step = this.#step(node.id)
    step.error = { code: problem.code, message: problem.message }
    const failure = { nodeId: node.id, attempt, maxAttempts: MAX_ATTEMPTS, code: problem.code, message: problem.message }
    if (problem.retryable && attempt < MAX_ATTEMPTS) {
      step.status = 'queued'
      this.#emit({ type: 'step.failed', ...failure, retryInMs: retryDelayMs(attempt) })
      return
    }
    step.status = 'failed'
    step.finishedAt = this.#env.now()
    this.#emit({ type: 'step.failed', ...failure, retryInMs: null })
    if (!problem.retryable) return
    this.#env.deadLetters.push({
      id: randomUUID(),
      session: this.session,
      runId: this.id,
      workflowId: this.workflowId,
      nodeId: node.id,
      attempts: attempt,
      code: problem.code,
      message: problem.message,
      createdAt: this.#env.now(),
      replayedRunId: null,
    })
    this.#emit({ type: 'step.dead_lettered', nodeId: node.id, attempts: attempt })
  }

  // ---- The connectors ----

  /** Looks up the value a reference names, in the payload or in the output of a step that has succeeded. */
  #lookup(reference: string): Scalar | undefined {
    const parsed = parseReference(reference)
    if (!parsed) return undefined
    const source = parsed.source === 'trigger' ? this.input : this.steps.get(parsed.source)?.output ?? undefined
    return source !== undefined && Object.hasOwn(source, parsed.field) ? source[parsed.field] : undefined
  }

  /** Fills in a text's placeholders; a placeholder with no value fails the step for good. */
  #render(template: string): string {
    const { text, missing } = renderTemplate(template, reference => this.#lookup(reference))
    if (missing.length > 0) throw new StepProblem('missing_value', 'A value this step needs isn\'t available.', false)
    return text
  }

  /** Works out the address an email goes to: the customer's, from the payload, or a team mailbox. */
  #recipient(to: string): string {
    if (to !== 'customer') return `${to}@${TEAM_MAILBOX_DOMAIN}`
    const address = this.#lookup('trigger.contactEmail')
    if (typeof address !== 'string' || !SANDBOX_EMAIL.test(address)) throw new StepProblem('no_recipient', 'The payload has no sandbox address to send to.', false)
    return address
  }

  /** Turns an action step's settings into what its connector is asked to do, every text filled in. */
  #request(node: ActionNode): Values {
    switch (node.connector) {
      case 'stock_check': {
        const payload: Values = { sku: this.#render(node.params.sku) }
        if (node.params.quantityKg !== undefined) payload.quantityKg = quantityOf(this.#render(node.params.quantityKg))
        return payload
      }
      case 'slack_alert':
        return { channel: node.params.channel, message: this.#render(node.params.message) }
      case 'email':
        return { to: this.#recipient(node.params.to), subject: this.#render(node.params.subject), body: this.#render(node.params.body) }
      case 'webhook': {
        const payload: Values = { endpoint: node.params.endpoint, event: node.params.event }
        for (const [name, template] of Object.entries(node.params.fields)) payload[`field.${name}`] = this.#render(template)
        return payload
      }
      case 'create_task':
        return { board: node.params.board, title: this.#render(node.params.title), priority: node.params.priority ?? 'normal' }
    }
  }

  /** Fails the call if the visitor asked for this step's connector to fail, using up one of the failures asked for. */
  #failIfAsked(nodeId: string): void {
    const key = `${this.rootRunId}:${nodeId}`
    const remaining = this.#env.faults.get(key) ?? 0
    if (remaining <= 0) return
    this.#env.faults.set(key, remaining - 1)
    throw new StepProblem('connector_unavailable', 'The connector is unavailable.', true)
  }

  /** Looks a product up in the stock list and works out whether the stock covers the quantity, and when it could arrive. */
  #checkStock(request: Values): Values {
    const product = this.#env.stock.find(candidate => candidate.sku === String(request.sku))
    if (!product) throw new StepProblem('unknown_product', 'That product isn\'t in the stock list.', false)
    const wanted = typeof request.quantityKg === 'number' ? request.quantityKg : undefined
    const inStock = wanted === undefined ? product.availableKg > 0 : product.availableKg >= wanted
    return { inStock, availableKg: product.availableKg, etaDays: inStock ? DISPATCH_DAYS : product.restockEtaDays + DISPATCH_DAYS, productName: product.name }
  }

  /** Delivers under the step's idempotency key, or finds the delivery already recorded under it. */
  #deliver(node: ActionNode, request: Values): { delivery: Delivery, created: boolean } {
    const key = `${this.rootRunId}:${node.id}`
    const known = this.#env.deliveries.get(key)
    if (known) return { delivery: known, created: false }
    const id = randomUUID()
    const delivery: Delivery = {
      id,
      key,
      session: this.session,
      rootRunId: this.rootRunId,
      nodeId: node.id,
      connector: node.connector,
      payload: request,
      messageId: `${node.connector === 'create_task' ? 'task' : 'msg'}-${id.slice(0, 8)}`,
      firstRunId: this.id,
      sentAt: this.#env.now(),
    }
    this.#env.deliveries.set(key, delivery)
    return { delivery, created: true }
  }

  /** Runs one connector call: a read answers from the stock list, a write goes out once under its key. */
  #callConnector(node: ActionNode): { output: Values, delivery: Delivery | null, created: boolean } {
    const request = this.#request(node)
    this.#failIfAsked(node.id)
    if (node.connector === 'stock_check') return { output: this.#checkStock(request), delivery: null, created: false }
    const { delivery, created } = this.#deliver(node, request)
    return { output: node.connector === 'create_task' ? { taskId: delivery.messageId } : { messageId: delivery.messageId }, delivery, created }
  }

  // ---- The flow ----

  /** Says whether any step of the run has failed. */
  #hasFailed(): boolean {
    return [...this.steps.values()].some(step => step.status === 'failed')
  }

  /** Reads one edge: still open, live, or dead, from the state of the step it starts at. */
  #verdict(edge: WorkflowGraph['edges'][number]): 'open' | 'live' | 'dead' {
    const source = this.steps.get(edge.from)
    if (!source) return 'open'
    if (source.status === 'skipped') return 'dead'
    if (source.status !== 'succeeded') return 'open'
    return edge.branch === undefined || edge.branch === source.branch ? 'live' : 'dead'
  }

  /** Finds the pending step that can be settled now: ready to start, or never to run. */
  #nextSettled(): { node: WorkflowNode, verdict: 'ready' | 'branch_not_taken' | 'upstream_skipped' } | undefined {
    for (const node of this.graph.nodes) {
      if (this.#step(node.id).status !== 'pending') continue
      const edges = this.graph.edges.filter(edge => edge.to === node.id)
      const verdicts = edges.map(edge => this.#verdict(edge))
      if (verdicts.includes('open')) continue
      if (verdicts.includes('live')) return { node, verdict: 'ready' }
      const passedOver = edges.some(edge => this.steps.get(edge.from)?.status === 'succeeded')
      return { node, verdict: passedOver ? 'branch_not_taken' : 'upstream_skipped' }
    }
    return undefined
  }

  /** Starts a step that has what it needs: a condition runs now, an approval waits, an action is left for a worker. */
  #startReady(node: WorkflowNode): void {
    const step = this.#step(node.id)
    const now = this.#env.now()
    if (node.type === 'condition') {
      const actual = this.#lookup(node.field)
      if (actual === undefined) {
        this.#failInline(node.id, 'missing_value', 'A value this step needs isn\'t available.')
        return
      }
      const branch: BranchLabel = evaluateCondition(node.op, actual, node.value) ? 'true' : 'false'
      step.status = 'succeeded'
      step.output = { checked: actual, branch }
      step.branch = branch
      step.startedAt = now
      step.finishedAt = now
      this.#emit({ type: 'step.succeeded', nodeId: node.id, attempt: 0, output: step.output })
    }
    else if (node.type === 'approval') {
      step.status = 'awaiting_approval'
      step.output = { question: this.#renderQuestion(node.message) }
      step.startedAt = now
      this.#emit({ type: 'step.awaiting_approval', nodeId: node.id, approver: node.approver })
    }
    else if (node.type === 'action') {
      step.status = 'ready'
    }
  }

  /** Fills in an approval's question, or says it could not be written. */
  #renderQuestion(template: string): string {
    return renderTemplate(template, reference => this.#lookup(reference)).text
  }

  /** Fails a step that never needed a worker, for good. */
  #failInline(nodeId: string, code: string, message: string): void {
    const step = this.#step(nodeId)
    const now = this.#env.now()
    step.status = 'failed'
    step.error = { code, message }
    step.startedAt = now
    step.finishedAt = now
    this.#emit({ type: 'step.failed', nodeId, attempt: 1, maxAttempts: 1, code, message, retryInMs: null })
  }

  /** Decides what happens next, repeatedly, until nothing more settles; nothing starts after a step has failed. */
  #settle(): void {
    while (!this.#hasFailed()) {
      const next = this.#nextSettled()
      if (!next) break
      if (next.verdict === 'ready') {
        this.#startReady(next.node)
        continue
      }
      const step = this.#step(next.node.id)
      step.status = 'skipped'
      step.finishedAt = this.#env.now()
      this.#emit({ type: 'step.skipped', nodeId: next.node.id, reason: next.verdict })
    }
    this.#syncStatus()
  }

  /** Brings the run's own status up to date with its steps, and logs each change. */
  #syncStatus(): void {
    const statuses = [...this.steps.values()].map(step => step.status)
    const inFlight = statuses.some(status => status === 'ready' || status === 'queued' || status === 'running')
    let status: RunStatus
    if (statuses.includes('failed')) status = inFlight ? 'running' : 'failed'
    else if (statuses.every(candidate => candidate === 'succeeded' || candidate === 'skipped')) status = 'succeeded'
    else if (inFlight) status = this.#startedLogged ? 'running' : 'queued'
    else if (statuses.includes('awaiting_approval')) status = 'awaiting_approval'
    else status = 'running'
    if (status === this.status) return
    if (status !== 'queued') this.#logRunStarted()
    this.status = status
    if (status === 'awaiting_approval') this.#emit({ type: 'run.awaiting_approval', nodeId: this.#firstWith('awaiting_approval') })
    if (status === 'succeeded') this.#emit({ type: 'run.succeeded' })
    if (status === 'failed') this.#emit({ type: 'run.failed', nodeId: this.#firstWith('failed') })
    if (status === 'succeeded' || status === 'failed') this.finishedAt = this.#env.now()
  }

  /** Returns the id of the first step, in the graph's order, that is in the given state. */
  #firstWith(status: StepStatus): string {
    return this.graph.nodes.find(node => this.#step(node.id).status === status)?.id ?? ''
  }
}

/** Makes a run ID in the form the gateway's trace route accepts, for a trace that has no run of this engine behind it. */
export function newTraceId(): string {
  return `run-${randomBytes(10).toString('hex')}`
}
