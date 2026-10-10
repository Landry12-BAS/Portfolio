// What the site may send to LB-07's API, and what it gets back: the bugs on offer, the visitor's day,
// the samples, a run with its steps as they happen, the report with its findings and bug reports, the
// generated test and the evidence. Every schema is strict and bounded, so a field nobody planned for,
// or an answer larger than any honest one, is refused by the board as it is by the service. The only
// words a model writes that reach the page are a bug report's prose and the planner's one-sentence
// reading, both bounded here and shown as text.
import { z } from 'zod'

import { LB07_BUG_IDS, LB07_ENGINES, LB07_FAILURE_CODES, LB07_FINDING_KINDS, LB07_LIMITS, LB07_SEVERITIES, LB07_STATES, LB07_STEP_STATUSES, LB07_VERDICTS } from './limits.ts'
import { lb07StepSchema } from './plan.ts'

const bugId = z.enum(LB07_BUG_IDS)
const sampleId = z.string().regex(/^[a-z0-9-]{1,60}$/)
/** Text the service wrote, or a model wrote and the service checked: bounded, and without control characters. */
const sentence = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}\p{Cf}]+$/u, 'plain text')
/** A goal in the visitor's own words: bounded, and plain. The service also runs it through its own checks. */
export const lb07GoalSchema = z.string().trim().min(3).max(LB07_LIMITS.maxGoalLength).regex(/^[^\p{Cc}\p{Cf}]+$/u, 'plain text without control characters')
/** The bugs a run switches on: a set, so a bug listed twice is a malformed request. */
export const lb07BugListSchema = z.array(bugId).max(LB07_LIMITS.maxBugsPerRun).refine(bugs => new Set(bugs).size === bugs.length, 'each bug once')

/** One switchable bug of the staging shop, as the API describes it. The board words it in its own language by the id. */
export const lb07BugViewSchema = z.strictObject({
  id: bugId,
  title: sentence(80),
  summary: sentence(300),
  // Where a correct run finds it: the kinds of finding it produces.
  surfaces: z.array(z.enum(LB07_FINDING_KINDS)).min(1).max(5),
})

/** What is left of the visitor's day, and the limits of the system. */
export const lb07LimitsViewSchema = z.strictObject({
  runs: z.strictObject({ limit: z.int().min(0), used: z.int().min(0), remaining: z.int().min(0) }),
  maxGoalLength: z.int().min(1),
  runTimeSeconds: z.int().min(1),
  keptMinutes: z.int().min(1),
  maxBugs: z.int().min(1),
  maxQueued: z.int().min(1),
  resetsAt: z.iso.datetime(),
})

/** A curated sample: a goal and the bugs it switches on, from the golden set. */
export const lb07SampleViewSchema = z.strictObject({
  id: sampleId,
  title: sentence(80),
  goal: lb07GoalSchema,
  bugs: lb07BugListSchema,
})

/** Starts a run: from a curated sample, or from the visitor's own goal and choice of bugs. */
export const lb07CreateRunRequestSchema = z.discriminatedUnion('from', [
  z.strictObject({ from: z.literal('sample'), sampleId }),
  z.strictObject({ from: z.literal('custom'), goal: lb07GoalSchema, bugs: lb07BugListSchema }),
])

/** Why a run failed: a stable code the board words itself, and a plain sentence. */
export const lb07FailureSchema = z.strictObject({
  code: z.enum(LB07_FAILURE_CODES),
  message: z.string().min(1).max(300),
})

/** One step of the plan as the run shows it: what it is, what became of it, and how long it took. */
export const lb07StepViewSchema = z.strictObject({
  index: z.int().min(0).max(LB07_LIMITS.maxPlanSteps * (LB07_LIMITS.maxReplans + 1)),
  step: lb07StepSchema,
  status: z.enum(LB07_STEP_STATUSES),
  // Which plan this step came from: 0 for the first plan, then one for each re-plan.
  plan: z.int().min(0).max(LB07_LIMITS.maxReplans),
  durationMs: z.int().min(0).nullable(),
  // A stable code for what went wrong, never the page's words: `not_found`, `ambiguous`, `timeout`, `blocked`, `expectation`.
  outcome: z.enum(['ok', 'not_found', 'ambiguous', 'timeout', 'blocked', 'expectation', 'error']).nullable(),
})

