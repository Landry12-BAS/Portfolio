// The routes for a visitor's workflows: describe one (or start from a sample), read, list,
// save an edit as a new version, and delete.
//
// Every route is scoped to the visitor's own session in the query itself, so another
// visitor's workflow is simply not found. A graph is checked by `validateWorkflow` before it
// is stored, whoever wrote it: the model, or the visitor's own edit.
import { createWorkflowRequestSchema, updateWorkflowRequestSchema, validateWorkflow, workflowSummarySchema, workflowViewSchema } from '@lb/contracts'
import { z } from 'zod'

import { AppError } from '../../../core/errors.ts'
import { visitorOf } from '../../../core/visitor-auth.ts'
import { checkWorkflowRoom, createWorkflow, deleteWorkflow, saveVersion, workflowNotFound } from '../engine/store.ts'
import { listWorkflows, readWorkflowView } from '../engine/reads.ts'
import { describeAndSave } from '../generate/service.ts'
import { errors, idParams, TAGS } from './shared.ts'
import type { Lb08Services, Typed } from './shared.ts'

/** Saves a copy of a curated sample as the visitor's own workflow, and returns its id. */
async function startFromSample(services: Lb08Services, sessionKey: string, sampleId: string): Promise<string> {
  const sample = services.samples.find(candidate => candidate.id === sampleId)
  if (!sample) throw new AppError(404, 'unknown_sample', 'There is no sample with that id.')
  await checkWorkflowRoom(services.deps.db, sessionKey)
  return createWorkflow(services.deps, { sessionKey, graph: sample.graph, origin: 'sample', description: null, modelCalls: 0, traceRunId: null })
}

/** Adds the workflow routes. */
export function registerWorkflowRoutes(app: Typed, services: Lb08Services): void {
  const { deps } = services

  app.post('/workflows', {
    schema: {
      tags: TAGS,
      summary: 'Make a workflow from a description, or from a sample',
      description: 'A description costs one model call and, at most, one repair. A sample costs none.',
      body: createWorkflowRequestSchema,
      response: { 201: workflowViewSchema, ...errors.unauthorized, ...errors.missing, ...errors.conflict, ...errors.invalid, ...errors.limited, ...errors.unavailable },
    },
  }, async (request, reply) => {
    const { sessionKey } = visitorOf(request)
    const body = request.body
    const id = body.from === 'sample'
      ? await startFromSample(services, sessionKey, body.sampleId)
      : await describeAndSave(deps, services.describe, sessionKey, body.description)
    const view = await readWorkflowView(deps.db, sessionKey, id)
    if (!view) throw workflowNotFound()
    return reply.code(201).send(view)
  })

  app.get('/workflows', {
    schema: { tags: TAGS, summary: 'The visitor\'s workflows, newest first', response: { 200: z.array(workflowSummarySchema), ...errors.unauthorized } },
  }, async request => listWorkflows(deps.db, visitorOf(request).sessionKey))

  app.get('/workflows/:id', {
    schema: { tags: TAGS, summary: 'One workflow, with its latest graph and every version', params: idParams, response: { 200: workflowViewSchema, ...errors.unauthorized, ...errors.missing } },
  }, async (request) => {
    const view = await readWorkflowView(deps.db, visitorOf(request).sessionKey, request.params.id)
    if (!view) throw workflowNotFound()
    return view
  })

  app.put('/workflows/:id', {
    schema: {
      tags: TAGS,
      summary: 'Save an edited graph as a new version',
      description: 'The graph is validated first. `baseVersion` is the version the edit started from; if another save came first, the answer is 409.',
      params: idParams,
      body: updateWorkflowRequestSchema,
      response: { 200: workflowViewSchema, ...errors.unauthorized, ...errors.missing, ...errors.conflict, ...errors.invalid },
    },
  }, async (request) => {
    const { sessionKey } = visitorOf(request)
    const checked = validateWorkflow(request.body.graph)
    if (!checked.ok) throw new AppError(422, 'workflow_invalid', 'The workflow has problems.', { problems: checked.issues })
    await saveVersion(deps, sessionKey, request.params.id, request.body.baseVersion, checked.graph)
    const view = await readWorkflowView(deps.db, sessionKey, request.params.id)
    if (!view) throw workflowNotFound()
    return view
  })

  app.delete('/workflows/:id', {
    schema: { tags: TAGS, summary: 'Delete a workflow, with its versions, runs, logs and deliveries', params: idParams, response: { 204: z.null(), ...errors.unauthorized, ...errors.missing } },
  }, async (request, reply) => {
    if (!(await deleteWorkflow(deps.db, visitorOf(request).sessionKey, request.params.id))) throw workflowNotFound()
    return reply.code(204).send(null)
  })
}
