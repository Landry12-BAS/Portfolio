// How LB-08's curated samples are run for a recording. A sample is opened as the visitor's workflow
// (the board's first call), run with its own test order, and followed through the run's log until
// the run is over, answering the approval if it asks one. Some samples are recorded with a step made
// to fail on purpose, since a failure is what the demo is for: one retry that then works, a step that
// uses all its attempts and goes to the dead-letter queue, and the replay of that dead letter, which
// sends nothing twice. Every call is made through the visitor API exactly as the board makes it, and
// what comes back is kept as the board's replay will hand it back, so the recording holds what a
// visitor's browser would have been told. A run costs the visitor's runs (one, or two with a replay)
// and no model call, since a sample's workflow is written by hand.
import { exchangeSchema } from '@lb/contracts'
import type { ConnectorId, Exchange, Values } from '@lb/contracts'

import { deadLetterListSchema, runEventsPageSchema, runViewSchema, sentListSchema, workflowViewSchema } from '../../app/boards/lb-08/schemas.ts'
import type { DeadLetterView, RunView, WorkflowView } from '../../app/boards/lb-08/schemas.ts'
import { LB08_SAMPLES } from '../../shared/data/samples/lb08.ts'
import type { Answer, Backend } from './backend.ts'
import type { RecordedRun } from './record.ts'

/** The system's name in the visitor's token and in the paths. */
const SYSTEM = 'lb-08'
const API = '/api/lb08'

// How often the run's log is read, and how long a run may take before the recording is abandoned.
const READ_EVERY_MS = 1_000
const RUN_PATIENCE_MS = 120_000
// A recording holds at most this many exchanges (the recording schema's limit).
const MAX_EXCHANGES = 20
// A read of the log is kept when it holds an event that changes what the board shows in a way worth a pause, or when this many events have piled up.
const KEEP_AFTER_EVENTS = 6
const MILESTONES = new Set(['run.awaiting_approval', 'run.succeeded', 'run.failed', 'step.failed', 'step.dead_lettered', 'step.decided'])

/** What a sample's recording shows beyond a plain run. */
interface Scenario {
  // The connector whose first step is made to fail, and how many times.
  failing?: { connector: ConnectorId, times: number }
  // What the person an approval asks answers.
  decision: 'approved' | 'rejected'
  // Whether to replay the dead letter the run leaves, if it leaves one.
  replayDeadLetter: boolean
}

// One scenario for each sample. A sample not listed here is recorded as a plain run.
const SCENARIOS: Readonly<Record<string, Scenario>> = {
  'wholesale-order': { failing: { connector: 'slack_alert', times: 1 }, decision: 'approved', replayDeadLetter: false },
  'low-stock-reorder': { failing: { connector: 'slack_alert', times: 3 }, decision: 'approved', replayDeadLetter: true },
  'refund-approval': { decision: 'approved', replayDeadLetter: false },
}
const PLAIN: Scenario = { decision: 'approved', replayDeadLetter: false }

/** The exchanges kept so far, and the calls that keep them. */
class Tape {
  readonly exchanges: Exchange[] = []
  readonly #backend: Backend

  /** Starts a tape for one back end. */
  constructor(backend: Backend) {
    this.#backend = backend
  }

  /** The recorder's clock. */
  get clock(): Backend['clock'] {
    return this.#backend.clock
  }

  /** Calls the API as the board does and returns the answer, without keeping it. */
  ask(method: 'GET' | 'POST', path: string, body?: unknown, query: readonly (readonly [string, string])[] = []): Promise<Answer> {
    return this.#backend.call(SYSTEM, method, `${API}${path}`, body, { query })
  }

  /** Keeps a call and its answer, checked as the recording will check it. A recorded path has no query string. */
  keep(method: 'GET' | 'POST', path: string, body: unknown, answer: Answer): void {
    if (this.exchanges.length >= MAX_EXCHANGES) throw new Error(`This sample takes more than ${MAX_EXCHANGES} exchanges to play, which is all a recording holds. Record a shorter scenario.`)
    this.exchanges.push(exchangeSchema.parse({
      request: { method, path: `${API}${path}`, ...(body === undefined ? {} : { body }) },
      response: { status: answer.status, ...(answer.body === undefined ? {} : { body: answer.body }) },
    }))
  }
}

/** Fails with what the back end said when it did not answer with the status that was expected. */
function expectStatus(answer: Answer, status: number, what: string): void {
  if (answer.status !== status) throw new Error(`The back end did not ${what} (status ${answer.status}).`)
}

/** Opens the sample as the visitor's workflow. */
async function openSample(tape: Tape, sampleId: string): Promise<WorkflowView> {
  const body = { from: 'sample', sampleId }
  const answer = await tape.ask('POST', '/workflows', body)
  expectStatus(answer, 201, 'open the sample')
  tape.keep('POST', '/workflows', body, answer)
  return workflowViewSchema.parse(answer.body)
}

/** Finds the step to make fail: the first step of the connector the scenario names. */
function failuresFor(workflow: WorkflowView, scenario: Scenario): { nodeId: string, times: number }[] {
  if (!scenario.failing) return []
  const { connector, times } = scenario.failing
  const step = workflow.graph.nodes.find(node => node.type === 'action' && node.connector === connector)
  if (!step) throw new Error(`The sample has no ${connector} step to make fail.`)
  return [{ nodeId: step.id, times }]
}

