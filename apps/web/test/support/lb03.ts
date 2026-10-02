// Documents and recordings for the tests of LB-03's board, made by sending a sample's file to the in-memory
// LB-03 mock, the way `just record-sample` sends it to a back end: the upload, the reads that follow it as
// the document moves through its states, and the run's spans. The documents come out checked with the
// board's own schema, so what a test shows is shaped as the real API's answers are. They are fixtures: a
// recording's `origin` says `mock` unless a test needs the site to treat one as real.
import { Lb03Mock, readLb03Seed } from '@lb/api-clients/testing'
import { recordingSchema, summariseTrace } from '@lb/contracts'
import type { Exchange, Recording, Span } from '@lb/contracts'

import { LB03_SAMPLES } from '#shared/data/samples/lb03'

import { documentSchema } from '~/boards/lb-03/schemas'
import type { DocumentState, InvoiceDocument } from '~/boards/lb-03/schemas'

// The moment the mock's day runs on in these fixtures.
const NOW = Date.parse('2026-10-02T09:30:00.000Z')

const seed = readLb03Seed()

/** Finds a curated sample by its name, or stops the test that asked for one there is not. */
function sampleOf(name: string): (typeof LB03_SAMPLES)[number] {
  const found = LB03_SAMPLES.find(candidate => candidate.id === name)
  if (found === undefined) throw new Error(`LB-03 has no sample called "${name}".`)
  return found
}

/** What a test may ask of a document. */
export interface DocumentOptions {
  // The sample whose file is sent; the first one (the clean PDF) by default.
  sample?: string
  // The state to read the document up to: its end by default.
  until?: DocumentState
}

/** Sends a sample's file to a fresh mock and reads the document until it reaches a state, as a visitor's polling would. */
export function makeDocument(options: DocumentOptions = {}): InvoiceDocument {
  const sample = sampleOf(options.sample ?? LB03_SAMPLES[0].id)
  const mock = new Lb03Mock(seed, () => NOW)
  const taken = mock.upload('documents', { filename: sample.file, data: seed.file(`documents/${sample.file}`) })
  let document = documentSchema.parse(taken.body)
  for (let reads = 0; reads < 12; reads += 1) {
    const reached = options.until === undefined ? document.state === 'ready' || document.state === 'failed' : document.state === options.until
    if (reached) break
    document = documentSchema.parse(mock.get('documents', document.id).body)
  }
  return document
}

/** Reads a sample to its end and then corrects fields of it, as a visitor would, so a check can be made to fail on purpose. */
export function makeCorrected(sample: string, corrections: readonly (readonly [path: string, value: string])[]): InvoiceDocument {
  const chosen = sampleOf(sample)
  const mock = new Lb03Mock(seed, () => NOW)
  const taken = mock.upload('corrected', { filename: chosen.file, data: seed.file(`documents/${chosen.file}`) })
  let document = documentSchema.parse(taken.body)
  for (let reads = 0; reads < 12 && document.state !== 'ready' && document.state !== 'failed'; reads += 1) {
    document = documentSchema.parse(mock.get('corrected', document.id).body)
  }
  for (const [path, value] of corrections) {
    document = documentSchema.parse(mock.correct('corrected', document.id, { path, value }).body)
  }
  return document
}

/** What a test may change about a recording. */
export interface Lb03RecordingOptions {
  origin?: 'live' | 'mock'
  // The sample's name; the first one by default.
  sample?: string
}

/** Records one LB-03 sample: the file sent, then each answer that shows a new state, and the run's spans. */
export function recordLb03Sample(options: Lb03RecordingOptions = {}): Recording {
  const sample = sampleOf(options.sample ?? LB03_SAMPLES[0].id)
  const mock = new Lb03Mock(seed, () => NOW)
  const taken = mock.upload('recording', { filename: sample.file, data: seed.file(`documents/${sample.file}`) })
  const first = documentSchema.parse(taken.body)
  const exchanges: Exchange[] = [{ request: { method: 'POST', path: '/api/lb03/documents', body: { file: sample.file } }, response: { status: taken.status, body: taken.body as never } }]
  let state = first.state
  let runId = first.run_id
  for (let reads = 0; reads < 12 && state !== 'ready' && state !== 'failed'; reads += 1) {
    const answer = mock.get('recording', first.id)
    const read = documentSchema.parse(answer.body)
    runId = read.run_id ?? runId
    if (read.state !== state) {
      exchanges.push({ request: { method: 'GET', path: `/api/lb03/documents/${first.id}` }, response: { status: answer.status, body: answer.body as never } })
      state = read.state
    }
  }
  if (runId === null) throw new Error('The mock finished the document without naming its run.')
  const spans = (mock.spansOf(runId) ?? []) as Span[]
  const summary = summariseTrace(spans)
  return recordingSchema.parse({
    v: 1,
    system: 'lb-03',
    sample: sample.id,
    origin: options.origin ?? 'mock',
    recordedAt: new Date(NOW).toISOString(),
    language: 'en',
    exchanges,
    trace: { runId, spans },
    stats: { modelCalls: summary.modelCalls, steps: summary.steps, durationMs: summary.durationMs },
  })
}
