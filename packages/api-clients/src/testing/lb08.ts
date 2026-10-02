// LB-08 Automation Studio as the mock back end plays it: a visitor opens a curated sample or
// describes a process, edits the workflow and saves it as a new version, runs it with a test
// payload, watches the retries, the dead-letter list and the replay, and reads what the sandbox
// "sent". The answers have the shapes services/node-systems/openapi.json documents, the
// workflows are checked by the real validator (@lb/contracts), and runs are played by a small
// stand-in for the engine (lb08-engine.ts) that moves one wave each time the site asks for a
// run's events. No model is called: "describing" a process picks the workflow the golden set
// expects for a known description and a small generic one otherwise, and says so in its trace.
import { randomUUID } from 'node:crypto'

import { buildCatalogue, RUN_LIMITS, triggerPayloadSchema, validateWorkflow } from '../../../contracts/src/index.ts'
import type { StartRunRequest, UpdateWorkflowRequest, Values, WorkflowGraph, WorkflowIssue } from '../../../contracts/src/index.ts'

import { Lb08Run, newTraceId, spanIdOf } from './lb08-engine.ts'
import type { DeadLetter, Delivery, EngineEnvironment, Lb08Span } from './lb08-engine.ts'
import { oneLine } from './lb08-seed.ts'
import type { Lb08Seed } from './lb08-seed.ts'
import { errorAnswer } from './lb01.ts'
import type { Answer } from './lb01.ts'

// A visitor's data is kept this long, as the real service keeps it.
const RETENTION_MS = RUN_LIMITS.retentionHours * 3_600_000
const DAY_MS = 86_400_000

/** One saved version of a workflow. */
interface VersionRecord {
  version: number
  origin: 'generated' | 'sample' | 'edited'
  createdAt: number
  modelCalls: number
  traceRunId: string | null
  description: string | null
  graph: WorkflowGraph
}

/** A workflow a visitor keeps, with every version of it. */
interface WorkflowRecord {
  id: string
  session: string
  createdAt: number
  updatedAt: number
  versions: VersionRecord[]
}

/** What describing a process came to. */
type Described = { status: 'accepted', graph: WorkflowGraph } | { status: 'rejected', issues: WorkflowIssue[] }

/** The spans of a described workflow's trace: the pipeline's run, its one model call and the call's attempt. */
function describeSpans(runId: string, startedAt: number): Lb08Span[] {
  const common = { v: 1 as const, runId, system: 'lb-08' as const }
  const generate = spanIdOf(runId, 'generate')
  const call = spanIdOf(runId, 'call')
  const root = spanIdOf(runId, 'describe')
  return [
    { ...common, spanId: spanIdOf(runId, 'attempt'), parentId: call, kind: 'gateway.attempt', name: 'groq/gpt-oss-120b', status: 'ok', startMs: startedAt + 12, endMs: startedAt + 890, attrs: { provider: 'groq', model: 'groq/gpt-oss-120b', inputTokens: 1_850, outputTokens: 420 } },
    { ...common, spanId: call, parentId: generate, kind: 'gateway.call', name: 'lb-tools', status: 'ok', startMs: startedAt + 8, endMs: startedAt + 900, attrs: { alias: 'lb-tools', dataClass: 'visitor', stream: false, attempts: 1, provider: 'groq', model: 'groq/gpt-oss-120b', inputTokens: 1_850, outputTokens: 420, usage: 'reported' } },
    { ...common, spanId: generate, parentId: root, kind: 'system.step', name: 'generate', status: 'ok', startMs: startedAt + 5, endMs: startedAt + 910, attrs: { valid: true, issues: 0 } },
    { ...common, spanId: root, kind: 'system.run', name: 'describe', status: 'ok', startMs: startedAt, endMs: startedAt + 915, attrs: { calls: 1, outcome: 'accepted' } },
  ]
}

/** The mock's LB-08: its workflows, its runs, its sandbox and its daily allowances. */
export class Lb08Mock {
  readonly #seed: Lb08Seed
  readonly #now: () => number
  readonly #workflows = new Map<string, WorkflowRecord>()
  readonly #runs = new Map<string, Lb08Run>()
  readonly #traces = new Map<string, Lb08Span[]>()
  readonly #usage = new Map<string, number>()
  readonly #environment: EngineEnvironment

