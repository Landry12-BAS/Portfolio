// How LB-07's curated test runs are run for a recording. A sample is started exactly as the board starts it
// (a run made from the sample's ID), followed by reading the run until it has ended (keeping each read that
// shows a new state, and a few that show the steps moving on, which is what the board's replay plays back as
// the run's progress), and then read the way the board reads a finished run: the report, the generated test
// and the evidence (the screenshots the findings name, then the two pieces the run keeps at its end). A
// recording holds what a visitor's browser would have been told, and the run's trace. A run costs one of the
// recorder visitor's two runs a day and two to eight model calls.
//
// The runner refuses what it cannot record honestly: a run that failed, and one whose verdict is not the one
// the golden set expects of the sample (a curated run is recorded once it comes out right; a bad ending is
// something to look into, not to show).
import { exchangeSchema } from '@lb/contracts'
import type { Exchange } from '@lb/contracts'

import { evidenceRefs } from '../../app/boards/lb-07/run.ts'
import { lb07EvidenceViewSchema, lb07ReportSchema, lb07RunViewSchema, lb07TestViewSchema } from '../../app/boards/lb-07/schemas.ts'
import type { Lb07Report, Lb07RunView } from '../../app/boards/lb-07/schemas.ts'
import { LB07_SAMPLES } from '../../shared/data/samples/lb07.ts'
import type { Answer, Backend } from './backend.ts'
import type { RecordedRun } from './record.ts'

/** The system's name in the visitor's token and in the paths. */
const SYSTEM = 'lb-07'
const API = '/api/lb07'

// How often the run is read while it goes, about as the board reads it, and how long a run may take before
// the recording is abandoned: a queue of runs ahead, three minutes of browser time and the model's calls.
const READ_EVERY_MS = 600
const RUN_PATIENCE_MS = 15 * 60_000
// A recording holds at most this many exchanges (the recording schema's limit).
const MAX_EXCHANGES = 20
// What a finished run is read for: its report, its test and at most five pieces of evidence. Reads of the run's progress leave room for them.
const RESERVED_FOR_THE_END = 7
// The changes of state still to come once a run is running (the second engine, the reports, the clean shop, the end), which always get a read of their own.
const STATES_TO_COME = 4
// A read of a running run is kept, besides the reads that show a new state, when this many more steps have finished since the last one kept.
const STEPS_PER_READ = 3

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
  ask(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer> {
    return this.#backend.call(SYSTEM, method, `${API}${path}`, body)
  }

  /** Keeps a call and its answer, checked as the recording will check it. */
  keep(method: 'GET' | 'POST', path: string, body: unknown, answer: Answer): void {
    if (this.exchanges.length >= MAX_EXCHANGES) throw new Error(`This sample takes more than ${MAX_EXCHANGES} exchanges to play, which is all a recording holds.`)
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

/** How many of a run's steps have finished, one way or another. */
function settledSteps(view: Lb07RunView): number {
  return view.steps.filter(step => step.status !== 'running' && step.status !== 'pending').length
}

/** Starts the sample as the visitor's run. */
async function startRun(tape: Tape, sampleId: string): Promise<Lb07RunView> {
  const body = { from: 'sample', sampleId }
  const answer = await tape.ask('POST', '/runs', body)
  expectStatus(answer, 201, 'start the run')
  tape.keep('POST', '/runs', body, answer)
  return lb07RunViewSchema.parse(answer.body)
}

/** Follows the run until it has ended, keeping the reads that show a new state, and some that show its steps moving on. Returns the run as it ended. */
async function followRun(tape: Tape, started: Lb07RunView): Promise<Lb07RunView> {
  const path = `/runs/${started.id}`
  const since = tape.clock.now()
  let kept = started
  for (;;) {
    if (tape.clock.now() - since > RUN_PATIENCE_MS) throw new Error('The run did not end within fifteen minutes.')
    await tape.clock.sleep(READ_EVERY_MS)
    const answer = await tape.ask('GET', path)
    expectStatus(answer, 200, 'show the run')
    const view = lb07RunViewSchema.parse(answer.body)
    const newState = view.state !== kept.state
    const room = tape.exchanges.length < MAX_EXCHANGES - RESERVED_FOR_THE_END - STATES_TO_COME
    const moved = settledSteps(view) - settledSteps(kept) >= STEPS_PER_READ
    if (newState || (room && moved)) {
      tape.keep('GET', path, undefined, answer)
      kept = view
    }
    if (view.state === 'done' || view.state === 'failed') return view
  }
}

/** Reads what a finished run leaves, as the board reads it: the report, the test and the evidence. */
async function readOutcome(tape: Tape, id: string): Promise<Lb07Report> {
  const report = await tape.ask('GET', `/runs/${id}/report`)
  expectStatus(report, 200, 'show the report')
  const parsed = lb07ReportSchema.parse(report.body)
  tape.keep('GET', `/runs/${id}/report`, undefined, report)
  const test = await tape.ask('GET', `/runs/${id}/test`)
  expectStatus(test, 200, 'show the generated test')
  lb07TestViewSchema.parse(test.body)
  tape.keep('GET', `/runs/${id}/test`, undefined, test)
  const { named, closing } = evidenceRefs(parsed)
  for (const ref of named) {
    const piece = await tape.ask('GET', `/runs/${id}/evidence/${ref.id}`)
    expectStatus(piece, 200, `show the evidence ${ref.id}`)
    lb07EvidenceViewSchema.parse(piece.body)
    tape.keep('GET', `/runs/${id}/evidence/${ref.id}`, undefined, piece)
  }
  for (const evidenceId of closing) {
    const piece = await tape.ask('GET', `/runs/${id}/evidence/${evidenceId}`)
    if (piece.status === 404) break
    expectStatus(piece, 200, `show the evidence ${evidenceId}`)
    lb07EvidenceViewSchema.parse(piece.body)
    tape.keep('GET', `/runs/${id}/evidence/${evidenceId}`, undefined, piece)
  }
  return parsed
}

/** Runs one of LB-07's samples and returns what the board asked and was told, and the run's ID. */
export async function runLb07Sample(backend: Backend, sampleId: string): Promise<RecordedRun> {
  const sample = LB07_SAMPLES.find(candidate => candidate.id === sampleId)
  if (!sample) throw new Error(`LB-07 has no sample called "${sampleId}". Its samples are: ${LB07_SAMPLES.map(item => item.id).join(', ')}.`)
  const tape = new Tape(backend)
  const started = await startRun(tape, sample.id)
  const ended = await followRun(tape, started)
  if (ended.state !== 'done') throw new Error(`The run ended as ${ended.state} (${ended.failure?.code ?? 'no reason'}), so it is not a recording worth showing.`)
  const report = await readOutcome(tape, ended.id)
  if (report.verification.verdict !== sample.verdict) throw new Error(`The run's verdict is ${report.verification.verdict}, where the golden set expects ${sample.verdict} of this sample, so it is not a recording worth showing.`)
  // The run writes a root span when it ends, so its trace is complete when that has arrived, as the default says.
  return { language: 'en', exchanges: tape.exchanges, runId: ended.runId }
}