/** A run, as the board polls it: its state, its steps so far, and its place in the queue while it waits. */
export const lb07RunViewSchema = z.strictObject({
  id: z.uuid(),
  // The run's trace is under its own id, named from the first answer so the Scope can follow it.
  runId: z.uuid(),
  origin: z.enum(['sample', 'custom']),
  sampleId: sampleId.nullable(),
  // The goal as the visitor wrote it, given back to the same visitor only.
  goal: lb07GoalSchema,
  bugs: lb07BugListSchema,
  state: z.enum(LB07_STATES),
  failure: lb07FailureSchema.nullable(),
  // How many runs are ahead of this one while it is queued; null once it has started.
  queuePosition: z.int().min(0).max(LB07_LIMITS.maxQueued).nullable(),
  // The planner's one sentence on how it read the goal, once it has planned. A model's words, shown as text.
  reading: sentence(300).nullable(),
  steps: z.array(lb07StepViewSchema).max(LB07_LIMITS.maxPlanSteps * (LB07_LIMITS.maxReplans + 1)),
  replans: z.int().min(0).max(LB07_LIMITS.maxReplans),
  modelCalls: z.int().min(0).max(LB07_LIMITS.maxModelCalls),
  findings: z.int().min(0).max(LB07_LIMITS.maxFindings),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  // When the run, its findings, evidence, report and test are deleted.
  expiresAt: z.iso.datetime(),
})

/** One finding, made by code: what kind, which engine saw it, at which step, and the evidence that shows it. */
export const lb07FindingSchema = z.strictObject({
  id: z.string().regex(/^f\d{1,3}$/),
  kind: z.enum(LB07_FINDING_KINDS),
  engine: z.enum(LB07_ENGINES),
  // The step that was running when the finding was made, or null when it was found between steps.
  stepIndex: z.int().min(0).nullable(),
  // A title the code wrote, from a closed set of patterns.
  title: sentence(120),
  // What the code saw: the expected and actual text, the request's path and status, the axe rule and the elements it names. Bounded, and taken from the page, so shown as text only.
  detail: z.string().max(600),
  // The axe rule's id, for an accessibility finding.
  rule: z.string().regex(/^[a-z0-9-]{1,60}$/).nullable(),
  // The shop path the page was at.
  path: z.string().max(120).nullable(),
  evidenceIds: z.array(z.string().regex(/^e\d{1,3}$/)).max(4),
})

/** A bug report the model wrote from the findings code made: validated prose, no more. */
export const lb07BugReportSchema = z.strictObject({
  // The findings it rests on. A report that names a finding the run does not have is dropped by code.
  findingIds: z.array(z.string().regex(/^f\d{1,3}$/)).min(1).max(8),
  title: sentence(120),
  steps: z.array(sentence(200)).min(1).max(12),
  expected: sentence(400),
  actual: sentence(400),
  severity: z.enum(LB07_SEVERITIES),
})

/** What the model must answer when asked to write the bug reports. */
export const lb07ReportAnswerSchema = z.strictObject({
  reports: z.array(lb07BugReportSchema).max(12),
})
/** The model's answer with the bug reports. */
export type Lb07ReportAnswer = z.infer<typeof lb07ReportAnswerSchema>

/** What one verification pass saw: whether every step passed, and how many findings code made. */
export const lb07VerificationPassSchema = z.strictObject({
  engine: z.enum(LB07_ENGINES),
  bugsOn: z.boolean(),
  stepsPassed: z.boolean(),
  findings: z.int().min(0),
  durationMs: z.int().min(0),
})

