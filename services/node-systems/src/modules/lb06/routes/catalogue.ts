// The routes that say what the system is: the visitor's day and the limits, and the catalogue of
// faults and curated samples. Neither costs a model call or a place.
import { LB06_LIMITS, lb06CatalogueViewSchema, lb06LimitsViewSchema } from '@lb/contracts'

import { visitorOf } from '../../../core/visitor-auth.ts'
import { catalogueView } from '../data/samples.ts'
import { countRunning } from '../engine/store.ts'
import { nextReset, usedToday } from '../engine/usage.ts'
import { errors, TAGS } from './shared.ts'
import type { Lb06Services, Typed } from './shared.ts'

/** Adds the routes about the visitor's allowance and the catalogue. */
export function registerCatalogueRoutes(app: Typed, services: Lb06Services): void {
  const { deps } = services

  app.get('/limits', {
    schema: {
      tags: TAGS,
      summary: 'What is left of the visitor\'s day, and the limits of the system',
      description: 'Incidents started today against the daily limit of one, the step cap, how many incidents the service runs at once and how many it runs now, how long an incident may live, and when the day\'s allowance starts again.',
      response: { 200: lb06LimitsViewSchema, ...errors.unauthorized },
    },
  }, async (request) => {
    const moment = deps.now()
    const used = await usedToday(deps.db, visitorOf(request).sessionKey, moment)
    const limit = LB06_LIMITS.incidentsPerVisitorPerDay
    return {
      incidents: { limit, used, remaining: Math.max(0, limit - used) },
      stepCap: LB06_LIMITS.stepCap,
      maxConcurrentIncidents: LB06_LIMITS.maxConcurrentIncidents,
      maxWallMinutes: Math.round(deps.config.maxWallMs / 60_000),
      keptHours: LB06_LIMITS.keptHours,
      running: await countRunning(deps.db, moment),
      resetsAt: nextReset(moment).toISOString(),
    }
  })

  app.get('/catalogue', {
    schema: {
      tags: TAGS,
      summary: 'The faults a visitor may inject, and the curated samples',
      description: 'The four faults ("break the shop"), each with the sample that shows it: a fault with a fixed seed from the golden set, whose incident replays the same way every time. Starting one takes the visitor\'s incident of the day.',
      response: { 200: lb06CatalogueViewSchema, ...errors.unauthorized },
    },
  }, async () => catalogueView(deps.samples, deps.config.tickMs))
}
