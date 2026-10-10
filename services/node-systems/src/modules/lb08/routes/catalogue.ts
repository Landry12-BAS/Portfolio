// The routes that tell the site what LB-08 offers, before a visitor does anything: what a
// workflow may be made of, the curated samples the demo opens on, and how much of the day's
// allowances the visitor has left.
import { buildCatalogue, catalogueViewSchema, limitsViewSchema, sampleViewSchema } from '@lb/contracts'
import type { SampleView } from '@lb/contracts'
import { z } from 'zod'

import { visitorOf } from '../../../core/visitor-auth.ts'
import type { Sample } from '../data/samples.ts'
import { limitsOf } from '../engine/usage.ts'
import { errors, TAGS } from './shared.ts'
import type { Lb08Services, Typed } from './shared.ts'

/** Describes a sample for the demo's picker: what it is, the event that starts it, and the payload to test it with. */
function sampleViewOf(sample: Sample): SampleView {
  const trigger = sample.graph.nodes.find(node => node.type === 'trigger')
  if (trigger?.type !== 'trigger') throw new Error('A validated sample always has a trigger.')
  return { id: sample.id, title: sample.title, language: sample.language, description: sample.description, event: trigger.event, input: sample.input }
}

/** Adds the catalogue, samples and limits routes. */
export function registerCatalogueRoutes(app: Typed, services: Lb08Services): void {
  const catalogue = buildCatalogue()
  const samples = services.samples.map(sampleViewOf)

  app.get('/catalogue', {
    schema: { tags: TAGS, summary: 'What a workflow may be made of', response: { 200: catalogueViewSchema, ...errors.unauthorized } },
  }, async () => catalogue)

  app.get('/samples', {
    schema: { tags: TAGS, summary: 'The curated samples the demo opens on', response: { 200: z.array(sampleViewSchema), ...errors.unauthorized } },
  }, async () => samples)

  app.get('/limits', {
    schema: { tags: TAGS, summary: 'The visitor\'s daily allowances', response: { 200: limitsViewSchema, ...errors.unauthorized } },
  }, async request => limitsOf(services.deps.db, visitorOf(request).sessionKey, services.deps.now()))
}
