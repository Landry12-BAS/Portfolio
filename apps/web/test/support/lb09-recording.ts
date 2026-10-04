// A recording of one of LB-09's curated meetings, made on the mock back end the way the recorder
// script makes one on the live service (scripts/record/lb09.ts): the meeting as it was taken, each
// state it moved through, its transcript and its items, and the run's spans. It is test data, not a
// measurement: nothing here was transcribed.
import { Lb09Mock, readLb09Seed } from '@lb/api-clients/testing'
import { recordingSchema, summariseTrace } from '@lb/contracts'
import type { Exchange, Recording, Span } from '@lb/contracts'

import { LB09_SAMPLES } from '#shared/data/samples/lb09'

const NOW = Date.parse('2026-10-02T09:30:00.000Z')
const MEETINGS_PATH = '/api/lb09/meetings'

/** What a test may change about a recording. */
export interface Lb09RecordingOptions {
  origin?: 'live' | 'mock'
  // The ID of a curated meeting; the first by default.
  sample?: string
  mode?: 'fast' | 'private'
}

/** Keeps one request and its answer as the board would have seen them. */
function exchangeOf(method: 'GET' | 'POST', path: string, body: unknown, answer: { status: number, body?: unknown }): Exchange {
  const request: Exchange['request'] = { method, path }
  if (body !== undefined) request.body = body as Exchange['request']['body']
  return { request, response: { status: answer.status, body: answer.body as never } }
}

/** Records one LB-09 sample: the meeting started, its states, its transcript and items, and the run's spans. */
export function recordLb09Sample(options: Lb09RecordingOptions = {}): Recording {
  const sample = options.sample ?? LB09_SAMPLES[0].id
  if (!LB09_SAMPLES.some(candidate => candidate.id === sample)) throw new Error(`LB-09 has no sample called "${sample}".`)
  let clock = NOW
  const stageMs = 700
  const mock = new Lb09Mock(readLb09Seed(), { now: () => clock, verify: () => 'recording', stageMs })
  const request = { source: 'sample', sample, mode: options.mode ?? 'fast', language: 'en' }
  const started = mock.start('recording', request as Parameters<Lb09Mock['start']>[1])
  const meeting = started.body as { id: string, run_id: string }
  const path = `${MEETINGS_PATH}/${meeting.id}`
  const exchanges: Exchange[] = [exchangeOf('POST', MEETINGS_PATH, request, started)]
  let last = ''
  // Read the meeting once in each stage, keeping the reads that show a new state, as the recorder script does.
  for (let step = 1; step <= 8; step += 1) {
    clock = NOW + step * stageMs + 10
    const answer = mock.get('recording', meeting.id)
    const view = answer.body as { status: string, stage: string }
    const state = `${view.status}/${view.stage}`
    if (state !== last) {
      exchanges.push(exchangeOf('GET', path, undefined, answer))
      last = state
    }
  }
  exchanges.push(exchangeOf('GET', `${path}/transcript`, undefined, mock.transcript('recording', meeting.id)))
  exchanges.push(exchangeOf('GET', `${path}/items`, undefined, mock.items('recording', meeting.id)))
  const spans = (mock.spansOf(meeting.run_id) ?? []) as Span[]
  const summary = summariseTrace(spans)
  return recordingSchema.parse({
    v: 1,
    system: 'lb-09',
    sample,
    origin: options.origin ?? 'mock',
    recordedAt: new Date(NOW).toISOString(),
    language: 'en',
    exchanges,
    trace: { runId: meeting.run_id, spans },
    stats: { modelCalls: summary.modelCalls, steps: summary.steps, durationMs: summary.durationMs },
  })
}
