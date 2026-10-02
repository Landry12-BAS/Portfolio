// What the site may send to LB-08's API, and the error it gets back. The workflow a
// visitor edits is the same `workflowGraphSchema` the model's answer is checked against.
import { z } from 'zod'

import { valuesSchema } from '../runs/events.ts'
import { workflowGraphSchema } from '../workflow/graph.ts'
import { GRAPH_LIMITS, RUN_LIMITS } from '../workflow/limits.ts'
import { issueCodes } from '../workflow/validate.ts'

const nodeId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)

/**
 * Makes a workflow: by describing a process in plain language (a model writes the
 * graph, at the cost of its calls), or by picking one of the curated samples (a
 * ready-made graph, no model call).
 */
export const createWorkflowRequestSchema = z.discriminatedUnion('from', [
  z.strictObject({
    from: z.literal('description'),
    description: z.string().trim().min(10).max(GRAPH_LIMITS.maxDescriptionLength),
  }),
  z.strictObject({
    from: z.literal('sample'),
    sampleId: z.string().regex(/^[a-z0-9-]{1,60}$/),
  }),
])

/** Saves an edited graph as a new version. `baseVersion` is the version the editor started from. */
export const updateWorkflowRequestSchema = z.strictObject({
  baseVersion: z.int().min(1),
  graph: workflowGraphSchema,
})

/**
 * Starts a run of a workflow with a test payload. `failures` makes steps fail on
 * purpose: each entry says how many times an action step's connector fails before it
 * works, so the retries, the dead-letter queue and the replay can be watched.
 */
export const startRunRequestSchema = z.strictObject({
  // The version to run; the latest when absent.
  version: z.int().min(1).optional(),
  input: valuesSchema,
  failures: z.array(z.strictObject({
    nodeId,
    times: z.int().min(1).max(RUN_LIMITS.maxInjectedFailures),
  })).max(GRAPH_LIMITS.maxNodes).optional(),
})

/** A person's answer to an approval step. */
export const decisionRequestSchema = z.strictObject({
  decision: z.enum(['approved', 'rejected']),
})

/** One problem found in a graph, as the API reports it. */
export const issueSchema = z.strictObject({
  code: z.enum(issueCodes),
  path: z.string().max(120),
  message: z.string().max(400),
})

/** The error every response uses: a stable code and a sentence, never an echo of what was sent. */
export const errorBodySchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    // For a malformed request: the fields at fault, by name.
    fields: z.string().optional(),
    // For a daily limit (429): when the day's allowance starts again, as a time in UTC. The same
    // field, in the same place, as LB-05's daily limit, and the one platformErrorSchema reads.
    resets_at: z.iso.datetime().optional(),
    // For a graph that failed validation: every problem found.
    problems: z.array(issueSchema).optional(),
  }),
})

/** A request to make a workflow. */
export type CreateWorkflowRequest = z.infer<typeof createWorkflowRequestSchema>
/** A request to save an edited graph. */
export type UpdateWorkflowRequest = z.infer<typeof updateWorkflowRequestSchema>
/** A request to start a run. */
export type StartRunRequest = z.infer<typeof startRunRequestSchema>
/** A person's answer to an approval step. */
export type DecisionRequest = z.infer<typeof decisionRequestSchema>
/** The error body of every response. */
export type ErrorBody = z.infer<typeof errorBodySchema>
