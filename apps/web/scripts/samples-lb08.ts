// Makes `shared/data/samples/lb08.ts`, the curated processes LB-08's demo opens on, from the golden
// set's cases that name a sample (evals/lb08/golden.yaml) and the sample file those cases point to
// (data/seed/lb08/samples.yaml). One source means the demo shows exactly what the evals check, and
// a sample cannot be added to the demo without being graded. Each sample's workflow and test order
// are checked here with the same rules the service applies, so a sample the service would refuse
// to start with is never written into the demo.
//
//   node scripts/samples-lb08.ts            write the file (`pnpm --filter @lb/web samples`)
//   node scripts/samples-lb08.ts --check    fail when the file is stale (`pnpm check`, which CI runs)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { triggerPayloadSchema, validateWorkflow, valuesSchema, workflowGraphSchema } from '@lb/contracts'
import type { TriggerEventId, Values } from '@lb/contracts'
import { parse } from 'yaml'
import { z } from 'zod'

/** Resolves a path relative to this script's folder. */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

const GOLDEN_FILE = here('../../../evals/lb08/golden.yaml')
const SAMPLES_FILE = here('../../../data/seed/lb08/samples.yaml')
const OUTPUT_FILE = here('../shared/data/samples/lb08.ts')

// The part of a golden case the demo needs: its ID and the sample it takes its description from.
const goldenSchema = z.object({
  cases: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    sample: z.string().regex(/^[a-z0-9-]{1,60}$/).optional(),
  })).min(1),
})

// The sample file, as the service reads it.
const sampleFileSchema = z.object({
  samples: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    title: z.string().min(3).max(80),
    language: z.enum(['en', 'cs']),
    description: z.string().trim().min(10).max(1_000),
    input: valuesSchema,
    graph: workflowGraphSchema,
  })).min(2),
})

/** One sample as the demo holds it. */
interface Sample {
  id: string
  goldenCase: string
  language: 'en' | 'cs'
  title: string
  description: string
  event: TriggerEventId
  input: Values
}

/** Collapses a folded description onto one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Reads the golden set's samples and the sample file, checks every workflow and test order, and returns the samples in the golden set's order. */
function readSamples(): Sample[] {
  const golden = goldenSchema.parse(parse(readFileSync(GOLDEN_FILE, 'utf8')))
  const { samples } = sampleFileSchema.parse(parse(readFileSync(SAMPLES_FILE, 'utf8')))
  const chosen = golden.cases.flatMap(item => (item.sample === undefined ? [] : [{ goldenCase: item.id, sample: item.sample }]))
  const problems: string[] = []
  const found = chosen.flatMap(({ goldenCase, sample: id }): Sample[] => {
    const sample = samples.find(candidate => candidate.id === id)
    if (!sample) {
      problems.push(`The golden case ${goldenCase} names the sample ${id}, which the sample file does not have.`)
      return []
    }
    const checked = validateWorkflow(sample.graph)
    if (!checked.ok) problems.push(`The sample ${id} does not pass validation: ${checked.issues.map(issue => issue.code).join(', ')}.`)
    const trigger = sample.graph.nodes.find(node => node.type === 'trigger')
    if (trigger?.type !== 'trigger') return []
    if (!triggerPayloadSchema(trigger.event).safeParse(sample.input).success) problems.push(`The sample ${id} has a test order that does not fit its ${trigger.event} event.`)
    return [{ id, goldenCase, language: sample.language, title: sample.title, description: oneLine(sample.description), event: trigger.event, input: sample.input }]
  })
  for (const sample of samples) {
    if (!chosen.some(item => item.sample === sample.id)) problems.push(`The sample ${sample.id} is not a case of the golden set, so nothing grades it.`)
  }
  if (problems.length > 0) throw new Error(problems.join('\n'))
  return found
}

/** Writes text as a TypeScript string literal in the project's style: single quotes, with the text's own escaped. */
function quote(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

/** Writes a value of a test order as a literal. */
function literal(value: string | number | boolean): string {
  return typeof value === 'string' ? quote(value) : String(value)
}

/** Writes a test order as an object literal, one field to a line. */
function renderInput(input: Values): string[] {
  return Object.entries(input).map(([name, value]) => `      ${name}: ${literal(value)},`)
}

/** Writes one sample as an object literal, one field to a line. */
function renderSample(sample: Sample): string {
  return [
    '  {',
    `    id: ${quote(sample.id)},`,
    `    goldenCase: ${quote(sample.goldenCase)},`,
    `    language: ${quote(sample.language)},`,
    `    title: ${quote(sample.title)},`,
    `    description: ${quote(sample.description)},`,
    `    event: ${quote(sample.event)},`,
    '    input: {',
    ...renderInput(sample.input),
    '    },',
    '  },',
  ].join('\n')
}

/** Writes the whole file: its header, the samples and the type of their IDs. */
function renderFile(samples: readonly Sample[]): string {
  return [
    '// GENERATED by scripts/samples-lb08.ts from the cases that name a sample in evals/lb08/golden.yaml and',
    '// the sample file they point to, data/seed/lb08/samples.yaml.',
    '// Do not edit it by hand: change those files and run `pnpm --filter @lb/web samples`.',
    '// `pnpm check` fails when this file is out of date.',
    'import type { WorkflowSample } from \'./lb08-types\'',
    '',
    '/** The curated processes LB-08\'s demo opens on, in the golden set\'s order. */',
    'export const LB08_SAMPLES = [',
    ...samples.map(renderSample),
    '] as const satisfies readonly WorkflowSample[]',
    '',
    '/** The ID of one of LB-08\'s samples, such as `wholesale-order`. */',
    'export type Lb08SampleId = (typeof LB08_SAMPLES)[number][\'id\']',
    '',
  ].join('\n')
}

const expected = renderFile(readSamples())

if (process.argv.includes('--check')) {
  const current = existsSync(OUTPUT_FILE) ? readFileSync(OUTPUT_FILE, 'utf8') : ''
  if (current !== expected) {
    console.error('apps/web/shared/data/samples/lb08.ts is out of date with evals/lb08/golden.yaml and data/seed/lb08/samples.yaml. Run `pnpm --filter @lb/web samples` and commit the result.')
    process.exit(1)
  }
  console.log('LB-08\'s samples are up to date.')
}
else {
  writeFileSync(OUTPUT_FILE, expected)
  console.log(`Wrote ${OUTPUT_FILE}.`)
}
