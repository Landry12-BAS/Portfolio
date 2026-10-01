// The routes for runs: start one with a test payload, follow its log, answer an approval,
// and replay a finished run. A run is queued and answered at once (202): workers do the
// rest, and the site follows the run by asking for the events it hasn't seen.
//
// Following a run is a poll with a cursor (`after`) rather than a held-open stream, so a
// viewer costs one short request at a time and nothing between them.
import { decisionRequestSchema, runEventSchema, runStatuses, runSummarySchema, runViewSchema, startRunRequestSchema } from '@lb/contracts'
import { z } from 'zod'

import { visitorOf } from '../../../core/visitor-auth.ts'
import { listRuns, readRunEvents, readRunView } from '../engine/reads.ts'
import { decide, replayRun, runNotFound, startRun } from '../engine/runs.ts'
import { errors, idParams, stepParams, TAGS } from './shared.ts'
import type { Lb08Services, Typed } from './shared.ts'

// What a poll of a run's log answers with.
const runEventsSchema = z.strictObject({ status: z.enum(runStatuses), events: z.array(runEventSchema) })

/** Adds the run routes. */
export function registerRunRoutes(app: Typed, services: Lb08Services): void {
  const { deps } = services

  /** Reads a run the visitor owns in full, or answers 404. */
  async function viewOf(sessionKey: string, runId: string) {
    const view = await readRunView(deps.db, sessionKey, runId)
    if (!view) throw runNotFound()
    return view
  }

  app.post('/workflows/:id/runs', {
    schema: {
      tags: TAGS,
      summary: 'Start a run of a workflow with a test payload',
      description: 'The run is queued and answered at once. `failures` makes action steps fail on purpose, so the retries, the dead-letter queue and the replay can be watched. A run takes one of the visitor\'s ten a day.',
      params: idParams,
      body: startRunRequestSchema,
      response: { 202: runViewSchema, ...errors.unauthorized, ...errors.missing, ...errors.conflict, ...errors.invalid, ...errors.limited },
    },
  }, async (request, reply) => {
    const { sessionKey } = visitorOf(request)
    const runId = await startRun(deps, sessionKey, request.params.id, request.body)
    return reply.code(202).send(await viewOf(sessionKey, runId))
  })

  app.get('/runs', {
    schema: { tags: TAGS, summary: 'The visitor\'s runs, newest first', response: { 200: z.array(runSummarySchema), ...errors.unauthorized } },
  }, async request => listRuns(deps.db, visitorOf(request).sessionKey))

  app.get('/runs/:id', {
    schema: { tags: TAGS, summary: 'One run: its payload, every step and its whole log', params: idParams, response: { 200: runViewSchema, ...errors.unauthorized, ...errors.missing } },
  }, async request => viewOf(visitorOf(request).sessionKey, request.params.id))

  app.get('/runs/:id/events', {
    schema: {
      tags: TAGS,
      summary: 'The events of a run after the last one the caller saw',
      description: 'Ask again with `after` set to the highest `seq` received, until the run\'s status is succeeded or failed.',
      params: idParams,
      querystring: z.strictObject({ after: z.coerce.number().int().min(0).max(100_000).default(0) }),
      response: { 200: runEventsSchema, ...errors.unauthorized, ...errors.missing },
    },
  }, async (request) => {
    const found = await readRunEvents(deps.db, visitorOf(request).sessionKey, request.params.id, request.query.after)
    if (!found) throw runNotFound()
    return found
  })

  app.post('/runs/:id/replay', {
    schema: {
      tags: TAGS,
      summary: 'Replay a finished run',
      description: 'A new run of the same version with the same payload. What the original already sent is recognised by its idempotency key and not sent again. A replay takes one of the visitor\'s ten runs a day.',
      params: idParams,
      response: { 202: runViewSchema, ...errors.unauthorized, ...errors.missing, ...errors.conflict, ...errors.limited },
    },
  }, async (request, reply) => {
    const { sessionKey } = visitorOf(request)
    const replayId = await replayRun(deps, sessionKey, request.params.id)
    return reply.code(202).send(await viewOf(sessionKey, replayId))
  })

  app.post('/runs/:id/steps/:nodeId/decision', {
    schema: {
      tags: TAGS,
      summary: 'Answer an approval step',
      description: 'Only an approval that is waiting can be answered, once. The run carries on down the branch chosen.',
      params: stepParams,
      body: decisionRequestSchema,
      response: { 200: runViewSchema, ...errors.unauthorized, ...errors.missing, ...errors.conflict },
    },
  }, async (request) => {
    const { sessionKey } = visitorOf(request)
    await decide(deps, sessionKey, request.params.id, request.params.nodeId, request.body)
    return viewOf(sessionKey, request.params.id)
  })
}
