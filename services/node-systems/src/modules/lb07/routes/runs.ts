// The routes for a visitor's runs: start one, follow it, read its report, its generated test and its
// evidence, and delete it early. Every route is scoped to the visitor's own session in the query itself,
// so another visitor's run is simply not found, and so is a run whose hour is up.
import { LB07_LIMITS, lb07CreateRunRequestSchema, lb07EvidenceViewSchema, lb07ReportSchema, lb07RunViewSchema, lb07TestViewSchema } from '@lb/contracts'
import { z } from 'zod'

import { visitorOf } from '../../../core/visitor-auth.ts'
import { startRun } from '../engine/service.ts'
import { deleteRunOf, listRunViews, readEvidenceView, readReportView, readRunView, readTestView, runNotFound } from '../engine/store.ts'
import { errors, evidenceParams, idParams, TAGS } from './shared.ts'
import type { Lb07Services, Typed } from './shared.ts'

/** Adds the run routes. */
export function registerRunRoutes(app: Typed, services: Lb07Services): void {
  const { deps } = services

  app.post('/runs', {
    schema: {
      tags: TAGS,
      summary: 'Start a test run: a curated sample, or the visitor\'s own goal and bugs',
      description: `The run is queued and answered at once; follow it with GET /runs/{id}. A run plans the test in one model call, runs it step by step in a sandboxed browser that can reach only the staging shop, asks the model again only when a step fails (twice at most), writes the bug reports from the findings code made, generates the Playwright test and verifies it red on the buggy shop and green on the clean one: 2 to 7 model calls. ${LB07_LIMITS.runsPerVisitorPerDay} runs a visitor a day; a goal is at most ${LB07_LIMITS.maxGoalLength} characters; at most ${LB07_LIMITS.maxQueued} runs wait for the one browser, and the next is told the system is busy (503 \`busy\`).`,
      body: lb07CreateRunRequestSchema,
      response: { 201: lb07RunViewSchema, ...errors.unauthorized, ...errors.missing, ...errors.invalid, ...errors.limited, ...errors.unavailable },
    },
  }, async (request, reply) => {
    const view = await startRun(deps, visitorOf(request).sessionKey, request.body)
    return reply.code(201).send(view)
  })

  app.get('/runs', {
    schema: { tags: TAGS, summary: 'The visitor\'s runs of the last hour, newest first', response: { 200: z.array(lb07RunViewSchema), ...errors.unauthorized } },
  }, async request => listRunViews(deps.db, visitorOf(request).sessionKey, deps.now()))

  app.get('/runs/:id', {
    schema: {
      tags: TAGS,
      summary: 'One run: its state, its place in the queue, and its steps as they happen',
      description: 'The state moves queued, planning, running (with replanning when a step failed), cross_checking, reporting, verifying, done; `failed` can follow any of them, with a code that says why. Poll this route while the run goes.',
      params: idParams,
      response: { 200: lb07RunViewSchema, ...errors.unauthorized, ...errors.missing },
    },
  }, async (request) => {
    const view = await readRunView(deps.db, visitorOf(request).sessionKey, request.params.id, deps.now())
    if (!view) throw runNotFound()
    return view
  })

  app.get('/runs/:id/report', {
    schema: {
      tags: TAGS,
      summary: 'The finished report: the findings code made, the bug reports the model wrote from them, and the verification',
      description: '409 `not_ready` while the run goes, `run_failed` when it failed.',
      params: idParams,
      response: { 200: lb07ReportSchema, ...errors.unauthorized, ...errors.missing, ...errors.notReady },
    },
  }, async request => readReportView(deps.db, visitorOf(request).sessionKey, request.params.id, deps.now()))

  app.get('/runs/:id/test', {
    schema: {
      tags: TAGS,
      summary: 'The generated Playwright test, as text, with its verdict',
      description: 'Written by a template from the validated plan; every string is a JSON literal. The verdict says whether the test was red with the bugs on and green with them off. This service never runs it.',
      params: idParams,
      response: { 200: lb07TestViewSchema, ...errors.unauthorized, ...errors.missing, ...errors.notReady },
    },
  }, async request => readTestView(deps.db, visitorOf(request).sessionKey, request.params.id, deps.now()))

  app.get('/runs/:id/evidence/:evidenceId', {
    schema: {
      tags: TAGS,
      summary: 'One piece of evidence: a screenshot (PNG as base64) or a trimmed accessibility snapshot',
      params: evidenceParams,
      response: { 200: lb07EvidenceViewSchema, ...errors.unauthorized, ...errors.missing },
    },
  }, async request => readEvidenceView(deps.db, visitorOf(request).sessionKey, request.params.id, request.params.evidenceId, deps.now()))

  app.delete('/runs/:id', {
    schema: {
      tags: TAGS,
      summary: 'Delete a run now',
      description: 'Removes the run with its steps, findings, evidence, report and test at once, instead of at the end of the hour. It does not give back the visitor\'s run for the day.',
      params: idParams,
      response: { 204: z.null(), ...errors.unauthorized, ...errors.missing },
    },
  }, async (request, reply) => {
    if (!(await deleteRunOf(deps.db, visitorOf(request).sessionKey, request.params.id))) throw runNotFound()
    return reply.code(204).send(null)
  })
}
