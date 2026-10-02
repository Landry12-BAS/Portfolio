// The routes for a visitor's contracts: start a review (from a sample or an upload), follow it, read
// its pages, its file and its report, make a redline of a finding, and delete the contract early.
//
// Every route is scoped to the visitor's own session in the query itself, so another visitor's
// contract is simply not found. A contract the sweep has not yet deleted but whose hour is up is not
// found either. The upload route takes a PDF as base64 inside JSON, because the site's server
// forwards nothing else, and has a body limit of its own that fits the file limit and no more.
import { LB04_LIMITS, lb04ContractViewSchema, lb04CreateContractRequestSchema, lb04FileViewSchema, lb04PagesViewSchema, lb04RedlineSchema, lb04ReportSchema } from '@lb/contracts'
import { z } from 'zod'

import { visitorOf } from '../../../core/visitor-auth.ts'
import { makeRedline, startContract } from '../engine/service.ts'
import { contractNotFound, deleteContractOf, listContractViews, readContractView, readFileView, readPagesView, readReportView } from '../engine/store.ts'
import { errors, findingParams, idParams, TAGS } from './shared.ts'
import type { Lb04Services, Typed } from './shared.ts'

// A PDF at its size limit as base64, with room for the JSON around it.
const UPLOAD_BODY_LIMIT = Math.ceil(LB04_LIMITS.maxFileBytes / 3) * 4 + 1_024

/** Adds the contract routes. */
export function registerContractRoutes(app: Typed, services: Lb04Services): void {
  const { deps } = services

  app.post('/contracts', {
    bodyLimit: UPLOAD_BODY_LIMIT,
    schema: {
      tags: TAGS,
      summary: 'Review a sample contract, or a PDF the visitor sends',
      description: `A PDF is sent as base64 in JSON (at most ${LB04_LIMITS.maxFileBytes / (1_024 * 1_024)} MB, ${LB04_LIMITS.maxPages} pages). The answer is the contract, queued: follow it with GET /contracts/{id}. A review takes two to five model calls (the guard, the reading and the rating, each of the last two repaired at most once) and each redline one more. The visitor may have ${LB04_LIMITS.contractsPerVisitorPerDay} contracts reviewed a day and send ${LB04_LIMITS.uploadsPerVisitorPerDay} files; a contract that fails gives its place back, and a contract is deleted an hour after it is made.`,
      body: lb04CreateContractRequestSchema,
      response: { 201: lb04ContractViewSchema, ...errors.unauthorized, ...errors.missing, ...errors.tooLarge, ...errors.notAPdf, ...errors.invalid, ...errors.limited, ...errors.unavailable },
    },
  }, async (request, reply) => {
    const view = await startContract(deps, visitorOf(request).sessionKey, request.body)
    return reply.code(201).send(view)
  })

  app.get('/contracts', {
    schema: { tags: TAGS, summary: 'The visitor\'s contracts, newest first', response: { 200: z.array(lb04ContractViewSchema), ...errors.unauthorized } },
  }, async request => listContractViews(deps.db, visitorOf(request).sessionKey, deps.now()))

  app.get('/contracts/:id', {
    schema: {
      tags: TAGS,
      summary: 'One contract and the state of its review',
      description: 'The state moves queued, extracting, analysing, verifying, done; `failed` can follow any of them, with a code that says why. Poll this route while the review runs.',
      params: idParams,
      response: { 200: lb04ContractViewSchema, ...errors.unauthorized, ...errors.missing },
    },
  }, async (request) => {
    const view = await readContractView(deps.db, visitorOf(request).sessionKey, request.params.id, deps.now())
    if (!view) throw contractNotFound()
    return view
  })

  app.get('/contracts/:id/pages', {
    schema: {
      tags: TAGS,
      summary: 'The text of every page, as the server extracted it',
      description: 'What every citation counts its characters in: a citation is a page and a range of this text.',
      params: idParams,
      response: { 200: lb04PagesViewSchema, ...errors.unauthorized, ...errors.missing, ...errors.notReady },
    },
  }, async request => readPagesView(deps.db, visitorOf(request).sessionKey, request.params.id, deps.now()))

  app.get('/contracts/:id/file', {
    schema: {
      tags: TAGS,
      summary: 'The PDF itself, for the viewer',
      description: 'As base64 inside JSON, because the site\'s server forwards nothing else.',
      params: idParams,
      response: { 200: lb04FileViewSchema, ...errors.unauthorized, ...errors.missing, ...errors.notReady },
    },
  }, async request => readFileView(deps.db, visitorOf(request).sessionKey, request.params.id, deps.now()))

  app.get('/contracts/:id/report', {
    schema: {
      tags: TAGS,
      summary: 'The finished review',
      description: 'Every risk finding quotes the contract, and the quote was checked against the contract\'s text by the server. A missing clause has no quote, and says what was searched for. Not legal advice.',
      params: idParams,
      response: { 200: lb04ReportSchema, ...errors.unauthorized, ...errors.missing, ...errors.notReady },
    },
  }, async request => readReportView(deps.db, visitorOf(request).sessionKey, request.params.id, deps.now()))

  app.post('/contracts/:id/findings/:findingId/redline', {
    schema: {
      tags: TAGS,
      summary: 'A proposed change to one finding\'s passage',
      description: `The model proposes wording and the server computes the difference word by word. It costs one model call and one of the contract's ${LB04_LIMITS.redlinesPerContract} redlines; asking again for the same finding shows the redline already made and costs nothing. Not legal advice.`,
      params: findingParams,
      response: { 200: lb04RedlineSchema, 201: lb04RedlineSchema, ...errors.unauthorized, ...errors.missing, ...errors.notReady, ...errors.limited, ...errors.unavailable },
    },
  }, async (request, reply) => {
    const { redline, created } = await makeRedline(deps, visitorOf(request).sessionKey, request.params.id, request.params.findingId)
    return reply.code(created ? 201 : 200).send(redline)
  })

  app.delete('/contracts/:id', {
    schema: {
      tags: TAGS,
      summary: 'Delete a contract now',
      description: 'Removes the file, the text, the report and the redlines at once, instead of at the end of the hour. It does not give back the visitor\'s place for the day.',
      params: idParams,
      response: { 204: z.null(), ...errors.unauthorized, ...errors.missing },
    },
  }, async (request, reply) => {
    if (!(await deleteContractOf(deps.db, visitorOf(request).sessionKey, request.params.id))) throw contractNotFound()
    return reply.code(204).send(null)
  })
}
