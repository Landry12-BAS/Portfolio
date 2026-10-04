// Recordings of LB-04 for the tests of the replay player and the board, made by running a sample through
// the in-memory mock, the way `just record-sample` does against a back end: the contract made, read as its
// review moves on, its pages, its PDF and its report read, a redline asked for, and the review's trace.
// They are fixtures: their `origin` says `mock` unless a test needs the site to treat one as real.
import { Lb04Mock, readLb04Seed } from '@lb/api-clients/testing'
import { recordingSchema, summariseTrace } from '@lb/contracts'
import type { Exchange, Recording, Span } from '@lb/contracts'

// The moment the mock's day runs on in these fixtures.
const NOW = Date.parse('2026-10-02T09:30:00.000Z')

/** What a test may change about a recording. */
export interface RecordingOptions {
  origin?: 'live' | 'mock'
  // The sample's ID; the wholesale supply agreement by default.
  sample?: string
  // Whether to ask for a redline of the report's first risk finding, as the recorder does.
  redline?: boolean
}

/** Records one LB-04 sample: the contract made, read until its review has ended, its pages, file and report read, one redline, and the trace. */
export async function recordLb04Sample(options: RecordingOptions = {}): Promise<Recording> {
  const sample = options.sample ?? 'wholesale-supply'
  const mock = new Lb04Mock(readLb04Seed(), () => NOW)
  const request = { from: 'sample' as const, sampleId: sample }
  const created = mock.create('recording-session-0123', request)
  const view = created.body as { id: string, runId: string }
  const exchanges: Exchange[] = [{ request: { method: 'POST', path: '/api/lb04/contracts', body: request }, response: { status: created.status, body: created.body as never } }]
  const read = async (path: string, answer: { status: number, body?: unknown }): Promise<void> => {
    exchanges.push({ request: { method: 'GET', path }, response: { status: answer.status, ...(answer.body === undefined ? {} : { body: answer.body as never }) } })
  }
  let state = 'queued'
  for (let poll = 0; poll < 8 && state !== 'done' && state !== 'failed'; poll += 1) {
    const answer = await mock.get('recording-session-0123', view.id)
    await read(`/api/lb04/contracts/${view.id}`, answer)
    state = (answer.body as { state: string }).state
  }
  if (state === 'done') {
    await read(`/api/lb04/contracts/${view.id}/pages`, mock.pages('recording-session-0123', view.id))
    await read(`/api/lb04/contracts/${view.id}/file`, mock.file('recording-session-0123', view.id))
    const report = mock.report('recording-session-0123', view.id)
    await read(`/api/lb04/contracts/${view.id}/report`, report)
    const first = (report.body as { findings: { id: string, kind: string }[] }).findings.find(finding => finding.kind === 'risk')
    if (options.redline !== false && first) {
      const path = `/api/lb04/contracts/${view.id}/findings/${first.id}/redline`
      const answer = await mock.redline('recording-session-0123', view.id, first.id)
      exchanges.push({ request: { method: 'POST', path }, response: { status: answer.status, body: answer.body as never } })
    }
  }
  const spans = (mock.spansOf(view.runId) ?? []) as Span[]
  const summary = summariseTrace(spans)
  return recordingSchema.parse({
    v: 1,
    system: 'lb-04',
    sample,
    origin: options.origin ?? 'mock',
    recordedAt: new Date(NOW).toISOString(),
    language: 'en',
    exchanges,
    trace: { runId: view.runId, spans },
    stats: { modelCalls: summary.modelCalls, steps: summary.steps, durationMs: summary.durationMs },
  })
}
