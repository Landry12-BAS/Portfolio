// How LB-01's curated samples are run for a recording: file the sample's ticket as its customer,
// read the ticket as its pipeline moves on until it is finished with, and keep each answer that
// shows a new step, which is what the board's replay hands back, one after another. The ticket is
// filed through the visitor API exactly as the board files it, so the recording holds what a visitor's
// browser would have been told. It costs one ticket and the pipeline's model calls (six or so).
import type { Exchange } from '@lb/contracts'

import { LB01_SAMPLES } from '../../shared/data/samples/lb01.ts'
import { ticketSchema } from '../../app/boards/lb-01/schemas.ts'
import type { Backend } from './backend.ts'
import type { RecordedRun } from './record.ts'

// How often the ticket is read, and how long the pipeline may take before the recording is abandoned.
const READ_EVERY_MS = 1_000
const PIPELINE_PATIENCE_MS = 180_000
// The statuses after which the pipeline has nothing more to do.
const FINISHED = new Set(['awaiting_approval', 'escalated', 'sent'])

/** Runs one of LB-01's samples and returns what the board asked and was told, and the run's ID. */
export async function runLb01Sample(backend: Backend, sampleId: string): Promise<RecordedRun> {
  const sample = LB01_SAMPLES.find(candidate => candidate.id === sampleId)
  if (!sample) throw new Error(`LB-01 has no sample called "${sampleId}". Its samples are: ${LB01_SAMPLES.map(item => item.id).join(', ')}.`)

  const request = { customer: sample.customer, language: sample.language, body: sample.body }
  const filed = await backend.call('lb-01', 'POST', '/api/lb01/tickets', request)
  if (filed.status !== 202) throw new Error(`The back end did not accept the ticket (status ${filed.status}).`)
  const first = ticketSchema.parse(filed.body)
  const exchanges: Exchange[] = [{ request: { method: 'POST', path: '/api/lb01/tickets', body: request }, response: { status: filed.status, body: filed.body as Exchange['response']['body'] } }]

  const path = `/api/lb01/tickets/${first.id}`
  const startedAt = backend.clock.now()
  let status = first.status
  while (!FINISHED.has(status)) {
    if (status === 'failed') throw new Error('The pipeline failed on this ticket, so there is nothing worth recording. Look at the back end\'s logs and try again.')
    if (backend.clock.now() - startedAt > PIPELINE_PATIENCE_MS) throw new Error('The pipeline did not finish within three minutes.')
    await backend.clock.sleep(READ_EVERY_MS)
    const answer = await backend.call('lb-01', 'GET', path)
    if (answer.status !== 200) throw new Error(`Reading the ticket answered status ${answer.status}.`)
    const ticket = ticketSchema.parse(answer.body)
    // Keep an answer only when it shows something new, so a replay has one step for each state of the ticket.
    if (ticket.status !== status) {
      exchanges.push({ request: { method: 'GET', path }, response: { status: answer.status, body: answer.body as Exchange['response']['body'] } })
      status = ticket.status
    }
  }
  return { language: sample.language, exchanges, runId: first.run_id }
}
