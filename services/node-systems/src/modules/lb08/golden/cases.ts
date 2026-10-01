// LB-08's golden set: plain-language descriptions with the structure a correct workflow
// must have, written before any prompt (docs/PLAYBOOK.md, step 3). It lives in
// evals/lb08/golden.yaml, is read strictly (an unknown field is an error) and is graded
// by rules alone, never by a model.
//
// Three kinds of case:
// - `build`: an ordinary process. A correct answer is a workflow that satisfies the
//   case's rules. Each case carries a hand-written `reference` workflow that meets them,
//   so the tests prove the rules can be met. A case marked with a `sample` takes its
//   description, language and workflow from that curated sample (data/seed/lb08/samples.yaml).
// - `reject`: an impossible or unsafe request (a connector that doesn't exist, a loop, an
//   endless fan-out, a real URL, a script). Validation must refuse it, so no workflow is
//   stored. `attempt` is the graph a model following the request would write, and the
//   tests prove validation refuses it for the listed reasons.
// - `resist`: a description carrying an injection. The system may build the workflow the
//   description legitimately asks for, or refuse it, but must not do what the injection
//   says. `complies` is a valid workflow that obeys the injection: the tests prove the
//   rules catch it.
import { issueCodes, workflowGraphSchema } from '@lb/contracts'
import type { IssueCode, WorkflowGraph } from '@lb/contracts'
import { z } from 'zod'

import { readDataFile } from '../../../core/data-files.ts'
import type { Sample } from '../data/samples.ts'
import { expectationSchema, problemsInExpectation } from './expectations.ts'
import type { Expectation } from './expectations.ts'

// Stable names such as `wholesale-order-over-500`.
const key = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60)
const language = z.enum(['en', 'cs'])
const description = z.string().trim().min(10).max(1_000)

/** An ordinary process. A sample supplies its own description, language and reference. */
const buildCaseSchema = z.strictObject({
  id: key,
  kind: z.literal('build'),
  sample: key.optional(),
  language: language.optional(),
  description: description.optional(),
  reference: workflowGraphSchema.optional(),
  expect: expectationSchema,
}).refine((entry) => {
  const own = [entry.language, entry.description, entry.reference]
  return entry.sample === undefined ? own.every(field => field !== undefined) : own.every(field => field === undefined)
}, 'a case is either a sample, or has its own language, description and reference')

/** An impossible or unsafe request that validation must refuse. */
const rejectCaseSchema = z.strictObject({
  id: key,
  kind: z.literal('reject'),
  language,
  description,
  expect: z.strictObject({ rejects: z.array(z.enum(issueCodes)).min(1).max(4) }),
  // What a model that did as it was asked would write. It breaks the rules on purpose,
  // so it is held as plain data and not checked by the workflow schema.
  attempt: z.record(z.string(), z.unknown()),
})

/** A description with an injection in it. */
const resistCaseSchema = z.strictObject({
  id: key,
  kind: z.literal('resist'),
  language,
  description,
  expect: expectationSchema,
  reference: workflowGraphSchema,
  complies: workflowGraphSchema,
}).refine(entry => entry.expect.forbidConnectors !== undefined || entry.expect.forbidText !== undefined, 'a case about an injection must forbid what the injection asks for')

/** The whole golden.yaml, before samples are resolved. */
export const goldenFileSchema = z.strictObject({
  cases: z.array(z.discriminatedUnion('kind', [buildCaseSchema, rejectCaseSchema, resistCaseSchema])).min(20).max(50),
})

/** An ordinary process, with everything a grade needs. */
export interface BuildCase {
  kind: 'build'
  id: string
  language: 'en' | 'cs'
  description: string
  expect: Expectation
  reference: WorkflowGraph
  // Whether the live demo opens on it.
  sample: boolean
}

/** An impossible or unsafe request. */
export interface RejectCase {
  kind: 'reject'
  id: string
  language: 'en' | 'cs'
  description: string
  rejects: IssueCode[]
  attempt: Record<string, unknown>
}

/** A description with an injection in it. */
export interface ResistCase {
  kind: 'resist'
  id: string
  language: 'en' | 'cs'
  description: string
  expect: Expectation
  reference: WorkflowGraph
  complies: WorkflowGraph
}

/** One golden case. */
export type GoldenCase = BuildCase | RejectCase | ResistCase

/** Fills in a build case that points at a sample from that sample, and says what is missing. */
function resolveBuild(entry: z.infer<typeof buildCaseSchema>, samples: ReadonlyMap<string, Sample>, problems: string[]): BuildCase | undefined {
  if (entry.sample !== undefined) {
    const sample = samples.get(entry.sample)
    if (!sample) {
      problems.push(`${entry.id}: there is no sample called ${entry.sample}`)
      return undefined
    }
    return { kind: 'build', id: entry.id, language: sample.language, description: sample.description, expect: entry.expect, reference: sample.graph, sample: true }
  }
  if (entry.language === undefined || entry.description === undefined || entry.reference === undefined) return undefined
  return { kind: 'build', id: entry.id, language: entry.language, description: entry.description, expect: entry.expect, reference: entry.reference, sample: false }
}

/** Reads golden.yaml, resolves the cases that point at samples, and checks the set as a whole. */
export function readGoldenSet(path: string, samples: readonly Sample[]): GoldenCase[] {
  const file = readDataFile(path, goldenFileSchema)
  const samplesById = new Map(samples.map(sample => [sample.id, sample]))
  const problems: string[] = []
  const cases: GoldenCase[] = []
  for (const entry of file.cases) {
    const rules = entry.kind === 'reject' ? undefined : entry.expect
    for (const problem of rules ? problemsInExpectation(rules) : []) problems.push(`${entry.id}: ${problem}`)
    if (entry.kind === 'build') {
      const resolved = resolveBuild(entry, samplesById, problems)
      if (resolved) cases.push(resolved)
    }
    else if (entry.kind === 'reject') {
      cases.push({ kind: 'reject', id: entry.id, language: entry.language, description: entry.description, rejects: entry.expect.rejects, attempt: entry.attempt })
    }
    else {
      cases.push({ kind: 'resist', id: entry.id, language: entry.language, description: entry.description, expect: entry.expect, reference: entry.reference, complies: entry.complies })
    }
  }
  const ids = cases.map(entry => entry.id)
  if (new Set(ids).size !== ids.length) problems.push('a case id appears twice')
  const sampled = new Set(cases.flatMap(entry => (entry.kind === 'build' && entry.sample ? [entry.language] : [])))
  if (sampled.size < 2) problems.push('the curated samples must include English and Czech cases')
  const unused = samples.filter(sample => !cases.some(entry => entry.kind === 'build' && entry.sample && entry.description === sample.description))
  for (const sample of unused) problems.push(`the sample ${sample.id} has no golden case`)
  if (problems.length > 0) throw new Error(`${path} has problems:\n- ${problems.join('\n- ')}`)
  return cases
}
