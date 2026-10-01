// Describing a workflow on a visitor's behalf: take one of their daily descriptions, run the
// pipeline inside a run of its own, and save the result as the workflow's first version.
//
// The description is taken before the model is called, because the calls are what the
// allowance counts, and a visitor can't get unlimited free tries from failures they cause: a
// description the model can't turn into a valid workflow still used its calls. A failure that
// isn't the visitor's (the gateway can't be reached, a provider is down, the day's free quota
// is spent) gives the description back, and the visitor is told to try again or to use a
// sample. The gateway's own error codes are logged, never shown, because some of them mean
// a misconfigured deploy.
import { createRun, gatewayErrorOf, newRunId, runScope } from '@lb/common'
import type { GatewayCallError } from '@lb/common'

import { AppError } from '../../../core/errors.ts'
import type { EngineDeps } from '../engine/deps.ts'
import { dailyLimit } from '../engine/runs.ts'
import { checkWorkflowRoom, createWorkflow } from '../engine/store.ts'
import { release, reserve } from '../engine/usage.ts'
import type { DescribeWorkflow } from './outcome.ts'

/** The error for a visitor who can't describe a workflow right now: the model behind it is out of reach or out of quota. */
function unavailable(error: GatewayCallError): AppError {
  return new AppError(503, 'generation_unavailable', 'Describing a workflow is unavailable right now: the free model quota may be spent, or a provider may be down. Try one of the samples, or come back later.', {
    ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
  })
}

/**
 * Turns a visitor's description into a saved workflow, and returns the workflow's id.
 * Refuses with 429 when they have used their descriptions for the day, with 503 when the
 * model can't be reached, and with 422 and the problems found when what the model wrote
 * doesn't pass validation (nothing is saved then).
 */
export async function describeAndSave(deps: EngineDeps, describe: DescribeWorkflow | undefined, sessionKey: string, description: string): Promise<string> {
  if (!describe) throw new AppError(503, 'generation_unavailable', 'This service has no connection to the model gateway.')
  // Before anything is spent: a visitor with no room for another workflow shouldn't wait for a model to find out.
  await checkWorkflowRoom(deps.db, sessionKey)
  if (!(await reserve(deps.db, sessionKey, 'generation', deps.now()))) throw dailyLimit('generation', deps.now())

  const runId = newRunId()
  let outcome: Awaited<ReturnType<DescribeWorkflow>>
  try {
    outcome = await runScope(createRun({ system: 'lb-08', runId, session: sessionKey }), () => describe(description))
  }
  catch (error) {
    await release(deps.db, sessionKey, 'generation', deps.now())
    const gatewayError = gatewayErrorOf(error)
    if (!gatewayError) throw error
    deps.log.warn({ gatewayCode: gatewayError.code, status: gatewayError.status, runId }, 'a description could not reach the model')
    throw unavailable(gatewayError)
  }
  if (outcome.status === 'rejected') {
    throw new AppError(422, 'workflow_rejected', 'That description can\'t be built as a workflow. These are the problems that stopped it.', { problems: outcome.issues })
  }
  return createWorkflow(deps, { sessionKey, graph: outcome.graph, origin: 'generated', description, modelCalls: outcome.modelCalls, traceRunId: runId })
}
