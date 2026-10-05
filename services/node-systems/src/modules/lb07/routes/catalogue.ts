// The routes that say what the system is: the bugs on offer, the visitor's day and the limits, and the
// curated samples. None costs a model call or a place.
import { lb07BugViewSchema, lb07LimitsViewSchema, lb07SampleViewSchema } from '@lb/contracts'
import { z } from 'zod'

import { visitorOf } from '../../../core/visitor-auth.ts'
import { bugViews } from '../data/bugs.ts'
import { limitsOf } from '../engine/usage.ts'
import { errors, TAGS } from './shared.ts'
import type { Lb07Services, Typed } from './shared.ts'

/** Adds the routes about the bugs, the visitor's allowance and the samples. */
export function registerCatalogueRoutes(app: Typed, services: Lb07Services): void {
  const { deps } = services

  app.get('/bugs', {
    schema: {
      tags: TAGS,
      summary: 'The bugs the staging shop can switch on',
      description: 'Six synthetic bugs, each with where a correct run finds it. The visitor chooses which are on; they travel to the shop in a token the service signs, which the agent can neither read nor change.',
      response: { 200: z.array(lb07BugViewSchema), ...errors.unauthorized },
    },
  }, async () => bugViews(deps.catalogue))

  app.get('/limits', {
    schema: {
      tags: TAGS,
      summary: 'What is left of the visitor\'s day, and the limits of the system',
      description: 'Runs started today against the daily limit (a sample counts; a run the system could not start is given back), the goal\'s length, the run time, how long a run is kept, and when the day\'s allowance starts again.',
      response: { 200: lb07LimitsViewSchema, ...errors.unauthorized },
    },
  }, async request => limitsOf(deps.db, visitorOf(request).sessionKey, deps.now()))

  app.get('/samples', {
    schema: {
      tags: TAGS,
      summary: 'The curated samples',
      description: 'Goals from the golden set with the bugs each switches on: a wrong total, an off-by-one count, missing alt text, a checkout that fails in one engine, every bug at once, a clean shop, a link out of the shop, a goal that talks to the agent. Running one live takes one of the visitor\'s runs.',
      response: { 200: z.array(lb07SampleViewSchema), ...errors.unauthorized },
    },
  }, async () => deps.samples.map(sample => ({ id: sample.id, title: sample.title, goal: sample.goal, bugs: sample.bugs })))
}