  /** Starts with no workflows and nothing sent. */
  constructor(seed: Lb08Seed, now: () => number) {
    this.#seed = seed
    this.#now = now
    this.#environment = { now, stock: seed.stock, faults: new Map(), deliveries: new Map(), deadLetters: [] }
  }

  /** Forgets every workflow, run, delivery and allowance. */
  reset(): void {
    this.#workflows.clear()
    this.#runs.clear()
    this.#traces.clear()
    this.#usage.clear()
    this.#environment.faults.clear()
    this.#environment.deliveries.clear()
    this.#environment.deadLetters.length = 0
  }

  /** What a workflow may be made of. */
  catalogue(): Answer {
    return { status: 200, body: buildCatalogue() }
  }

  /** The curated samples, each with the event that starts it and its test payload. */
  samples(): Answer {
    return {
      status: 200,
      body: this.#seed.samples.map((sample) => {
        const trigger = sample.graph.nodes.find(node => node.type === 'trigger')
        return { id: sample.id, title: sample.title, language: sample.language, description: sample.description, event: trigger?.type === 'trigger' ? trigger.event : 'manual', input: sample.input }
      }),
    }
  }

  /** How much of today's allowances a visitor has used. */
  limits(session: string): Answer {
    const allowance = (kind: 'run' | 'generation', limit: number) => {
      const used = this.#used(session, kind)
      return { limit, used, remaining: Math.max(limit - used, 0) }
    }
    return {
      status: 200,
      body: {
        runs: allowance('run', RUN_LIMITS.runsPerVisitorPerDay),
        generations: allowance('generation', RUN_LIMITS.generationsPerVisitorPerDay),
        resetsAt: new Date(this.#midnight() + DAY_MS).toISOString(),
      },
    }
  }

  /** Makes a workflow from a description or a sample: 404 for an unknown sample, 409 past twenty workflows, 429 past the day's ten descriptions, 422 for a process that cannot be built. */
  createWorkflow(session: string, request: { from: 'description', description: string } | { from: 'sample', sampleId: string }): Answer {
    if (request.from === 'sample') {
      const sample = this.#seed.samples.find(candidate => candidate.id === request.sampleId)
      if (!sample) return errorAnswer(404, 'unknown_sample', 'There is no sample with that id.')
      if (this.#own(session).length >= RUN_LIMITS.maxWorkflowsPerVisitor) return this.#roomError()
      return this.#created(this.#add(session, { graph: sample.graph, origin: 'sample', description: null, modelCalls: 0, traceRunId: null }))
    }
    if (this.#own(session).length >= RUN_LIMITS.maxWorkflowsPerVisitor) return this.#roomError()
    if (!this.#reserve(session, 'generation')) return this.#limitError('generation')
    const described = this.#describe(request.description)
    if (described.status === 'rejected') {
      return { status: 422, body: { error: { code: 'workflow_rejected', message: 'That description can\'t be built as a workflow. These are the problems that stopped it.', problems: described.issues } } }
    }
    const traceRunId = newTraceId()
    this.#traces.set(traceRunId, describeSpans(traceRunId, this.#now()))
    return this.#created(this.#add(session, { graph: described.graph, origin: 'generated', description: request.description.trim(), modelCalls: 1, traceRunId }))
  }

  /** The visitor's workflows, newest first. */
  listWorkflows(session: string): Answer {
    return { status: 200, body: this.#own(session).map(workflow => this.#summary(workflow)) }
  }

  /** One of the visitor's workflows, with its latest graph and every version. */
  getWorkflow(session: string, id: string): Answer {
    const workflow = this.#find(session, id)
    return workflow ? { status: 200, body: this.#view(workflow) } : this.#noWorkflow()
  }

  /** Saves an edited graph as the next version: 422 for a graph that fails validation, 409 for a stale edit. */
  saveWorkflow(session: string, id: string, request: UpdateWorkflowRequest): Answer {
    const checked = validateWorkflow(request.graph)
    if (!checked.ok) return { status: 422, body: { error: { code: 'workflow_invalid', message: 'The workflow has problems.', problems: checked.issues } } }
    const workflow = this.#find(session, id)
    if (!workflow) return this.#noWorkflow()
    const latest = this.#latest(workflow)
    if (latest.version !== request.baseVersion) {
      return errorAnswer(409, 'version_conflict', `The workflow is at version ${latest.version}, not ${request.baseVersion}. Load the latest version and edit that.`)
    }
    if (latest.version >= RUN_LIMITS.maxVersionsPerWorkflow) return errorAnswer(409, 'version_limit', `A workflow may have ${RUN_LIMITS.maxVersionsPerWorkflow} versions.`)
    workflow.versions.push({ version: latest.version + 1, origin: 'edited', createdAt: this.#now(), modelCalls: 0, traceRunId: null, description: null, graph: checked.graph })
    workflow.updatedAt = this.#now()
    return { status: 200, body: this.#view(workflow) }
  }

  /** Deletes a workflow with its runs and deliveries. */
  deleteWorkflow(session: string, id: string): Answer {
    const workflow = this.#find(session, id)
    if (!workflow) return this.#noWorkflow()
    this.#workflows.delete(id)
    for (const [runId, run] of this.#runs) {
      if (run.workflowId === id) this.#runs.delete(runId)
    }
    return { status: 204 }
  }

  /** Starts a run with a test payload: 404, 409 for a graph that no longer validates, 422 for a payload or a failure that does not fit, 429 past the day's ten runs. */
  startRun(session: string, workflowId: string, request: StartRunRequest): Answer {
    const workflow = this.#find(session, workflowId)
    if (!workflow) return this.#noWorkflow()
    const version = workflow.versions.find(candidate => candidate.version === (request.version ?? this.#latest(workflow).version))
    if (!version) return this.#noWorkflow()
    const checked = validateWorkflow(version.graph)
    if (!checked.ok) return { status: 409, body: { error: { code: 'workflow_invalid', message: 'This version no longer passes validation. Edit the workflow and save it again.', problems: checked.issues } } }
    const trigger = checked.graph.nodes.find(node => node.type === 'trigger')
    if (trigger?.type !== 'trigger') return this.#noWorkflow()
    const payload = triggerPayloadSchema(trigger.event).safeParse(request.input)
    if (!payload.success) {
      const fields = [...new Set(payload.error.issues.map(issue => issue.path.join('.') || 'input'))].sort().join(', ')
      return { status: 422, body: { error: { code: 'invalid_input', message: `The payload doesn't fit the ${trigger.event} event.`, fields } } }
    }
    const actionIds = new Set(checked.graph.nodes.filter(node => node.type === 'action').map(node => node.id))
    const named = (request.failures ?? []).map(failure => failure.nodeId)
    if (new Set(named).size !== named.length || named.some(nodeId => !actionIds.has(nodeId))) {
      return { status: 422, body: { error: { code: 'invalid_failure', message: 'Failures can only be set once on each action step of this workflow.', fields: 'failures' } } }
    }
    if (!this.#reserve(session, 'run')) return this.#limitError('run')
    const run = this.#newRun(session, workflow, version.version, checked.graph, payload.data, undefined, null)
    for (const failure of request.failures ?? []) this.#environment.faults.set(`${run.rootRunId}:${failure.nodeId}`, failure.times)
    return { status: 202, body: this.#runView(run) }
  }

  /** The visitor's runs, newest first. */
  listRuns(session: string): Answer {
    return { status: 200, body: this.#ownRuns(session).map(run => this.#runSummary(run)) }
  }

  /** One run in full: its payload, its steps and its whole log. */
  getRun(session: string, id: string): Answer {
    const run = this.#findRun(session, id)
    return run ? { status: 200, body: this.#runView(run) } : this.#noRun()
  }

  /** The events of a run after the last one the caller saw. The run moves on one wave first, as it would while the caller waited. */
  runEvents(session: string, id: string, after: number): Answer {
    const run = this.#findRun(session, id)
    if (!run) return this.#noRun()
    run.wave()
    return { status: 200, body: { status: run.status, events: run.eventsAfter(after) } }
  }

  /** Replays a finished run: a new run of the same version and payload in the same chain. */
  replayRun(session: string, id: string): Answer {
    return this.#replay(session, id, undefined)
  }

  /** Answers an approval step that is waiting, once. */
  decide(session: string, runId: string, nodeId: string, decision: 'approved' | 'rejected'): Answer {
    const run = this.#findRun(session, runId)
    if (!run) return this.#noRun()
    const node = run.graph.nodes.find(candidate => candidate.id === nodeId)
    if (node?.type !== 'approval') return errorAnswer(404, 'not_found', 'There is no such approval step in this run.')
    if (!run.decide(nodeId, decision)) return errorAnswer(409, 'not_waiting', 'Only an approval that is waiting can be decided.')
    return { status: 200, body: this.#runView(run) }
  }

  /** What the sandbox "sent" for the visitor, newest first; for one chain when `rootRunId` is given. */
  sent(session: string, rootRunId: string | undefined): Answer {
    const rows = [...this.#environment.deliveries.values()]
      .filter(delivery => delivery.session === session && (rootRunId === undefined || delivery.rootRunId === rootRunId))
      .sort((a, b) => b.sentAt - a.sentAt)
    return { status: 200, body: rows.slice(0, 50).map(delivery => this.#sentView(delivery)) }
  }

  /** The steps that used all their attempts, newest first. */
  deadLetters(session: string): Answer {
    const rows = this.#environment.deadLetters.filter(letter => letter.session === session).sort((a, b) => b.createdAt - a.createdAt)
    return { status: 200, body: rows.slice(0, 50).map(letter => this.#deadLetterView(letter)) }
  }

  /** Replays the run a dead letter came from, once. */
  replayDeadLetter(session: string, id: string): Answer {
    const letter = this.#environment.deadLetters.find(candidate => candidate.id === id && candidate.session === session)
    if (!letter) return errorAnswer(404, 'not_found', 'There is no such dead letter.')
    if (letter.replayedRunId !== null) return errorAnswer(409, 'already_replayed', 'This dead letter was already replayed. Open the run that replayed it.')
    return this.#replay(session, letter.runId, letter)
  }

  /** The spans of a trace so far: a run's steps, or a described workflow's pipeline. Undefined for an ID with no trace. */
  spansOf(runId: string): Lb08Span[] | undefined {
    const generated = this.#traces.get(runId)
    if (generated) return generated
    const spans = this.#runs.get(runId)?.spans
    return spans && spans.length > 0 ? spans : undefined
  }

  // ---- Workflows ----

  /** The visitor's workflows, newest first. */
  #own(session: string): WorkflowRecord[] {
    return [...this.#workflows.values()].filter(workflow => workflow.session === session).reverse()
  }

  /** Finds one of the visitor's workflows: another visitor's is exactly as missing as one that isn't there. */
  #find(session: string, id: string): WorkflowRecord | undefined {
    const workflow = this.#workflows.get(id)
    return workflow?.session === session ? workflow : undefined
  }

  /** The newest version of a workflow. */
  #latest(workflow: WorkflowRecord): VersionRecord {
    const latest = workflow.versions.at(-1)
    if (!latest) throw new Error('A workflow always has a version.')
    return latest
  }

  /** Stores a new workflow with its first version. */
  #add(session: string, first: Omit<VersionRecord, 'version' | 'createdAt'>): WorkflowRecord {
    const now = this.#now()
    const workflow: WorkflowRecord = { id: randomUUID(), session, createdAt: now, updatedAt: now, versions: [{ ...first, version: 1, createdAt: now }] }
    this.#workflows.set(workflow.id, workflow)
    return workflow
  }

  /** Answers a created workflow. */
  #created(workflow: WorkflowRecord): Answer {
    return { status: 201, body: this.#view(workflow) }
  }

  /** Describes a workflow for the list. */
  #summary(workflow: WorkflowRecord): Record<string, unknown> {
    const latest = this.#latest(workflow)
    return {
      id: workflow.id,
      name: latest.graph.name,
      version: latest.version,
      createdAt: new Date(workflow.createdAt).toISOString(),
      updatedAt: new Date(workflow.updatedAt).toISOString(),
      expiresAt: new Date(workflow.createdAt + RETENTION_MS).toISOString(),
    }
  }

  /** Describes a workflow in full. */
  #view(workflow: WorkflowRecord): Record<string, unknown> {
    const latest = this.#latest(workflow)
    return {
      ...this.#summary(workflow),
      description: workflow.versions[0]?.description ?? null,
      graph: latest.graph,
      versions: [...workflow.versions].reverse().map(version => ({
        version: version.version,
        origin: version.origin,
        createdAt: new Date(version.createdAt).toISOString(),
        modelCalls: version.modelCalls,
        traceRunId: version.traceRunId,
      })),
    }
  }

  /** The answer for a workflow that is not the visitor's or is not there. */
  #noWorkflow(): Answer {
    return errorAnswer(404, 'not_found', 'There is no such workflow.')
  }

  /** The answer for a visitor who keeps as many workflows as they may. */
  #roomError(): Answer {
    return errorAnswer(409, 'workflow_limit', `A visitor may keep ${RUN_LIMITS.maxWorkflowsPerVisitor} workflows at once. Delete one to make another.`)
  }

  // ---- Describing ----

  /**
   * Stands in for the model: a description the golden set knows becomes the workflow it expects (or the refusal it
   * expects), a request for a channel that does not exist is refused as unknown, and anything else becomes a small
   * generic workflow, so the whole path from words to a saved version can be driven without a model.
   */
  #describe(description: string): Described {
    const wanted = oneLine(description).toLowerCase()
    const known = this.#seed.golden.find(item => item.description.toLowerCase() === wanted)
    if (known?.graph) return { status: 'accepted', graph: known.graph }
    const attempt = known?.attempt ?? this.#seed.golden.find(item => item.id === 'sms-to-owner')?.attempt
    if (known?.kind === 'reject' || /\b(?:sms|whatsapp|text message)\b/i.test(description)) {
      const checked = validateWorkflow(attempt)
      return { status: 'rejected', issues: checked.ok ? [] : checked.issues }
    }
    return { status: 'accepted', graph: this.#genericWorkflow() }
  }

  /** The workflow the stand-in writes for a description it does not know: a person starts it and the roastery is told. */
  #genericWorkflow(): WorkflowGraph {
    return {
      name: 'Tell the roastery',
      nodes: [
        { id: 'started', type: 'trigger', label: 'Someone starts it', event: 'manual' },
        { id: 'tell_roastery', type: 'action', label: 'Tell the roastery', connector: 'slack_alert', params: { channel: '#roastery', message: 'A workflow was started: {{trigger.note}}.' } },
      ],
      edges: [{ from: 'started', to: 'tell_roastery' }],
    }
  }

  // ---- Allowances ----

  /** Midnight UTC of the mock's day. */
  #midnight(): number {
    return new Date(this.#now()).setUTCHours(0, 0, 0, 0)
  }

  /** How much of today's allowance of one kind a visitor has used. */
  #used(session: string, kind: 'run' | 'generation'): number {
    return this.#usage.get(`${session}:${this.#midnight()}:${kind}`) ?? 0
  }

  /** Takes one place from the visitor's allowance for today, and says whether there was one. */
  #reserve(session: string, kind: 'run' | 'generation'): boolean {
    const limit = kind === 'run' ? RUN_LIMITS.runsPerVisitorPerDay : RUN_LIMITS.generationsPerVisitorPerDay
    const used = this.#used(session, kind)
    if (used >= limit) return false
    this.#usage.set(`${session}:${this.#midnight()}:${kind}`, used + 1)
    return true
  }

  /** The answer for a visitor who has used the day's allowance of one kind. */
  #limitError(kind: 'run' | 'generation'): Answer {
    const message = kind === 'run'
      ? `A visitor may start ${RUN_LIMITS.runsPerVisitorPerDay} workflow runs a day, and a replay counts as one.`
      : `A visitor may describe ${RUN_LIMITS.generationsPerVisitorPerDay} workflows a day.`
    return errorAnswer(429, 'daily_limit', message)
  }

  // ---- Runs ----

  /** Creates a run of a workflow's version and keeps it. */
  #newRun(session: string, workflow: WorkflowRecord, version: number, graph: WorkflowGraph, input: Values, rootRunId: string | undefined, replayOf: string | null): Lb08Run {
    const run = new Lb08Run(this.#environment, { workflowId: workflow.id, workflowName: graph.name, version, graph, session, rootRunId, replayOf, input })
    this.#runs.set(run.id, run)
    return run
  }

  /** Replays a finished run, optionally on behalf of one dead letter. */
  #replay(session: string, runId: string, letter: DeadLetter | undefined): Answer {
    const original = this.#findRun(session, runId)
    if (!original) return this.#noRun()
    if (!original.over) return errorAnswer(409, 'run_not_finished', 'Only a finished run can be replayed.')
    const workflow = this.#find(session, original.workflowId)
    if (!workflow) return this.#noWorkflow()
    if (!this.#reserve(session, 'run')) return this.#limitError('run')
    const run = this.#newRun(session, workflow, original.version, original.graph, original.input, original.rootRunId, original.id)
    const answered = this.#environment.deadLetters.filter(candidate => candidate.runId === original.id && candidate.replayedRunId === null && (letter === undefined || candidate.id === letter.id))
    for (const taken of answered) taken.replayedRunId = run.id
    return { status: 202, body: this.#runView(run) }
  }

  /** The visitor's runs, newest first. */
  #ownRuns(session: string): Lb08Run[] {
    return [...this.#runs.values()].filter(run => run.session === session).reverse()
  }

  /** Finds one of the visitor's runs. */
  #findRun(session: string, id: string): Lb08Run | undefined {
    const run = this.#runs.get(id)
    return run?.session === session ? run : undefined
  }

  /** The answer for a run that is not the visitor's or is not there. */
  #noRun(): Answer {
    return errorAnswer(404, 'not_found', 'There is no such run.')
  }

  /** Describes a run for the list. */
  #runSummary(run: Lb08Run): Record<string, unknown> {
    return {
      id: run.id,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      version: run.version,
      rootRunId: run.rootRunId,
      replayOf: run.replayOf,
      status: run.status,
      createdAt: new Date(run.createdAt).toISOString(),
      finishedAt: run.finishedAt === null ? null : new Date(run.finishedAt).toISOString(),
    }
  }

  /** Describes a run in full: payload, steps and log. */
  #runView(run: Lb08Run): Record<string, unknown> {
    const replay = [...this.#runs.values()].reverse().find(candidate => candidate.replayOf === run.id)
    const time = (moment: number | null) => (moment === null ? null : new Date(moment).toISOString())
    return {
      ...this.#runSummary(run),
      input: run.input,
      replayedBy: replay?.id ?? null,
      steps: run.stepList().map(step => ({
        nodeId: step.nodeId,
        status: step.status,
        attempts: step.attempts,
        output: step.output,
        error: step.error,
        startedAt: time(step.startedAt),
        finishedAt: time(step.finishedAt),
      })),
      events: run.events,
    }
  }

  /** Describes one thing the sandbox sent. */
  #sentView(delivery: Delivery): Record<string, unknown> {
    return { id: delivery.id, connector: delivery.connector, nodeId: delivery.nodeId, rootRunId: delivery.rootRunId, payload: delivery.payload, sentAt: new Date(delivery.sentAt).toISOString() }
  }

  /** Describes one dead letter. */
  #deadLetterView(letter: DeadLetter): Record<string, unknown> {
    return {
      id: letter.id,
      runId: letter.runId,
      workflowId: letter.workflowId,
      nodeId: letter.nodeId,
      attempts: letter.attempts,
      error: { code: letter.code, message: letter.message },
      createdAt: new Date(letter.createdAt).toISOString(),
      replayedRunId: letter.replayedRunId,
    }
  }
}
