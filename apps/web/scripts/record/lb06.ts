// How LB-06's curated samples are run for a recording. A sample is started as the visitor's incident
// (the board's first call), followed through the log's pages until the commander proposes a fix,
// approved as the visitor would, and followed again until the shop has recovered and the postmortem is
// written. Every call is made through the visitor API exactly as the board makes it, and what comes
// back is kept as the board's replay will hand it back, so the recording holds what a visitor's
// browser would have been told. Only the reads that show something worth a pause are kept: a page of
// the log holds everything since the last page kept, so the replay is a few steps, not a hundred.
// An incident costs the visitor's one incident of the day and, on a live back end, about ten model
// calls (none when the same incident has run before).
import { exchangeSchema } from '@lb/contracts'
import type { Exchange } from '@lb/contracts'
import { lb06EventsPageSchema, lb06IncidentViewSchema, lb06PostmortemViewSchema } from '../../app/boards/lb-06/schemas.ts'
import type { Lb06IncidentView } from '../../app/boards/lb-06/schemas.ts'
import { LB06_SAMPLES } from '../../shared/data/samples/lb06.ts'
import type { Answer, Backend } from './backend.ts'
import type { RecordedRun } from './record.ts'

/** The system's name in the visitor's token and in the paths. */
const SYSTEM = 'lb-06'
const API = '/api/lb06'

// How often the log is read, and how long an incident may take before the recording is abandoned.
const READ_EVERY_MS = 400
const INCIDENT_PATIENCE_MS = 10 * 60_000
// A recording holds at most this many exchanges (the recording schema's limit).
const MAX_EXCHANGES = 20
// A read of the log is kept when it holds an event that changes what the board shows in a way worth a pause, or when this many events have piled up.
const KEEP_AFTER_EVENTS = 14
const MILESTONES = new Set(['fault.injected', 'alert.fired', 'investigation.started', 'hypotheses.ranked', 'proposal.made', 'remediation.applied', 'slo.recovered', 'postmortem.written', 'incident.closed', 'incident.aborted', 'incident.failed'])
// Once this many exchanges are kept, only reads with a milestone are kept, so the closing exchanges always fit.
const RESERVED_FOR_THE_END = 5

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

/** Starts the sample as the visitor's incident. */
async function startIncident(tape: Tape, sampleId: string): Promise<Lb06IncidentView> {
  const body = { from: 'sample', sampleId }
  const answer = await tape.ask('POST', '/incidents', body)
  expectStatus(answer, 201, 'start the incident')
  tape.keep('POST', '/incidents', body, answer)
  return lb06IncidentViewSchema.parse(answer.body)
}

/** Tells whether a page of the log holds something worth keeping on its own. */
function worthKeeping(tape: Tape, kinds: readonly string[]): boolean {
  const milestone = kinds.some(kind => MILESTONES.has(kind))
  const room = tape.exchanges.length < MAX_EXCHANGES - RESERVED_FOR_THE_END
  return milestone || (room && kinds.length >= KEEP_AFTER_EVENTS)
}

/** Reads the incident's view, keeps the read, and returns it. */
async function readView(tape: Tape, id: string): Promise<Lb06IncidentView> {
  const answer = await tape.ask('GET', `/incidents/${id}`)
  expectStatus(answer, 200, 'show the incident')
  tape.keep('GET', `/incidents/${id}`, undefined, answer)
  return lb06IncidentViewSchema.parse(answer.body)
}

/** Approves the proposal that waits, after reading the incident as the board does to learn what it is. */
async function approveProposal(tape: Tape, id: string): Promise<void> {
  const view = await readView(tape, id)
  const proposal = view.pendingProposal
  if (!proposal) return
  const path = `/incidents/${id}/proposals/${proposal.id}/decision`
  const body = { decision: 'approve' }
  const answer = await tape.ask('POST', path, body)
  expectStatus(answer, 200, 'take the approval')
  tape.keep('POST', path, body, answer)
}

/** Follows the incident through its log until it is over, keeping the reads that show something new, and approves the proposal when it comes. Returns the incident's last state. */
async function followIncident(tape: Tape, incident: Lb06IncidentView): Promise<string> {
  const path = `/incidents/${incident.id}/events`
  const startedAt = tape.clock.now()
  let kept = 0
  let state: string = incident.state
  let answered = false
  while (state !== 'closed' && state !== 'aborted' && state !== 'failed') {
    if (tape.clock.now() - startedAt > INCIDENT_PATIENCE_MS) throw new Error('The incident did not end within ten minutes.')
    await tape.clock.sleep(READ_EVERY_MS)
    const answer = await tape.ask('GET', path, undefined, [['after', String(kept)]])
    expectStatus(answer, 200, 'show the incident\'s log')
    const page = lb06EventsPageSchema.parse(answer.body)
    state = page.state
    const kinds = page.events.map(event => event.kind)
    if (page.events.length > 0 && (worthKeeping(tape, kinds) || state === 'closed')) {
      tape.keep('GET', path, undefined, answer)
      kept = page.events.at(-1)?.seq ?? kept
    }
    if (state === 'awaiting_approval' && !answered && kinds.includes('proposal.made')) {
      answered = true
      await approveProposal(tape, incident.id)
    }
  }
  return state
}

/** Reads what a closed incident leaves: its view and its postmortem. */
async function readOutcome(tape: Tape, id: string): Promise<void> {
  await readView(tape, id)
  const answer = await tape.ask('GET', `/incidents/${id}/postmortem`)
  expectStatus(answer, 200, 'show the postmortem')
  lb06PostmortemViewSchema.parse(answer.body)
  tape.keep('GET', `/incidents/${id}/postmortem`, undefined, answer)
}

/** Runs one of LB-06's samples and returns what the board asked and was told, and the incident's run ID. */
export async function runLb06Sample(backend: Backend, sampleId: string): Promise<RecordedRun> {
  const sample = LB06_SAMPLES.find(candidate => candidate.id === sampleId)
  if (!sample) throw new Error(`LB-06 has no sample called "${sampleId}". Its samples are: ${LB06_SAMPLES.map(item => item.id).join(', ')}.`)
  const tape = new Tape(backend)
  const incident = await startIncident(tape, sample.id)
  const state = await followIncident(tape, incident)
  if (state !== 'closed') throw new Error(`The incident ended as ${state}, not closed, so it is not a recording worth showing.`)
  await readOutcome(tape, incident.id)
  // The incident writes a root span when it ends, so its trace is complete when that has arrived, as the default says.
  return { language: 'en', exchanges: tape.exchanges, runId: incident.runId }
}
