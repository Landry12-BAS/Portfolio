// The routes that say what the system is: the visitor's day and the limits, the sample contracts, and
// the playbook the reviews are read against. None of them costs a model call or a place.
import { lb04LimitsViewSchema, lb04PlaybookViewSchema, lb04SampleViewSchema } from '@lb/contracts'
import { z } from 'zod'

import { visitorOf } from '../../../core/visitor-auth.ts'
import { limitsOf } from '../engine/usage.ts'
import { playbookView } from '../playbook/playbook.ts'
import { errors, TAGS } from './shared.ts'
import type { Lb04Services, Typed } from './shared.ts'

/** Adds the routes about the visitor's allowance, the samples and the playbook. */
export function registerCatalogueRoutes(app: Typed, services: Lb04Services): void {
  const { deps } = services

  app.get('/limits', {
    schema: {
      tags: TAGS,
      summary: 'What is left of the visitor\'s day, and the limits of the system',
      description: 'Contracts reviewed today against the daily limit (a sample counts, a file that is refused is given back), the page and size limits, how long a contract is kept, and when the day\'s allowance starts again.',
      response: { 200: lb04LimitsViewSchema, ...errors.unauthorized },
    },
  }, async request => limitsOf(deps.db, visitorOf(request).sessionKey, deps.now()))

  app.get('/samples', {
    schema: {
      tags: TAGS,
      summary: 'The curated sample contracts',
      description: 'Synthetic contracts, one of them hostile to a reviewer, one over the page limit and one a scan, which show what a review does and what it refuses. Reviewing one live takes one of the visitor\'s places for the day.',
      response: { 200: z.array(lb04SampleViewSchema), ...errors.unauthorized },
    },
  }, async () => deps.samples.map(sample => ({ id: sample.id, title: sample.title, pages: sample.pages })))

  app.get('/playbook', {
    schema: {
      tags: TAGS,
      summary: 'The playbook the reviews are read against',
      description: 'The rules, by topic, with what each accepts and what it flags. The playbook is data the owner edits, kept outside every prompt.',
      response: { 200: lb04PlaybookViewSchema, ...errors.unauthorized },
    },
  }, async () => playbookView(deps.playbook))
}
