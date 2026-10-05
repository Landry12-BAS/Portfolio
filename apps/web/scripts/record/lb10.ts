// How LB-10's prepared edits are run for a recording. A sample is started exactly as the board starts it (its target,
// the prompt its edit makes, and its providers), then read as the board reads it until it has ended, keeping each read
// that shows the run further on (its calls, then its report). A recording holds what a visitor's browser would have
// been told, and the run's trace. A run costs the recorder visitor's one run of the day and its model calls: about ten
// a provider for the edited prompt, and ten more a provider when production's results are not cached yet.
//
// The runner refuses what it cannot record honestly: a run the service refused or failed (a failure is something to
// look into, not to show). What a finished run's report says is the run's own: the runner records it as it is.
import { exchangeSchema } from '@lb/contracts'
import type { Exchange } from '@lb/contracts'

import { runSchema, startedSchema } from '../../app/boards/lb-10/schemas.ts'
import type { Lb10Run } from '../../app/boards/lb-10/schemas.ts'
import { LB10_SAMPLES } from '../../shared/data/samples/lb10.ts'
import type { Answer, Backend } from './backend.ts'
import type { RecordedRun } from './record.ts'

/** The system's name in the visitor's token and in the paths. */
const SYSTEM = 'lb-10'
const API = '/api/lb10'

// How often the run is read while it goes, about as the board reads it, and how long a run may take before the
// recording is abandoned: the service ends every run within its five minutes and a minute more.
const READ_EVERY_MS = 1_000
const RUN_PATIENCE_MS = 7 * 60_000
// A recording holds at most this many exchanges (the recording schema's limit); the start and the last read always fit.
const MAX_EXCHANGES = 20
// A read of a running run is kept, besides the first and the last, when this many more calls have ended since the last one kept.
const CALLS_PER_READ = 4

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

  /** Tells whether a read of a running run can still be kept, leaving room for the read that ends it. */
  get hasRoom(): boolean {
    return this.exchanges.length < MAX_EXCHANGES - 1
  }
}

/** Fails with what the back end said when it did not answer with the status that was expected. */
function expectStatus(answer: Answer, status: number, what: string): void {
  if (answer.status !== status) throw new Error(`The back end did not ${what} (status ${answer.status}).`)
}

/** Starts the sample as the visitor's run, as the board does. */
async function startRun(tape: Tape, body: { target: string, prompt: string, providers: string[] }): Promise<Lb10Run> {
  const answer = await tape.ask('POST', '/runs', body)
  expectStatus(answer, 202, 'start the run')
  tape.keep('POST', '/runs', body, answer)
  return startedSchema.parse(answer.body).run
}

/** Follows the run until it has ended, keeping the reads that show it further on. Returns the run as it ended. */
async function followRun(tape: Tape, started: Lb10Run): Promise<Lb10Run> {
  const path = `/runs/${started.run_id}`
  const since = tape.clock.now()
  let kept = started
  for (;;) {
    if (tape.clock.now() - since > RUN_PATIENCE_MS) throw new Error('The run did not end within seven minutes.')
    await tape.clock.sleep(READ_EVERY_MS)
    const answer = await tape.ask('GET', path)
    expectStatus(answer, 200, 'show the run')
    const view = runSchema.parse(answer.body)
    const ended = view.state !== 'running'
    const moved = view.calls_done - kept.calls_done >= CALLS_PER_READ || (kept.calls_done === 0 && view.calls_done > 0)
    if (ended || (tape.hasRoom && moved)) {
      tape.keep('GET', path, undefined, answer)
      kept = view
    }
    if (ended) return view
  }
}

/** Runs one of LB-10's prepared edits and returns what the board asked and was told, and the run's ID. */
export async function runLb10Sample(backend: Backend, sampleId: string): Promise<RecordedRun> {
  const sample = LB10_SAMPLES.find(candidate => candidate.id === sampleId)
  if (!sample) throw new Error(`LB-10 has no sample called "${sampleId}". Its samples are: ${LB10_SAMPLES.map(item => item.id).join(', ')}.`)
  const tape = new Tape(backend)
  const started = await startRun(tape, { target: sample.pack, prompt: sample.prompt, providers: [...sample.providers] })
  const ended = await followRun(tape, started)
  if (ended.state !== 'done' || ended.report === null) throw new Error(`The run ended as ${ended.state} (${ended.failure ?? 'no reason'}), so it is not a recording worth showing.`)
  // The run writes its root span when it ends, so its trace is complete when that has arrived, as the default says.
  return { language: 'en', exchanges: tape.exchanges, runId: ended.run_id }
}
