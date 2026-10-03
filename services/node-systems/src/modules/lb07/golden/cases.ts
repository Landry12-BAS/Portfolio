// LB-07's golden set, read strictly from evals/lb07/golden.yaml: goals, the bugs each switches on, the
// reference plan a correct planner writes (in the closed vocabulary, checked by the same schema the
// planner's answers are), the scripted re-plans, and what a correct run comes to. The reader checks the
// set against the bug catalogue: every bug named exists, every sample has a title, and no two cases
// share an id. The golden set is also where the board's curated samples come from (apps/web's
// scripts/samples-lb07.ts), so a sample cannot exist without being graded.
import { LB07_BUG_IDS, LB07_FAILURE_CODES, LB07_LIMITS, LB07_VERDICTS, lb07BugListSchema, lb07GoalSchema, lb07PlanSchema, lb07StepSchema } from '@lb/contracts'
import type { Lb07BugId, Lb07Step } from '@lb/contracts'
import { z } from 'zod'

import { DataFileError, readDataFile } from '../../../core/data-files.ts'
import type { BugCatalogue } from '../data/bugs.ts'

// Stable names such as `coupon-double-discount`.
const key = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60)

/** What a correct run of a case comes to. */
const expectationSchema = z.strictObject({
  // The bugs a correct run finds: every bug that is on, unless the case says otherwise.
  found: z.array(z.enum(LB07_BUG_IDS)).max(LB07_BUG_IDS.length).optional(),
  verdict: z.enum(LB07_VERDICTS),
  // How many navigations out of the shop the plan provokes, each stopped and recorded.
  blocked: z.int().min(0).max(LB07_LIMITS.maxPlanSteps).default(0),
  maxReplans: z.int().min(0).max(LB07_LIMITS.maxReplans).default(0),
  // When the run is expected to end as failed, the reason.
  failure: z.enum(LB07_FAILURE_CODES).optional(),
})

const caseSchema = z.strictObject({
  id: key,
  sample: z.boolean().default(false),
  title: z.string().trim().min(3).max(80),
  goal: lb07GoalSchema,
  bugs: lb07BugListSchema,
  plan: z.array(lb07StepSchema).min(1).max(LB07_LIMITS.maxPlanSteps),
  replans: z.array(z.array(lb07StepSchema).max(LB07_LIMITS.maxPlanSteps)).max(LB07_LIMITS.maxReplans).default([]),
  expect: expectationSchema,
})

const fileSchema = z.strictObject({ cases: z.array(caseSchema).min(1).max(50) })

/** One golden case, with its expectation's defaults filled in. */
export interface GoldenCase {
  id: string
  sample: boolean
  title: string
  goal: string
  bugs: Lb07BugId[]
  plan: Lb07Step[]
  replans: Lb07Step[][]
  expect: {
    found: Lb07BugId[]
    verdict: z.infer<typeof expectationSchema>['verdict']
    blocked: number
    maxReplans: number
    failure: z.infer<typeof expectationSchema>['failure']
  }
}

/** Reads the golden set and checks it against the bug catalogue. */
export function readGoldenSet(path: string, catalogue: BugCatalogue): GoldenCase[] {
  const file = readDataFile(path, fileSchema)
  const seen = new Set<string>()
  return file.cases.map((entry) => {
    if (seen.has(entry.id)) throw new DataFileError(`${path} has two cases with the id ${entry.id}.`)
    seen.add(entry.id)
    for (const bug of entry.bugs) {
      if (!catalogue.has(bug)) throw new DataFileError(`${path}: the case ${entry.id} switches on ${bug}, which the catalogue does not have.`)
    }
    const found = entry.expect.found ?? entry.bugs
    for (const bug of found) {
      if (!entry.bugs.includes(bug)) throw new DataFileError(`${path}: the case ${entry.id} expects ${bug} to be found, but does not switch it on.`)
    }
    if (entry.replans.length > entry.expect.maxReplans) throw new DataFileError(`${path}: the case ${entry.id} scripts ${entry.replans.length} re-plans but allows ${entry.expect.maxReplans}.`)
    // The reference plan must be a plan the planner's own schema accepts.
    const checked = lb07PlanSchema.safeParse({ steps: entry.plan })
    if (!checked.success) throw new DataFileError(`${path}: the case ${entry.id} has a reference plan the plan schema refuses.`)
    return { ...entry, expect: { ...entry.expect, found } }
  })
}

/** The cases the board offers as samples, in the file's order. */
export function sampleCases(cases: readonly GoldenCase[]): GoldenCase[] {
  return cases.filter(entry => entry.sample)
}