/** The red-then-green verification of the generated test: the run itself (red, bugs on), the same plan in the second engine (bugs on), and the plan on the clean shop (green). */
export const lb07VerificationSchema = z.strictObject({
  verdict: z.enum(LB07_VERDICTS),
  red: lb07VerificationPassSchema.nullable(),
  cross: lb07VerificationPassSchema.nullable(),
  green: lb07VerificationPassSchema.nullable(),
})

/** The finished report of a run. */
export const lb07ReportSchema = z.strictObject({
  runId: z.uuid(),
  goal: lb07GoalSchema,
  bugs: lb07BugListSchema,
  reading: sentence(300).nullable(),
  findings: z.array(lb07FindingSchema).max(LB07_LIMITS.maxFindings),
  // How many findings were made beyond the ones kept.
  findingsDropped: z.int().min(0),
  reports: z.array(lb07BugReportSchema).max(12),
  // How many bug reports the model wrote that code dropped (an unknown finding, a repeated one).
  reportsDropped: z.int().min(0),
  verification: lb07VerificationSchema,
  engines: z.array(z.enum(LB07_ENGINES)).min(1).max(2),
  modelCalls: z.int().min(0).max(LB07_LIMITS.maxModelCalls),
  replans: z.int().min(0).max(LB07_LIMITS.maxReplans),
  durationMs: z.int().min(0),
})

/** The generated Playwright test: its text, and whether the verification kept it. */
export const lb07TestViewSchema = z.strictObject({
  filename: z.string().regex(/^[a-z0-9-]{1,60}\.spec\.ts$/),
  language: z.literal('typescript'),
  source: z.string().max(LB07_LIMITS.maxTestChars),
  verdict: z.enum(LB07_VERDICTS),
})

/** A piece of evidence: a screenshot as base64 PNG, or a trimmed accessibility snapshot as text. */
export const lb07EvidenceViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: z.string().regex(/^e\d{1,3}$/), kind: z.literal('screenshot'), contentType: z.literal('image/png'), base64: z.string().max(Math.ceil(LB07_LIMITS.maxScreenshotBytes / 3) * 4), stepIndex: z.int().min(0).nullable(), engine: z.enum(LB07_ENGINES) }),
  z.strictObject({ id: z.string().regex(/^e\d{1,3}$/), kind: z.literal('snapshot'), text: z.string().max(LB07_LIMITS.maxSnapshotChars), stepIndex: z.int().min(0).nullable(), engine: z.enum(LB07_ENGINES) }),
])

/** A bug on offer. */
export type Lb07BugView = z.infer<typeof lb07BugViewSchema>
/** The visitor's day. */
export type Lb07LimitsView = z.infer<typeof lb07LimitsViewSchema>
/** A curated sample. */
export type Lb07SampleView = z.infer<typeof lb07SampleViewSchema>
/** A request to start a run. */
export type Lb07CreateRunRequest = z.infer<typeof lb07CreateRunRequestSchema>
/** A step as the run shows it. */
export type Lb07StepView = z.infer<typeof lb07StepViewSchema>
/** A run as the board polls it. */
export type Lb07RunView = z.infer<typeof lb07RunViewSchema>
/** One finding. */
export type Lb07Finding = z.infer<typeof lb07FindingSchema>
/** One bug report. */
export type Lb07BugReport = z.infer<typeof lb07BugReportSchema>
/** One verification pass. */
export type Lb07VerificationPass = z.infer<typeof lb07VerificationPassSchema>
/** The verification. */
export type Lb07Verification = z.infer<typeof lb07VerificationSchema>
/** The report. */
export type Lb07Report = z.infer<typeof lb07ReportSchema>
/** The generated test. */
export type Lb07TestView = z.infer<typeof lb07TestViewSchema>
/** A piece of evidence. */
export type Lb07EvidenceView = z.infer<typeof lb07EvidenceViewSchema>
