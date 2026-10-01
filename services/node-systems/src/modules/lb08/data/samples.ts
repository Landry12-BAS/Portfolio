// The curated samples the LB-08 demo opens on (data/seed/lb08/samples.yaml). Each is a
// plain-language description with a ready workflow and a test payload, so a visitor
// sees a result at once and no model call is spent. Custom descriptions are the only
// path that spends the free tiers' quota.
//
// The workflows are written by hand, not recorded from a model: the API says so
// (`origin: sample`), and the golden set grades the live model against the same
// expectations the samples meet.
import { triggerPayloadSchema, validateWorkflow, valuesSchema, workflowGraphSchema } from '@lb/contracts'
import type { Values, WorkflowGraph } from '@lb/contracts'
import { z } from 'zod'

import { readDataFile } from '../../../core/data-files.ts'

/** One curated sample, as the file writes it. */
const sampleSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,60}$/),
  title: z.string().min(3).max(80),
  language: z.enum(['en', 'cs']),
  description: z.string().trim().min(10).max(1_000),
  // The test payload the demo prefills, which must suit the workflow's trigger.
  input: valuesSchema,
  // Checked by the workflow schema, then by `validateWorkflow`, when the file is read.
  graph: workflowGraphSchema,
})

/** The whole samples file: at least one sample in each language. */
export const sampleFileSchema = z.strictObject({
  samples: z.array(sampleSchema).min(2).max(12),
})

/** A curated sample, with its workflow validated and its payload checked against the trigger's event. */
export interface Sample {
  id: string
  title: string
  language: 'en' | 'cs'
  description: string
  input: Values
  graph: WorkflowGraph
}

/** Collects what is wrong with one sample, as sentences naming the sample. */
function problemsWith(sample: z.infer<typeof sampleSchema>): string[] {
  const problems: string[] = []
  const checked = validateWorkflow(sample.graph)
  if (!checked.ok) problems.push(...checked.issues.map(issue => `${sample.id}: ${issue.path}: ${issue.message}`))
  const trigger = sample.graph.nodes.find(node => node.type === 'trigger')
  if (trigger?.type === 'trigger' && !triggerPayloadSchema(trigger.event).safeParse(sample.input).success) {
    problems.push(`${sample.id}: input doesn't fit the ${trigger.event} event's payload`)
  }
  return problems
}

/** Reads the samples file in a seed directory, checking every workflow and payload, and returns the samples in file order. */
export function readSamples(seedDirectory: string): Sample[] {
  const path = `${seedDirectory}/lb08/samples.yaml`
  const { samples } = readDataFile(path, sampleFileSchema)
  const problems = samples.flatMap(problemsWith)
  const ids = samples.map(sample => sample.id)
  if (new Set(ids).size !== ids.length) problems.push('a sample id appears twice')
  if (new Set(samples.map(sample => sample.language)).size < 2) problems.push('the samples must include English and Czech')
  if (problems.length > 0) throw new Error(`${path} has problems:\n- ${problems.join('\n- ')}`)
  return samples
}
