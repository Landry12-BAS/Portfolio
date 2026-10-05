// What the runner and the service say to each other: the shapes of every request and answer of the
// runner's small HTTP API, checked with Zod on both sides. The service (the BullMQ worker) is the only
// caller; the runner is the only process that drives a browser. Nothing a visitor wrote crosses this
// boundary except inside a plan's steps, which are already in the closed vocabulary.
import { LB07_ENGINES, LB07_FINDING_KINDS, LB07_LIMITS, lb07StepSchema } from '@lb/contracts'
import { z } from 'zod'

/** How the runner may be told to open a session: which run, which engine, the signed bug token (or none for a clean shop), and the wall clock. */
export const openSessionRequestSchema = z.strictObject({
  runId: z.string().regex(/^[\w-]{8,64}$/),
  engine: z.enum(LB07_ENGINES),
  bugToken: z.string().max(1_024).nullable(),
  wallClockMs: z.int().min(1_000).max(LB07_LIMITS.runTimeMs + 60_000),
})
/** A request to open a session. */
export type OpenSessionRequest = z.infer<typeof openSessionRequestSchema>

/** The runner's answer: the session's id. */
export const openSessionResponseSchema = z.strictObject({ sessionId: z.string().regex(/^[\w-]{8,64}$/) })

/** A finding as the runner makes it: everything but the id and the evidence, which the service gives it. */
export const runnerFindingSchema = z.strictObject({
  kind: z.enum(LB07_FINDING_KINDS),
  engine: z.enum(LB07_ENGINES),
  stepIndex: z.int().min(0).nullable(),
  // Plain text, as the API that shows it requires: a title that is not is refused here, not when a visitor asks for the report.
  title: z.string().min(1).max(120).regex(/^[^\p{Cc}\p{Cf}]+$/u, 'plain text'),
  detail: z.string().max(600),
  rule: z.string().regex(/^[a-z0-9-]{1,60}$/).nullable(),
  path: z.string().max(120).nullable(),
})
/** A finding the runner made. */
export type RunnerFinding = z.infer<typeof runnerFindingSchema>

/** The outcome of one step, as a stable code. */
export const stepOutcomeSchema = z.enum(['ok', 'not_found', 'ambiguous', 'timeout', 'blocked', 'expectation', 'error'])
/** One step's outcome. */
export type StepOutcome = z.infer<typeof stepOutcomeSchema>

/** A request to run one step: which step of the plan it is (for the findings' labels), and the step. */
export const stepRequestSchema = z.strictObject({
  index: z.int().min(0).max(LB07_LIMITS.maxPlanSteps * (LB07_LIMITS.maxReplans + 1)),
  step: lb07StepSchema,
})
/** A request to run a step. */
export type StepRequest = z.infer<typeof stepRequestSchema>

/** What became of a step, and the findings made since the last answer. */
export const stepResponseSchema = z.strictObject({
  outcome: stepOutcomeSchema,
  durationMs: z.int().min(0),
  // The shop path the page is at afterwards.
  path: z.string().max(120),
  findings: z.array(runnerFindingSchema).max(LB07_LIMITS.maxFindings),
})
/** A step's answer. */
export type StepResponse = z.infer<typeof stepResponseSchema>

/** The trimmed accessibility snapshot of the page. */
export const snapshotResponseSchema = z.strictObject({ text: z.string().max(LB07_LIMITS.maxSnapshotChars), path: z.string().max(120) })
/** A screenshot of the page, as base64 PNG. */
export const screenshotResponseSchema = z.strictObject({ base64: z.string().max(Math.ceil(LB07_LIMITS.maxScreenshotBytes / 3) * 4), path: z.string().max(120) })
/** The accessibility findings of one axe run. */
export const axeResponseSchema = z.strictObject({ findings: z.array(runnerFindingSchema).max(LB07_LIMITS.maxFindings), path: z.string().max(120) })

/** What closing a session returns: the findings not yet handed over, and the sandbox's counts. */
export const closeResponseSchema = z.strictObject({
  findings: z.array(runnerFindingSchema).max(LB07_LIMITS.maxFindings),
  // Requests that left the shop's origin. Zero, or the sandbox has a hole.
  offOriginRequests: z.int().min(0),
  // Requests and navigations the sandbox stopped.
  blocked: z.int().min(0),
})
/** A session's closing answer. */
export type CloseResponse = z.infer<typeof closeResponseSchema>

/** The runner's health. */
export const healthResponseSchema = z.strictObject({
  ok: z.boolean(),
  busy: z.boolean(),
  runsServed: z.int().min(0),
  // True once the runner has served its share of runs and is about to exit for a fresh start.
  exhausted: z.boolean(),
})
/** The runner's health. */
export type HealthResponse = z.infer<typeof healthResponseSchema>

/** The runner's own error body: a code and a sentence. */
export const runnerErrorSchema = z.strictObject({ error: z.strictObject({ code: z.string().max(64), message: z.string().max(300) }) })
