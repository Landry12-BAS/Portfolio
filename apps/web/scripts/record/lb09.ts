// How LB-09's curated meetings are run for a recording: the sample is started through the visitor
// API exactly as the board starts it (fast mode, since the recording is what the board shows first
// and private mode needs the weights on the box), the meeting is read every second until the worker
// is done, keeping each answer that shows a new state so a replay has one step for each stage, and
// then its transcript and its items are read. The board follows a live meeting over the WebSocket,
// but a recording holds requests and answers only, so the replay shows the stages from the reads.
// The runner refuses what it cannot record honestly: a meeting that failed (a curated meeting should
// be looked into, not shown failing), one that names no run (so there is no trace to replay), and one
// whose decisions and actions are not the ones its card promises (a run that lost its items to the
// evidence check, or found others, is a run to look into, not a demo). It
// costs one of the visitor's recordings, the sample's seconds of speech-to-text and two or three model
// calls.
import type { Exchange } from '@lb/contracts'

import { itemsSchema, meetingSchema, transcriptSchema } from '../../app/boards/lb-09/schemas.ts'
import type { Items } from '../../app/boards/lb-09/schemas.ts'
import { LB09_SAMPLES } from '../../shared/data/samples/lb09.ts'
import type { MeetingSample } from '../../shared/data/samples/lb09-types.ts'
import type { Backend } from './backend.ts'
import type { RecordedRun } from './record.ts'

/** The path meetings are started at. */
const MEETINGS_PATH = '/api/lb09/meetings'
/** How often the meeting is read while the worker works. */
const READ_EVERY_MS = 1_000
/** How long the worker may take: it gives up on a meeting itself at three minutes. */
const MEETING_PATIENCE_MS = 240_000

/** Fails unless the meeting found as many decisions and actions as the sample's card promises. */
function requirePromisedItems(sample: MeetingSample, found: Items): void {
  const decisions = found.items.filter(item => item.kind === 'decision').length
  const actions = found.items.length - decisions
  if (decisions === sample.decisions && actions === sample.actions) return
  throw new Error(`The meeting came out with ${decisions} decisions and ${actions} actions (${found.dropped} dropped by the checks), where its card promises ${sample.decisions} and ${sample.actions}, so it is not a recording worth showing. Look at the extraction and try again.`)
}

/** Keeps one request and its answer as the board would have seen them. */
function exchangeOf(method: 'GET' | 'POST', path: string, body: unknown, answer: { status: number, body?: unknown }): Exchange {
  const request: Exchange['request'] = { method, path }
  if (body !== undefined) request.body = body as Exchange['request']['body']
  return { request, response: { status: answer.status, body: answer.body as Exchange['response']['body'] } }
}

/** Runs one of LB-09's curated meetings and returns what the board asked and was told, and the run's ID. */
export async function runLb09Sample(backend: Backend, sampleId: string): Promise<RecordedRun> {
  const sample = LB09_SAMPLES.find(candidate => candidate.id === sampleId)
  if (!sample) throw new Error(`LB-09 has no sample called "${sampleId}". Its samples are: ${LB09_SAMPLES.map(item => item.id).join(', ')}.`)

  const request = { source: 'sample', sample: sample.id, mode: 'fast', language: sample.language }
  const started = await backend.call('lb-09', 'POST', MEETINGS_PATH, request)
  if (started.status !== 202) throw new Error(`The back end did not take the meeting (status ${started.status}).`)
  const first = meetingSchema.parse(started.body)
  const exchanges: Exchange[] = [exchangeOf('POST', MEETINGS_PATH, request, started)]

  const path = `${MEETINGS_PATH}/${first.id}`
  const startedAt = backend.clock.now()
  let last = `${first.status}/${first.stage}`
  let meeting = first
  while (meeting.status !== 'done' && meeting.status !== 'failed') {
    if (backend.clock.now() - startedAt > MEETING_PATIENCE_MS) throw new Error('The worker did not finish the meeting within four minutes.')
    await backend.clock.sleep(READ_EVERY_MS)
    const answer = await backend.call('lb-09', 'GET', path)
    if (answer.status !== 200) throw new Error(`Reading the meeting answered status ${answer.status}.`)
    meeting = meetingSchema.parse(answer.body)
    // Keep an answer only when it shows something new, so a replay has one step for each state of the meeting.
    const state = `${meeting.status}/${meeting.stage}`
    if (state !== last) {
      exchanges.push(exchangeOf('GET', path, undefined, answer))
      last = state
    }
  }
  if (meeting.status === 'failed') throw new Error(`The meeting failed (${meeting.failure ?? 'no reason given'}), so there is nothing worth recording. Look at the worker's logs and try again.`)
  if (meeting.run_id === '') throw new Error('The back end finished the meeting without naming its run, so there is no trace to record.')

  const transcript = await backend.call('lb-09', 'GET', `${path}/transcript`)
  if (transcript.status !== 200) throw new Error(`Reading the transcript answered status ${transcript.status}.`)
  transcriptSchema.parse(transcript.body)
  exchanges.push(exchangeOf('GET', `${path}/transcript`, undefined, transcript))

  const items = await backend.call('lb-09', 'GET', `${path}/items`)
  if (items.status !== 200) throw new Error(`Reading the items answered status ${items.status}.`)
  requirePromisedItems(sample, itemsSchema.parse(items.body))
  exchanges.push(exchangeOf('GET', `${path}/items`, undefined, items))

  return { language: sample.language, exchanges, runId: meeting.run_id }
}
