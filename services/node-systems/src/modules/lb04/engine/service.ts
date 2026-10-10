// What a visitor's requests do, above the store: start a review from a sample or an upload, and make a
// redline. The routes are thin; the rules are here.
//
// Starting a review checks the cheap things first (is the file a PDF, is it within the size limit,
// does the sample exist) so a request that can't succeed takes no place from the visitor's day, then
// takes the places and stores the contract in one transaction, and only then queues the job. A job
// that can't be queued is withdrawn and the places are given back, so a visitor is never charged for
// a review that was never going to run.
//
// A redline costs one model call and one of the contract's three: the place is taken before the call
// (the statement that takes it refuses past the limit) and given back when the call fails or when a
// redline for that finding was made in the meantime.
import { createRun, gatewayErrorOf, runScope, spanScope } from '@lb/common'
import type { GatewayCallError } from '@lb/common'
import type { Lb04ContractView, Lb04CreateContractRequest, Lb04Redline } from '@lb/contracts'

import { AppError } from '../../../core/errors.ts'
import { proposeRedline } from '../analysis/propose.ts'
import { readSampleFile } from '../data/samples.ts'
import { decodeUpload, titleOf } from '../pdf/upload.ts'
import type { Lb04Deps } from './deps.ts'
import { contractNotFound, createContract, readContractView, readRedline, readReportView, releaseRedline, reserveRedline, saveRedline, withdrawContract } from './store.ts'
import { rootSpanIdOf } from './trace.ts'

/** The error for a visitor who can't have a model's work right now: the model is out of reach or out of quota. */
function unavailable(error: GatewayCallError): AppError {
  return new AppError(503, 'analysis_unavailable', 'The model is unavailable right now: the free quota may be spent, or a provider may be down. The samples show what a review looks like, and you can come back later.', {
    ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
  })
}

/** The error for a service that has no way to reach the model gateway. */
function noGateway(): AppError {
  return new AppError(503, 'analysis_unavailable', 'This service has no connection to the model gateway.')
}

/** Reads the file and the title a request is about: a sample from the list, or an upload checked at the door. */
function fileOf(deps: Lb04Deps, request: Lb04CreateContractRequest): { file: Uint8Array, title: string, origin: 'upload' | 'sample', sampleId: string | null } {
  if (request.from === 'upload') return { file: decodeUpload(request.contentBase64), title: titleOf(request.filename), origin: 'upload', sampleId: null }
  const entry = deps.samples.find(candidate => candidate.id === request.sampleId)
  if (!entry) throw new AppError(404, 'unknown_sample', 'There is no sample with that id.')
  return { file: readSampleFile(deps.seedDirectory, entry).bytes, title: entry.title, origin: 'sample', sampleId: entry.id }
}

/**
 * Starts the review of a contract for a visitor, and returns it as queued. Answers 415 for a file that
 * isn't a PDF, 413 for one over the size limit, 404 for a sample that doesn't exist, 429 when the
 * visitor has no place left today, and 503 when the service can't take it (no gateway, or no queue).
 */
export async function startContract(deps: Lb04Deps, sessionKey: string, request: Lb04CreateContractRequest): Promise<Lb04ContractView> {
  if (!deps.review) throw noGateway()
  const { file, title, origin, sampleId } = fileOf(deps, request)
  const id = await createContract(deps, { sessionKey, origin, sampleId, title, file })
  try {
    await deps.scheduler.enqueue(id)
  }
  catch (error) {
    deps.log.error({ err: error, contractId: id }, 'a review could not be queued')
    await withdrawContract(deps, id)
    throw new AppError(503, 'queue_unavailable', 'The review could not be queued. Try again in a moment.')
  }
  const view = await readContractView(deps.db, sessionKey, id, deps.now())
  if (!view) throw contractNotFound()
  return view
}

/** A redline, and whether this request made it (and so spent a model call) or found it already made. */
export interface RedlineResult {
  redline: Lb04Redline
  created: boolean
}

/**
 * Makes the redline of one finding of a visitor's finished contract. A finding that already has one
 * shows it and spends nothing. Answers 404 for a contract or a finding that isn't there, 409 while the
 * review is not finished, 429 when the contract's three redlines are made, and 503 when the model can't
 * be reached (the place is given back).
 */
export async function makeRedline(deps: Lb04Deps, sessionKey: string, contractId: string, findingId: string): Promise<RedlineResult> {
  if (!deps.review) throw noGateway()
  const moment = deps.now()
  const contract = await readContractView(deps.db, sessionKey, contractId, moment)
  if (!contract) throw contractNotFound()
  const report = await readReportView(deps.db, sessionKey, contractId, moment)
  const finding = report.findings.find(candidate => candidate.id === findingId)
  if (!finding) throw new AppError(404, 'finding_not_found', 'This contract has no such finding.')
  const existing = report.redlines.find(candidate => candidate.findingId === findingId)
  if (existing) return { redline: existing, created: false }
  if (!(await reserveRedline(deps.db, sessionKey, contractId, moment))) throw new AppError(429, 'redline_limit', 'This contract has its redlines made.')
  const run = createRun({ system: 'lb-04', runId: contractId, session: sessionKey, dataClass: contract.origin === 'sample' ? 'synthetic' : 'visitor' })
  const models = deps.review.models
  // The place this request took stays taken only when its redline is the one that was stored.
  let keepPlace = false
  try {
    const { redline } = await runScope(run, () => spanScope(rootSpanIdOf(contractId), () => proposeRedline({ models, playbook: deps.playbook, tracer: deps.tracer }, finding)))
    keepPlace = await saveRedline(deps.db, contractId, redline, deps.now())
    if (keepPlace) return { redline, created: true }
    // A request for the same finding made one first: its redline stands.
    const made = await readRedline(deps.db, contractId, findingId)
    if (!made) throw new Error('A redline was neither stored nor found.')
    return { redline: made, created: false }
  }
  catch (error) {
    const gateway = gatewayErrorOf(error)
    if (!gateway) throw error
    deps.log.warn({ gatewayCode: gateway.code, status: gateway.status, contractId }, 'a redline could not reach the model')
    throw unavailable(gateway)
  }
  finally {
    if (!keepPlace) await releaseRedline(deps.db, contractId)
  }
}
