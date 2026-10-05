// What a run has worked out and paid for so far, saved after every model call so an attempt after a
// failure resumes where the last one stopped and never pays twice: the guard's verdict, the plan and
// how the goal was read, and the bug reports. What the browser did is not here: a browser pass that
// was cut short is run again from its plan, since a half-run pass proves nothing.
import { lb07BugReportSchema, lb07StepSchema } from '@lb/contracts'
import { z } from 'zod'

/** What the guard said of the goal: flagged or not, with its score, or `unchecked` when it could not be asked. */
export const guardVerdictSchema = z.union([z.literal('unchecked'), z.strictObject({ flagged: z.boolean(), score: z.number().min(0).max(1) })])

/** The saved state of a run's agent. */
export const workingSchema = z.strictObject({
  // The model calls made so far, across attempts.
  calls: z.int().min(0).max(20),
  guard: guardVerdictSchema.optional(),
  reading: z.string().max(300).optional(),
  // The first plan, as the planner wrote it and the schema accepted it.
  plan: z.array(lb07StepSchema).max(16).optional(),
  // The bug reports the model wrote, once code has checked them.
  reports: z.array(lb07BugReportSchema).max(12).optional(),
  reportsDropped: z.int().min(0).optional(),
})

/** The saved state. */
export type Working = z.infer<typeof workingSchema>

/** A run that has paid for nothing yet. */
export function freshWorking(): Working {
  return { calls: 0 }
}
