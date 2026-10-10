// Recordings of LB-05 questions for the tests of the replay player and the board, made by asking the
// question of the in-memory LB-05 mock the way `just record-sample` asks it of a back end: one request
// to the ask route, the answer it got and the run's spans. They are fixtures: their `origin` says
// `mock` unless a test needs the site to treat one as real.
import { Lb05Mock, readLb05Seed } from '@lb/api-clients/testing'
import { recordingSchema, summariseTrace } from '@lb/contracts'
import type { Exchange, Recording, Span } from '@lb/contracts'

import { LB05_ATTACKS, LB05_SAMPLES } from '#shared/data/samples/lb05'

// The moment the mock's day runs on in these fixtures.
const NOW = Date.parse('2026-10-02T09:30:00.000Z')

/** What a test may change about a recording. */
export interface Lb05RecordingOptions {
  origin?: 'live' | 'mock'
  // The ID of a curated question or an attack; the first curated question by default.
  sample?: string
}

/** Finds the question of a curated question or an attack by its ID. */
function questionOf(sample: string): string {
  const found = [...LB05_SAMPLES, ...LB05_ATTACKS].find(candidate => candidate.id === sample)
  if (!found) throw new Error(`LB-05 has no sample called "${sample}".`)
  return found.question
}

/** Records one LB-05 sample: the question asked, its answer and the run's spans. */
export function recordLb05Sample(options: Lb05RecordingOptions = {}): Recording {
  const sample = options.sample ?? LB05_SAMPLES[0].id
  const request = { question: questionOf(sample) }
  const mock = new Lb05Mock(readLb05Seed(), () => NOW)
  const answer = mock.ask('recording', request.question)
  const body = answer.body as { run_id: string }
  const exchanges: Exchange[] = [{ request: { method: 'POST', path: '/api/lb05/ask', body: request }, response: { status: answer.status, body: answer.body as never } }]
  const spans = (mock.spansOf(body.run_id) ?? []) as Span[]
  const summary = summariseTrace(spans)
  return recordingSchema.parse({
    v: 1,
    system: 'lb-05',
    sample,
    origin: options.origin ?? 'mock',
    recordedAt: new Date(NOW).toISOString(),
    language: 'en',
    exchanges,
    trace: { runId: body.run_id, spans },
    stats: { modelCalls: summary.modelCalls, steps: summary.steps, durationMs: summary.durationMs },
  })
}
