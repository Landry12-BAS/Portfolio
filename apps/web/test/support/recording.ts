// Recordings for the tests of the replay player and the boards, made by running a sample through
// the in-memory LB-01 mock, the way `just record-sample` does against a back end. They are
// fixtures: their `origin` says `mock` unless a test needs the site to treat one as real.
import { Lb01Mock, readSeed } from '@lb/api-clients/testing'
import { recordingSchema, summariseTrace } from '@lb/contracts'
import type { Exchange, Recording, Span } from '@lb/contracts'

import { LB01_SAMPLES } from '#shared/data/samples/lb01'

// The moment the mock's day runs on in these fixtures.
const NOW = Date.parse('2026-10-02T09:30:00.000Z')

/** What a test may change about a recording. */
export interface RecordingOptions {
  origin?: 'live' | 'mock'
  // The sample's ID in LB-01's samples; the first one by default.
  sample?: string
}

/** Records one LB-01 sample: the ticket filed, read twice as the pipeline moves on, and the run's spans. */
export function recordLb01Sample(options: RecordingOptions = {}): Recording {
  const sample = LB01_SAMPLES.find(candidate => candidate.id === (options.sample ?? LB01_SAMPLES[0].id)) ?? LB01_SAMPLES[0]
  const mock = new Lb01Mock(readSeed(), () => NOW)
  const request = { customer: sample.customer, language: sample.language, body: sample.body }
  const filed = mock.file('recording', request)
  const ticket = filed.body as { id: string }
  const exchanges: Exchange[] = [{ request: { method: 'POST', path: '/api/lb01/tickets', body: request }, response: { status: filed.status, body: filed.body as never } }]
  // Like the real API, the mock names the run only once the pipeline has finished, so the run's ID is the last answer's.
  let runId = ''
  for (let reads = 0; reads < 2; reads += 1) {
    const answer = mock.get('recording', ticket.id)
    runId = (answer.body as { run_id: string }).run_id
    exchanges.push({ request: { method: 'GET', path: `/api/lb01/tickets/${ticket.id}` }, response: { status: answer.status, body: answer.body as never } })
  }
  const spans = (mock.spansOf(runId) ?? []) as Span[]
  const summary = summariseTrace(spans)
  return recordingSchema.parse({
    v: 1,
    system: 'lb-01',
    sample: sample.id,
    origin: options.origin ?? 'mock',
    recordedAt: new Date(NOW).toISOString(),
    language: sample.language,
    exchanges,
    trace: { runId, spans },
    stats: { modelCalls: summary.modelCalls, steps: summary.steps, durationMs: summary.durationMs },
  })
}
