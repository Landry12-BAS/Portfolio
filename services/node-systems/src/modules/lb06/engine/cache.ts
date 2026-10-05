// The scenario cache: the agents' work for a scenario that was run before. A curated sample is a
// fixed scenario, and the investigation reads a snapshot the clock reaches at the same minute every
// time, so its plan, reports, ranking and proposal are the same every time too: they are kept by the
// scenario's key and the prompts' version, and a later run of the sample replays them at no model
// call. The postmortem's prose depends on what was approved, so its key adds the actions applied.
import { createHash } from 'node:crypto'

import { describeAction, lb06HypothesisSchema, lb06PlanSchema, lb06PostmortemProseSchema, lb06SpecialistReportSchema } from '@lb/contracts'
import type { Lb06Action, Lb06Scenario } from '@lb/contracts'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { PROMPT_VERSION } from '../config.ts'
import type { Executor } from '../db/connection.ts'
import { scenarioCache } from '../db/schema.ts'
import { proposalAnswerSchema } from '../agents/schemas.ts'

/** The key of a scenario: a hash of its fields and the prompts' version. */
export function scenarioKey(scenario: Lb06Scenario): string {
  const text = JSON.stringify({ seed: scenario.seed, fault: scenario.fault, params: scenario.params, baselineMinutes: scenario.baselineMinutes, prompts: PROMPT_VERSION })
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

/** The stage of the postmortem's cache, by the actions applied. */
export function postmortemStage(actions: readonly Lb06Action[]): string {
  return `postmortem:${actions.map(describeAction).join('|')}`
}

/** What is cached of an investigation, and the steps it took, so a replay shows the same work. */
export const cachedInvestigationSchema = z.strictObject({
  plan: lb06PlanSchema,
  reports: z.array(lb06SpecialistReportSchema).max(3),
  hypotheses: z.array(lb06HypothesisSchema).min(1).max(5),
  proposal: proposalAnswerSchema,
  modelCalls: z.int().min(0).max(15),
})
/** A cached investigation. */
export type CachedInvestigation = z.infer<typeof cachedInvestigationSchema>

/** What is cached of a postmortem. */
export const cachedPostmortemSchema = z.strictObject({
  prose: lb06PostmortemProseSchema.nullable(),
  modelCalls: z.int().min(0).max(15),
})
/** A cached postmortem. */
export type CachedPostmortem = z.infer<typeof cachedPostmortemSchema>

/** Reads a cached stage, checked with its schema; a row that does not fit is ignored. */
async function readStage<Schema extends z.ZodType>(db: Executor, key: string, stage: string, schema: Schema): Promise<z.infer<Schema> | undefined> {
  const rows = await db.select({ payload: scenarioCache.payload }).from(scenarioCache).where(and(eq(scenarioCache.key, key), eq(scenarioCache.stage, stage))).limit(1)
  const parsed = rows[0] === undefined ? undefined : schema.safeParse(rows[0].payload)
  return parsed?.success ? (parsed.data as z.infer<Schema>) : undefined
}

/** Writes a stage, keeping the first write when two runs finish together. */
async function writeStage(db: Executor, key: string, stage: string, payload: unknown): Promise<void> {
  await db.insert(scenarioCache).values({ key, stage, payload }).onConflictDoNothing()
}

/** Reads the cached investigation of a scenario. */
export function readCachedInvestigation(db: Executor, key: string): Promise<CachedInvestigation | undefined> {
  return readStage(db, key, 'investigation', cachedInvestigationSchema)
}

/** Caches an investigation. */
export function cacheInvestigation(db: Executor, key: string, investigation: CachedInvestigation): Promise<void> {
  return writeStage(db, key, 'investigation', investigation)
}

/** Reads the cached postmortem of a scenario for the actions applied. */
export function readCachedPostmortem(db: Executor, key: string, actions: readonly Lb06Action[]): Promise<CachedPostmortem | undefined> {
  return readStage(db, key, postmortemStage(actions), cachedPostmortemSchema)
}

/** Caches a postmortem. */
export function cachePostmortem(db: Executor, key: string, actions: readonly Lb06Action[], postmortem: CachedPostmortem): Promise<void> {
  return writeStage(db, key, postmortemStage(actions), postmortem)
}
