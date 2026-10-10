// How LB-05's curated questions and attacks are run for a recording: the question is asked through the
// visitor API exactly as the board asks it, in one request that the analyst answers when it is done
// (up to 90 seconds), and that one exchange is what the board's replay hands back, with the run's
// trace. A recording holds what a visitor's browser would have been told. The runner refuses what it
// cannot record honestly: an answer that says the service could not answer (nothing happened worth
// showing, and the question was not counted), an answer that names no run (so there is no trace to
// replay), and a curated question that did not come out answered, because a recording is what the
// board shows first and a failed curated question should be looked into, not shown. An attack may
// end any way the system ends it, since showing which layer stopped it is the point. It costs one of
// the visitor's questions and two to four model calls.
import type { Exchange } from '@lb/contracts'

import { answerSchema } from '../../app/boards/lb-05/schemas.ts'
import { LB05_ATTACKS, LB05_SAMPLES } from '../../shared/data/samples/lb05.ts'
import type { Backend } from './backend.ts'
import type { RecordedRun } from './record.ts'

/** The path of the one route a question is asked at. */
const ASK_PATH = '/api/lb05/ask'

/** How long one question may take: the back end gives a question 90 seconds, and the site's server waits 95. */
const ASK_PATIENCE_MS = 100_000

/** Lists the IDs the runner knows, for the message that says a sample does not exist. */
function knownIds(): string {
  const questions = LB05_SAMPLES.map(sample => sample.id).join(', ')
  const attacks = LB05_ATTACKS.map(attack => attack.id).join(', ')
  return `Its questions are: ${questions}. Its attacks are: ${attacks}.`
}

/** Runs one of LB-05's curated questions or attacks and returns what the board asked and was told, and the run's ID. */
export async function runLb05Sample(backend: Backend, sampleId: string): Promise<RecordedRun> {
  const curated = LB05_SAMPLES.find(candidate => candidate.id === sampleId)
  const found = curated ?? LB05_ATTACKS.find(candidate => candidate.id === sampleId)
  if (!found) throw new Error(`LB-05 has no sample called "${sampleId}". ${knownIds()}`)

  const request = { question: found.question }
  const answer = await backend.call('lb-05', 'POST', ASK_PATH, request, { timeoutMs: ASK_PATIENCE_MS })
  if (answer.status !== 200) throw new Error(`The back end did not answer the question (status ${answer.status}).`)
  const parsed = answerSchema.safeParse(answer.body)
  if (!parsed.success) throw new Error('The back end\'s answer is not the shape the board reads, so it is not worth recording. Look at the back end and try again.')

  const { outcome, run_id: runId } = parsed.data
  if (outcome === 'unavailable') throw new Error('The analyst could not answer (its models were not answering), so there is nothing worth recording, and the question was not counted. Try again later.')
  if (curated && outcome !== 'answered') throw new Error(`The question "${curated.id}" came out ${outcome}, not answered. A curated question is recorded once it answers; look at the back end and try again.`)
  if (runId === '') throw new Error('The back end answered without naming its run, so there is no trace to record.')

  const exchange: Exchange = { request: { method: 'POST', path: ASK_PATH, body: request }, response: { status: answer.status, body: answer.body as Exchange['response']['body'] } }
  return { language: 'en', exchanges: [exchange], runId }
}
