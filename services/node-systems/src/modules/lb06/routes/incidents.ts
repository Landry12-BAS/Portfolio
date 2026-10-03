// The routes for a visitor's incidents: start one, follow it (its state, and its events after a
// number, which is the polling fallback of the WebSocket), answer the pending proposal, abort it,
// and read its postmortem. Every route is scoped to the visitor's own session in the query itself,
// so another visitor's incident is simply not found.
import { LB06_LIMITS, lb06DecisionRequestSchema, lb06EventsPageSchema, lb06IncidentViewSchema, lb06PostmortemViewSchema, lb06StartIncidentRequestSchema } from '@lb/contracts'
import { z } from 'zod'

import { AppError } from '../../../core/errors.ts'
import { visitorOf } from '../../../core/visitor-auth.ts'
import { timelineOf } from '../agents/postmortem.ts'
import { abortIncident, decide, startIncident } from '../engine/service.ts'
import { incidentNotFound, listIncidentViews, readEvents, readIncident, readIncidentView } from '../engine/store.ts'
import { errors, idParams, proposalParams, TAGS } from './shared.ts'
import type { Lb06Services, Typed } from './shared.ts'

// How many events one page of the log holds.
const PAGE = 200

/** The query of the events route: after which number. */
const eventsQuery = z.strictObject({ after: z.coerce.number().int().min(0).max(LB06_LIMITS.maxEvents).default(0) })

/** Adds the incident routes. */
export function registerIncidentRoutes(app: Typed, services: Lb06Services): void {
  const { deps } = services

  app.post('/incidents', {
    schema: {
      tags: TAGS,
      summary: 'Break the shop: start an incident',
      description: `A curated sample (\`{from: "sample", sampleId}\`) or a fault of the visitor's own with an optional seed and parameters (a version label for the bad deploy, a flag's name), which the injection screen reads first (one model call). The answer is the incident at its first minute; follow it over the WebSocket at /ws/lb06/ or by polling GET /incidents/{id}/events. The agents spend at most ${LB06_LIMITS.stepCap} model calls, and nothing changes the shop until a proposal is approved. One incident per visitor per day; ${LB06_LIMITS.maxConcurrentIncidents} at once across every visitor.`,
      body: lb06StartIncidentRequestSchema,
      response: { 201: lb06IncidentViewSchema, ...errors.unauthorized, ...errors.missing, ...errors.invalid, ...errors.limited, ...errors.unavailable },
    },
  }, async (request, reply) => {
    const view = await startIncident(deps, visitorOf(request).sessionKey, request.body)
    return reply.code(201).send(view)
  })

  app.get('/incidents', {
    schema: { tags: TAGS, summary: 'The visitor\'s incidents, newest first', response: { 200: z.array(lb06IncidentViewSchema), ...errors.unauthorized } },
  }, async request => listIncidentViews(deps.db, visitorOf(request).sessionKey, deps.now()))

  app.get('/incidents/:id', {
    schema: {
      tags: TAGS,
      summary: 'One incident and where it stands',
      description: 'The state moves detecting, investigating, awaiting_approval, remediating, verifying, writing_postmortem, closed; `aborted` and `failed` can follow any of them, with a reason. The SLO is as code measures it at the incident\'s minute.',
      params: idParams,
      response: { 200: lb06IncidentViewSchema, ...errors.unauthorized, ...errors.missing },
    },
  }, async (request) => {
    const view = await readIncidentView(deps.db, visitorOf(request).sessionKey, request.params.id, deps.now())
    if (!view) throw incidentNotFound()
    return view
  })

  app.get('/incidents/:id/events', {
    schema: {
      tags: TAGS,
      summary: 'The events after the last one seen',
      description: `The polling fallback of the WebSocket: the events numbered after \`after\`, at most ${PAGE} a page, with the incident's state. A tick carries the minute's metrics and SLO, so the dashboards are drawn from the events alone.`,
      params: idParams,
      querystring: eventsQuery,
      response: { 200: lb06EventsPageSchema, ...errors.unauthorized, ...errors.missing },
    },
  }, async (request) => {
    const moment = deps.now()
    const row = await readIncident(deps.db, request.params.id, moment, visitorOf(request).sessionKey)
    if (!row) throw incidentNotFound()
    const events = await readEvents(deps.db, row.id, request.query.after, PAGE + 1)
    const page = events.slice(0, PAGE)
    return { events: page, cursor: page.at(-1)?.seq ?? request.query.after, more: events.length > PAGE, state: row.state }
  })

  app.post('/incidents/:id/proposals/:proposalId/decision', {
    schema: {
      tags: TAGS,
      summary: 'Approve or reject the pending proposal',
      description: 'The one thing that changes the shop. Approving applies the action at the incident\'s minute and the SLO is then watched by code; rejecting sends the agents back to rank again. A decision that does not name the pending proposal is refused with 409, so a replayed or forged approval does nothing.',
      params: proposalParams,
      body: lb06DecisionRequestSchema,
      response: { 200: lb06IncidentViewSchema, ...errors.unauthorized, ...errors.missing, ...errors.conflict, ...errors.invalid },
    },
  }, async request => decide(deps, visitorOf(request).sessionKey, request.params.id, request.params.proposalId, request.body.decision))

  app.post('/incidents/:id/abort', {
    schema: {
      tags: TAGS,
      summary: 'End the incident now',
      description: 'The incident ends as aborted and its log stays readable until it expires. It does not give the visitor\'s incident of the day back.',
      params: idParams,
      response: { 200: lb06IncidentViewSchema, ...errors.unauthorized, ...errors.missing, ...errors.conflict },
    },
  }, async request => abortIncident(deps, visitorOf(request).sessionKey, request.params.id))

  app.get('/incidents/:id/postmortem', {
    schema: {
      tags: TAGS,
      summary: 'The postmortem',
      description: 'The timeline the server built from the event log, and the prose a model wrote over it, which the server checked to reference only events the log holds (null when it could not be trusted). 409 `not_ready` until the incident has closed.',
      params: idParams,
      response: { 200: lb06PostmortemViewSchema, ...errors.unauthorized, ...errors.missing, ...errors.conflict },
    },
  }, async (request) => {
    const moment = deps.now()
    const row = await readIncident(deps.db, request.params.id, moment, visitorOf(request).sessionKey)
    if (!row) throw incidentNotFound()
    if (row.state !== 'closed') throw new AppError(409, 'not_ready', 'The incident has not closed yet, so there is no postmortem.')
    const events = await readEvents(deps.db, row.id, 0, LB06_LIMITS.maxEvents)
    const written = events.find(event => event.kind === 'postmortem.written')
    return {
      incidentId: row.id,
      timeline: timelineOf(events),
      prose: written?.kind === 'postmortem.written' ? written.data.prose : null,
      modelCalls: row.modelCalls,
      proposals: row.proposalsMade,
      recoveredMinute: row.recoveredMinute,
    }
  })
}
