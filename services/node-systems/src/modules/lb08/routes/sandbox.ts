// The routes that show the other side of the engine: what the sandboxed connectors "sent",
// and the steps that used all their attempts and are waiting in the dead-letter queue.
import { deadLetterViewSchema, runViewSchema, sentViewSchema } from '@lb/contracts'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { AppError } from '../../../core/errors.ts'
import { visitorOf } from '../../../core/visitor-auth.ts'
import { deadLetters } from '../db/schema.ts'
import { listDeadLetters, listSent, readRunView } from '../engine/reads.ts'
import { replayRun, runNotFound } from '../engine/runs.ts'
import { errors, idParams, TAGS } from './shared.ts'
import type { Lb08Services, Typed } from './shared.ts'

/** Adds the deliveries and dead-letter routes. */
export function registerSandboxRoutes(app: Typed, services: Lb08Services): void {
  const { deps } = services

  app.get('/sent', {
    schema: {
      tags: TAGS,
      summary: 'What the sandboxed connectors sent for the visitor, newest first',
      description: 'Nothing here left the system: the connectors write to a table. Give `rootRunId` to see one run and its replays.',
      querystring: z.strictObject({ rootRunId: z.uuid().optional() }),
      response: { 200: z.array(sentViewSchema), ...errors.unauthorized },
    },
  }, async request => listSent(deps.db, visitorOf(request).sessionKey, request.query.rootRunId))

  app.get('/dead-letters', {
    schema: { tags: TAGS, summary: 'The steps that used all their attempts, newest first', response: { 200: z.array(deadLetterViewSchema), ...errors.unauthorized } },
  }, async request => listDeadLetters(deps.db, visitorOf(request).sessionKey))

  app.post('/dead-letters/:id/replay', {
    schema: {
      tags: TAGS,
      summary: 'Replay the run a dead letter came from, in one step',
      description: 'The same as replaying the run. A dead letter is replayed once: after that, the answer is 409 and the replay is the run to look at.',
      params: idParams,
      response: { 202: runViewSchema, ...errors.unauthorized, ...errors.missing, ...errors.conflict, ...errors.limited },
    },
  }, async (request, reply) => {
    const { sessionKey } = visitorOf(request)
    const [letter] = await deps.db.select().from(deadLetters).where(and(eq(deadLetters.id, request.params.id), eq(deadLetters.sessionKey, sessionKey))).limit(1)
    if (!letter) throw new AppError(404, 'not_found', 'There is no such dead letter.')
    if (letter.replayedRunId !== null) throw new AppError(409, 'already_replayed', 'This dead letter was already replayed. Open the run that replayed it.')
    const replayId = await replayRun(deps, sessionKey, letter.runId, letter.id)
    const view = await readRunView(deps.db, sessionKey, replayId)
    if (!view) throw runNotFound()
    return reply.code(202).send(view)
  })
}
