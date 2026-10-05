// LB-06's golden set: eight incidents and what a correct run of each finds, written before any
// prompt (docs/PLAYBOOK.md, step 3). It lives in evals/lb06/golden.yaml, is read strictly (an
// unknown field is an error) and is graded by rules alone, never by a model (grade.ts).
//
// Each case is a scenario (a fault and a seed, with the visitor's parameters where the case is
// hostile), the root cause a correct commander names, the remediation it proposes first, the
// tempting action it must not propose first, and the evidence its top hypothesis cites. The reader
// also checks the set against the simulator: every remediation cures its fault and every tempting
// action does not, each fault has two cases and one sample, and no two cases share a seed.
import { LB06_CAUSES, LB06_FAULTS, LB06_LIMITS, LB06_SERVICES, lb06ActionSchema, lb06FaultParamsSchema, sameAction } from '@lb/contracts'
import type { Lb06Action, Lb06Cause, Lb06Fault, Lb06FaultParams, Lb06Scenario, Lb06Service } from '@lb/contracts'
import { z } from 'zod'

import { DataFileError, readDataFile } from '../../../core/data-files.ts'
import { isCureOf } from '../sim/faults.ts'

// Stable names such as `bad-deploy-cart`.
const key = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60)
// An expected evidence item: a full reference, or `metric:<service>` for any divergence of that service.
const expectedEvidence = z.string().regex(/^(?:metric:[a-z]+|log:[\w.]+|deploy:d\d{1,2}|flag:[\w-]+)$/)

/** One case of the golden set, as the file holds it. */
const caseSchema = z.strictObject({
  id: key,
  fault: z.enum(LB06_FAULTS),
  seed: z.int().min(0).max(2_147_483_647),
  sample: z.boolean().default(false),
  params: lb06FaultParamsSchema.default({}),
  rootCause: z.strictObject({ service: z.enum(LB06_SERVICES), cause: z.enum(LB06_CAUSES) }),
  remediation: lb06ActionSchema,
  tempting: lb06ActionSchema,
  evidence: z.array(expectedEvidence).min(2).max(6),
  hostile: z.strictObject({
    param: z.enum(['version', 'flag']),
    mustNotPropose: lb06ActionSchema,
  }).optional(),
})

/** The whole golden.yaml. */
export const goldenFileSchema = z.strictObject({
  cases: z.array(caseSchema).min(8).max(20),
})

/** One case, with everything a grade needs. */
export interface GoldenCase {
  id: string
  fault: Lb06Fault
  seed: number
  sample: boolean
  params: Lb06FaultParams
  rootCause: { service: Lb06Service, cause: Lb06Cause }
  remediation: Lb06Action
  tempting: Lb06Action
  evidence: string[]
  hostile: { param: 'version' | 'flag', mustNotPropose: Lb06Action } | undefined
}

/** The scenario an incident replays from, for a case. */
export function scenarioOf(entry: GoldenCase): Lb06Scenario {
  return { seed: entry.seed, fault: entry.fault, params: entry.params, baselineMinutes: LB06_LIMITS.baselineMinutes }
}

/** Checks the set against the simulator and its own rules, and lists what is wrong. */
function problemsOf(cases: readonly GoldenCase[]): string[] {
  const problems: string[] = []
  const seeds = new Set<number>()
  for (const entry of cases) {
    if (seeds.has(entry.seed)) problems.push(`${entry.id}: shares its seed with another case`)
    seeds.add(entry.seed)
    if (!isCureOf(entry.fault, entry.remediation)) problems.push(`${entry.id}: its remediation does not cure ${entry.fault}`)
    if (isCureOf(entry.fault, entry.tempting)) problems.push(`${entry.id}: its tempting action cures ${entry.fault}, so it is not wrong`)
    if (sameAction(entry.remediation, entry.tempting)) problems.push(`${entry.id}: the remediation and the tempting action are the same`)
    if (entry.hostile) {
      if (entry.params[entry.hostile.param] === undefined) problems.push(`${entry.id}: hostile in ${entry.hostile.param}, but that parameter is not set`)
      if (isCureOf(entry.fault, entry.hostile.mustNotPropose)) problems.push(`${entry.id}: the action the injection asks for is the cure`)
    }
  }
  for (const fault of LB06_FAULTS) {
    const ofFault = cases.filter(entry => entry.fault === fault)
    if (ofFault.length < 2) problems.push(`${fault}: fewer than two cases`)
    if (ofFault.filter(entry => entry.sample).length !== 1) problems.push(`${fault}: exactly one case must be the sample`)
  }
  if (!cases.some(entry => entry.hostile)) problems.push('no case is hostile')
  return problems
}

/** Reads the golden set strictly and checks it against the simulator. */
export function readGoldenSet(path: string): GoldenCase[] {
  const file = readDataFile(path, goldenFileSchema)
  const cases: GoldenCase[] = file.cases.map(entry => ({ ...entry, hostile: entry.hostile }))
  const problems = problemsOf(cases)
  if (problems.length > 0) throw new DataFileError(`${path} is not a usable golden set:\n- ${problems.join('\n- ')}`)
  return cases
}
