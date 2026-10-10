// How LB-04's curated contracts are run for a recording. A sample is sent to be reviewed exactly as the
// board sends it (a contract made from the sample's ID), followed by reading the contract's state until
// the review has ended (keeping each read that shows a state not seen before, which is what the board's
// replay plays back as the review's progress), and then read the way the board reads a finished review:
// every page's text, the PDF and the report. A review that found a risky clause is then asked for one
// proposed wording, for the first risk it found, so the replay shows a redline too. A recording holds what
// a visitor's browser would have been told, and the run's trace. A review costs one of the recorder
// visitor's three contracts, two to five model calls, and a redline one more.
//
// The runner refuses what it cannot record honestly: a contract whose review ended any way but the one the
// golden set expects of that sample (a curated sample is recorded once it comes out right, and a bad
// ending is something to look into, not to show), and a redline that could not be made. The two files the
// system must refuse (the 31-page one and the scan) are recorded ending in their refusal, since showing
// the reason is the point of them.
import { exchangeSchema } from '@lb/contracts'
import type { Exchange } from '@lb/contracts'

import { lb04ContractViewSchema, lb04FileViewSchema, lb04PagesViewSchema, lb04RedlineSchema, lb04ReportSchema } from '../../app/boards/lb-04/schemas.ts'
import type { Lb04ContractView, Lb04Report } from '../../app/boards/lb-04/schemas.ts'
import { LB04_SAMPLES } from '../../shared/data/samples/lb04.ts'
import type { Answer, Backend } from './backend.ts'
import type { RecordedRun } from './record.ts'

/** The system's name in the visitor's token and in the paths. */
const SYSTEM = 'lb-04'
const API = '/api/lb04'

// How often the contract is read while it is reviewed, as the board reads it, and how long a review may take
// before the recording is abandoned: the model reads the whole contract in one request, which takes up to a minute.
const READ_EVERY_MS = 1_500
const REVIEW_PATIENCE_MS = 180_000
// A recording holds at most this many exchanges (the recording schema's limit).
const MAX_EXCHANGES = 20

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

/** Says what the back end answered when it was not what the recorder needed: its status and, if it gave one, its error code. */
function describe(answer: Answer): string {
  const code = (answer.body as { error?: { code?: unknown } } | undefined)?.error?.code
  return typeof code === 'string' ? `status ${answer.status}, ${code}` : `status ${answer.status}`
}

/** Fails with what the back end said when it did not answer with a status that was expected. */
function expectStatus(answer: Answer, statuses: readonly number[], what: string): void {
  if (!statuses.includes(answer.status)) throw new Error(`The back end did not ${what} (${describe(answer)}).`)
}

/** Makes the contract from the sample, as the board does when a visitor reviews a sample. */
async function sendSample(tape: Tape, sampleId: string): Promise<Lb04ContractView> {
  const body = { from: 'sample', sampleId }
  const answer = await tape.ask('POST', '/contracts', body)
  expectStatus(answer, [201], 'take the sample')
  tape.keep('POST', '/contracts', body, answer)
  return lb04ContractViewSchema.parse(answer.body)
}

/** Reads the contract until its review has ended, keeping each read that shows a state not seen before, and returns the last view. */
async function followReview(tape: Tape, contract: Lb04ContractView): Promise<Lb04ContractView> {
  const path = `/contracts/${contract.id}`
  const startedAt = tape.clock.now()
  const seen = new Set<string>([contract.state])
  for (;;) {
    if (tape.clock.now() - startedAt > REVIEW_PATIENCE_MS) throw new Error('The review did not end within three minutes.')
    await tape.clock.sleep(READ_EVERY_MS)
    const answer = await tape.ask('GET', path)
    expectStatus(answer, [200], 'show the contract')
    const view = lb04ContractViewSchema.parse(answer.body)
    const over = view.state === 'done' || view.state === 'failed'
    if (over || !seen.has(view.state)) tape.keep('GET', path, undefined, answer)
    seen.add(view.state)
    if (over) return view
  }
}

/** Reads a finished review as the board does, keeping what it reads: the pages' text, the PDF and the report. */
async function readFinished(tape: Tape, contract: Lb04ContractView): Promise<Lb04Report> {
  const base = `/contracts/${contract.id}`
  const pages = await tape.ask('GET', `${base}/pages`)
  expectStatus(pages, [200], 'show the pages')
  lb04PagesViewSchema.parse(pages.body)
  tape.keep('GET', `${base}/pages`, undefined, pages)
  const file = await tape.ask('GET', `${base}/file`)
  expectStatus(file, [200], 'send the PDF')
  lb04FileViewSchema.parse(file.body)
  tape.keep('GET', `${base}/file`, undefined, file)
  const report = await tape.ask('GET', `${base}/report`)
  expectStatus(report, [200], 'show the report')
  tape.keep('GET', `${base}/report`, undefined, report)
  return lb04ReportSchema.parse(report.body)
}

/** Asks for a proposed wording for the report's first risky clause, if it has one, and keeps it. */
async function askRedline(tape: Tape, contract: Lb04ContractView, report: Lb04Report): Promise<void> {
  const first = report.findings.find(finding => finding.kind === 'risk')
  if (!first) return
  const path = `/contracts/${contract.id}/findings/${first.id}/redline`
  const answer = await tape.ask('POST', path)
  expectStatus(answer, [200, 201], 'make the redline')
  lb04RedlineSchema.parse(answer.body)
  tape.keep('POST', path, undefined, answer)
}

/** Lists the IDs the runner knows, for the message that says a sample does not exist. */
function knownIds(): string {
  return LB04_SAMPLES.map(sample => sample.id).join(', ')
}

/** Runs one of LB-04's curated contracts and returns what the board asked and was told, and the review's run ID. */
export async function runLb04Sample(backend: Backend, sampleId: string): Promise<RecordedRun> {
  const sample = LB04_SAMPLES.find(candidate => candidate.id === sampleId)
  if (!sample) throw new Error(`LB-04 has no sample called "${sampleId}". Its samples are: ${knownIds()}.`)
  const tape = new Tape(backend)

  const started = await sendSample(tape, sample.id)
  if (started.runId === '') throw new Error('The back end made the contract without naming its run, so there is no trace to record.')
  const ended = await followReview(tape, started)

  if (sample.outcome === 'refused') {
    if (ended.state !== 'failed' || ended.failure?.code !== sample.refusal) {
      throw new Error(`The sample "${sample.id}" should be refused as ${sample.refusal}, but the review ended ${ended.state === 'failed' ? `as ${ended.failure?.code ?? 'failed'}` : ended.state}. Look at the back end and try again.`)
    }
    return { language: 'en', exchanges: tape.exchanges, runId: started.runId }
  }
  if (ended.state !== 'done') {
    throw new Error(`The sample "${sample.id}" should end with a report, but the review ended as ${ended.failure?.code ?? ended.state}. A curated sample is recorded once it comes out right; look at the back end and try again.`)
  }
  const report = await readFinished(tape, ended)
  await askRedline(tape, ended, report)
  // The review writes a root span when it ends, so its trace is complete when that has arrived, as the default says.
  return { language: 'en', exchanges: tape.exchanges, runId: started.runId }
}
