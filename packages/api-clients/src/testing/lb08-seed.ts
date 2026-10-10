// The data the mock back end's LB-08 draws on, read from the files the real service is seeded
// and graded from: the curated samples (a description, a hand-written workflow and a test payload
// each), the synthetic stock list, and the golden set's descriptions, with the workflow each one
// is expected to become or the one that validation must refuse. So the mock's samples, stock and
// refusals are the real ones, and nothing about them is written out a second time.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'
import { z } from 'zod'

import { triggerPayloadSchema, validateWorkflow, valuesSchema, workflowGraphSchema } from '../../../contracts/src/index.ts'
import type { Values, WorkflowGraph } from '../../../contracts/src/index.ts'

/** One curated sample, as `data/seed/lb08/samples.yaml` writes it. */
export interface Lb08SampleSeed {
  id: string
  title: string
  language: 'en' | 'cs'
  description: string
  input: Values
  graph: WorkflowGraph
}

/** One product of the synthetic stock list. */
export interface StockSeed {
  sku: string
  name: string
  availableKg: number
  restockEtaDays: number
}

/** A golden description and what describing it comes to: a workflow, or a refusal with the graph that was refused. */
export interface Lb08GoldenSeed {
  id: string
  kind: 'build' | 'reject' | 'resist'
  description: string
  // The workflow a build case is expected to become (its reference, or its curated sample's graph).
  graph: WorkflowGraph | undefined
  // The graph a model that did as asked would write, for a case that must be refused.
  attempt: unknown
}

/** Everything the mock reads for LB-08. */
export interface Lb08Seed {
  samples: Lb08SampleSeed[]
  stock: StockSeed[]
  golden: Lb08GoldenSeed[]
}

// The repository's root, from this file: packages/api-clients/src/testing/.
const REPOSITORY_ROOT = `${resolve(import.meta.dirname, '../../../..')}/`

const sampleFileSchema = z.object({
  samples: z.array(z.object({
    id: z.string(),
    title: z.string(),
    language: z.enum(['en', 'cs']),
    description: z.string(),
    input: valuesSchema,
    graph: workflowGraphSchema,
  })),
})

const stockFileSchema = z.object({
  products: z.array(z.object({ sku: z.string(), name: z.string(), availableKg: z.number(), restockEtaDays: z.number() })),
})

const goldenFileSchema = z.object({
  cases: z.array(z.object({
    id: z.string(),
    kind: z.enum(['build', 'reject', 'resist']),
    sample: z.string().optional(),
    description: z.string().optional(),
    reference: workflowGraphSchema.optional(),
    attempt: z.unknown().optional(),
  })),
})

/** Reads and parses one YAML file of the repository. */
function readYaml(path: string): unknown {
  return parse(readFileSync(`${REPOSITORY_ROOT}${path}`, 'utf8'))
}

/** Collapses the whitespace of a folded description into single spaces, as the golden set's reader does. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Reads the curated samples and checks each workflow and payload with the same rules the service applies. */
function readSamples(): Lb08SampleSeed[] {
  const { samples } = sampleFileSchema.parse(readYaml('data/seed/lb08/samples.yaml'))
  for (const sample of samples) {
    const checked = validateWorkflow(sample.graph)
    if (!checked.ok) throw new Error(`The sample ${sample.id} does not pass validation.`)
    const trigger = sample.graph.nodes.find(node => node.type === 'trigger')
    if (trigger?.type !== 'trigger' || !triggerPayloadSchema(trigger.event).safeParse(sample.input).success) {
      throw new Error(`The sample ${sample.id} has a payload that does not fit its trigger.`)
    }
  }
  return samples.map(sample => ({ ...sample, description: oneLine(sample.description) }))
}

/** Reads the golden set into descriptions, with the workflow each should become. */
function readGolden(samples: readonly Lb08SampleSeed[]): Lb08GoldenSeed[] {
  const { cases } = goldenFileSchema.parse(readYaml('evals/lb08/golden.yaml'))
  return cases.flatMap((item): Lb08GoldenSeed[] => {
    const sample = item.sample === undefined ? undefined : samples.find(candidate => candidate.id === item.sample)
    const description = sample?.description ?? (item.description === undefined ? undefined : oneLine(item.description))
    if (description === undefined) return []
    return [{ id: item.id, kind: item.kind, description, graph: sample?.graph ?? item.reference, attempt: item.attempt }]
  })
}

/** Reads the samples, the stock list and the golden set from the repository. */
export function readLb08Seed(): Lb08Seed {
  const samples = readSamples()
  const stock = stockFileSchema.parse(readYaml('data/seed/lb08/stock.yaml')).products
  return { samples, stock, golden: readGolden(samples) }
}
