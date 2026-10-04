// How LB-03's curated samples are run for a recording: the sample's own file (from the seed that the golden
// set describes) is uploaded through the visitor API exactly as the board uploads it, the document is read as
// its pipeline moves on until it has ended, and each answer that shows a new state is kept, which is what the
// board's replay hands back, one after another. A recording holds what a visitor's browser would have been
// told. The runner refuses what it cannot record honestly: a seed file that is not the one the golden set
// describes, a document that ended any way other than the way the golden set says its sample must (a clean
// invoice that failed because the models were not answering is a failure to look into, not a recording; the
// hostile invoice must be stopped by the injection check, and that is the point of recording it), and a
// document that never names its run, so there would be no trace to replay. It costs one of the visitor's
// documents and, for a sample that is read, two to five model calls.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Exchange } from '@lb/contracts'

import { documentSchema } from '../../app/boards/lb-03/schemas.ts'
import { LB03_SAMPLES } from '../../shared/data/samples/lb03.ts'
import type { Backend } from './backend.ts'
import type { RecordedRun } from './record.ts'

/** The path of the one route a document is uploaded at, and the one it is read at (with its ID after it). */
const DOCUMENTS_PATH = '/api/lb03/documents'

/** How often the document is read, and how long its pipeline may take before the recording is abandoned: the service's own limit and a minute more. */
const READ_EVERY_MS = 1_000
const PIPELINE_PATIENCE_MS = 300_000

/** Where the seed's documents are: the files the golden set describes. */
const SEED_DOCUMENTS = fileURLToPath(new URL('../../../../data/seed/lb03/documents/', import.meta.url))

/** Runs one of LB-03's samples and returns what the board asked and was told, and the run's ID. */
export async function runLb03Sample(backend: Backend, sampleId: string): Promise<RecordedRun> {
  const sample = LB03_SAMPLES.find(candidate => candidate.id === sampleId)
  if (!sample) throw new Error(`LB-03 has no sample called "${sampleId}". Its samples are: ${LB03_SAMPLES.map(item => item.id).join(', ')}.`)

  const bytes = readFileSync(`${SEED_DOCUMENTS}${sample.file}`)
  if (bytes.length !== sample.bytes) throw new Error(`The seed's ${sample.file} is not the file the golden set describes (${bytes.length} bytes, not ${sample.bytes}). Run \`just seed-lb03\` and \`pnpm --filter @lb/web samples\`.`)

  const uploaded = await backend.upload('lb-03', DOCUMENTS_PATH, { name: sample.file, type: sample.mime, bytes })
  if (uploaded.status !== 202) throw new Error(`The back end did not take the document (status ${uploaded.status}).`)
  const first = documentSchema.parse(uploaded.body)
  // The request is recorded as what it was: a file, named, which a recording cannot hold the bytes of.
  const exchanges: Exchange[] = [{ request: { method: 'POST', path: DOCUMENTS_PATH, body: { file: sample.file } }, response: { status: uploaded.status, body: uploaded.body as Exchange['response']['body'] } }]

  const path = `${DOCUMENTS_PATH}/${first.id}`
  const startedAt = backend.clock.now()
  let state = first.state
  let last = first
  while (state !== 'ready' && state !== 'failed') {
    if (backend.clock.now() - startedAt > PIPELINE_PATIENCE_MS) throw new Error('The pipeline did not finish within five minutes.')
    await backend.clock.sleep(READ_EVERY_MS)
    const answer = await backend.call('lb-03', 'GET', path)
    if (answer.status !== 200) throw new Error(`Reading the document answered status ${answer.status}.`)
    last = documentSchema.parse(answer.body)
    // Keep an answer only when it shows something new, so a replay has one step for each state of the document.
    if (last.state !== state) {
      exchanges.push({ request: { method: 'GET', path }, response: { status: answer.status, body: answer.body as Exchange['response']['body'] } })
      state = last.state
    }
  }

  const expectedState = sample.outcome === 'held' ? 'failed' : 'ready'
  if (state !== expectedState) throw new Error(`The sample "${sample.id}" came out ${state}${last.failure ? ` (${last.failure.code})` : ''}, and the golden set expects ${expectedState}. A sample is recorded once it comes out as graded; look at the back end and try again.`)
  if (sample.guardFlags && last.failure?.code !== 'injection_suspected') throw new Error(`The sample "${sample.id}" must be stopped by the injection check, but it failed as ${last.failure?.code ?? 'nothing'}.`)
  if (last.run_id === null) throw new Error('The back end ended the document without naming its run, so there is no trace to record.')
  return { language: 'en', exchanges, runId: last.run_id }
}