/** Starts the run with the sample's own test order. */
async function startRun(tape: Tape, workflow: WorkflowView, input: Values, failures: { nodeId: string, times: number }[]): Promise<RunView> {
  const path = `/workflows/${workflow.id}/runs`
  const body = failures.length > 0 ? { input, failures } : { input }
  const answer = await tape.ask('POST', path, body)
  expectStatus(answer, 202, 'accept the run')
  tape.keep('POST', path, body, answer)
  return runViewSchema.parse(answer.body)
}

/** Tells whether a page of the log holds something worth keeping on its own. */
function worthKeeping(events: readonly { type: string }[], over: boolean): boolean {
  return over || events.length >= KEEP_AFTER_EVENTS || events.some(event => MILESTONES.has(event.type))
}

/** Answers the approval a run is waiting for, after reading the run as the board does to learn the question. */
async function answerApproval(tape: Tape, run: RunView, decision: 'approved' | 'rejected'): Promise<void> {
  const view = await tape.ask('GET', `/runs/${run.id}`)
  expectStatus(view, 200, 'show the run')
  tape.keep('GET', `/runs/${run.id}`, undefined, view)
  const waiting = runViewSchema.parse(view.body).steps.find(step => step.status === 'awaiting_approval')
  if (!waiting) return
  const path = `/runs/${run.id}/steps/${waiting.nodeId}/decision`
  const body = { decision }
  const answer = await tape.ask('POST', path, body)
  expectStatus(answer, 200, 'take the answer to the approval')
  tape.keep('POST', path, body, answer)
}

/** Follows a run through its log until it is over, keeping the reads that show something new, and returns the run's last status. */
async function followRun(tape: Tape, run: RunView, scenario: Scenario): Promise<string> {
  const path = `/runs/${run.id}/events`
  const startedAt = tape.clock.now()
  let kept = run.events.at(-1)?.seq ?? 0
  let status: string = run.status
  let answered = false
  while (status !== 'succeeded' && status !== 'failed') {
    if (tape.clock.now() - startedAt > RUN_PATIENCE_MS) throw new Error('The run did not finish within two minutes.')
    await tape.clock.sleep(READ_EVERY_MS)
    const answer = await tape.ask('GET', path, undefined, [['after', String(kept)]])
    expectStatus(answer, 200, 'show the run\'s log')
    const page = runEventsPageSchema.parse(answer.body)
    status = page.status
    const over = status === 'succeeded' || status === 'failed'
    if (page.events.length > 0 && worthKeeping(page.events, over)) {
      tape.keep('GET', path, undefined, answer)
      kept = page.events.at(-1)?.seq ?? kept
    }
    if (status === 'awaiting_approval' && !answered) {
      answered = true
      await answerApproval(tape, run, scenario.decision)
    }
  }
  return status
}

/** Reads what a finished run left, as the board does: the whole run, what the sandbox sent for its chain, and the dead letters. */
async function readEffects(tape: Tape, run: RunView): Promise<{ deadLetters: DeadLetterView[] }> {
  const view = await tape.ask('GET', `/runs/${run.id}`)
  expectStatus(view, 200, 'show the finished run')
  tape.keep('GET', `/runs/${run.id}`, undefined, view)
  const sent = await tape.ask('GET', '/sent', undefined, [['rootRunId', run.rootRunId]])
  expectStatus(sent, 200, 'list what was sent')
  sentListSchema.parse(sent.body)
  tape.keep('GET', '/sent', undefined, sent)
  const letters = await tape.ask('GET', '/dead-letters')
  expectStatus(letters, 200, 'list the dead letters')
  tape.keep('GET', '/dead-letters', undefined, letters)
  return { deadLetters: deadLetterListSchema.parse(letters.body) }
}

/** Replays a dead letter, which starts a new run of the same chain. */
async function replayDeadLetter(tape: Tape, id: string): Promise<RunView> {
  const path = `/dead-letters/${id}/replay`
  const answer = await tape.ask('POST', path)
  expectStatus(answer, 202, 'replay the dead letter')
  tape.keep('POST', path, undefined, answer)
  return runViewSchema.parse(answer.body)
}

/** Runs one of LB-08's samples and returns what the board asked and was told, and the first run's ID. */
export async function runLb08Sample(backend: Backend, sampleId: string): Promise<RecordedRun> {
  const sample = LB08_SAMPLES.find(candidate => candidate.id === sampleId)
  if (!sample) throw new Error(`LB-08 has no sample called "${sampleId}". Its samples are: ${LB08_SAMPLES.map(item => item.id).join(', ')}.`)
  const scenario = SCENARIOS[sample.id] ?? PLAIN
  const tape = new Tape(backend)

  const workflow = await openSample(tape, sample.id)
  const run = await startRun(tape, workflow, sample.input, failuresFor(workflow, scenario))
  await followRun(tape, run, scenario)
  const left = await readEffects(tape, run)

  const letter = left.deadLetters.find(candidate => candidate.runId === run.id && candidate.replayedRunId === null)
  if (scenario.replayDeadLetter && letter) {
    const replayed = await replayDeadLetter(tape, letter.id)
    await followRun(tape, replayed, scenario)
    await readEffects(tape, replayed)
  }
  // A workflow run's steps are spans of their own with no span around them, so its trace is complete when it has stopped growing.
  return { language: sample.language, exchanges: tape.exchanges, runId: run.id, traceEnds: 'quiet' }
}
