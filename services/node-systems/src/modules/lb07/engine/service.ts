// What a visitor's requests do, above the store: start a run from a sample or from their own goal and
// bugs. The routes are thin; the rules are here. Starting a run checks the cheap things first (does the
// sample exist, is the system busy), then takes the visitor's place and stores the run in one
// transaction, and only then queues the job; a job that cannot be queued is withdrawn and the place given back.
import type { Lb07CreateRunRequest, Lb07RunView } from '@lb/contracts'

import { AppError } from '../../../core/errors.ts'
import type { Lb07Deps } from './deps.ts'
import { createRun, readRunView, runNotFound, withdrawRun } from './store.ts'
import type { NewRun } from './store.ts'

/** The error for a service that has no way to reach the model gateway. */
function noGateway(): AppError {
  return new AppError(503, 'planning_unavailable', 'This service has no connection to the model gateway.')
}

/** What a request is about: a sample's goal and bugs, or the visitor's own. */
function runOf(deps: Lb07Deps, sessionKey: string, request: Lb07CreateRunRequest): NewRun {
  if (request.from === 'custom') return { sessionKey, origin: 'custom', sampleId: null, goal: request.goal, bugs: request.bugs }
  const sample = deps.samples.find(candidate => candidate.id === request.sampleId)
  if (!sample) throw new AppError(404, 'unknown_sample', 'There is no sample with that id.')
  return { sessionKey, origin: 'sample', sampleId: sample.id, goal: sample.goal, bugs: sample.bugs }
}

/** Starts a run and returns it as queued. 404 for a sample that does not exist, 429 when the visitor has no run left today, 503 when the system is busy or has no gateway. */
export async function startRun(deps: Lb07Deps, sessionKey: string, request: Lb07CreateRunRequest): Promise<Lb07RunView> {
  if (!deps.agent) throw noGateway()
  const id = await createRun(deps, runOf(deps, sessionKey, request))
  try {
    await deps.scheduler.enqueue(id)
  }
  catch (error) {
    deps.log.error({ err: error, runId: id }, 'a run could not be queued')
    await withdrawRun(deps, id)
    throw new AppError(503, 'queue_unavailable', 'The run could not be queued. Try again in a moment.')
  }
  const view = await readRunView(deps.db, sessionKey, id, deps.now())
  if (!view) throw runNotFound()
  return view
}
