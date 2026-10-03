// What the site may send to LB-06's API, and what it gets back: the catalogue of faults and samples,
// the visitor's limits, an incident and its state, a page of its events, and its postmortem. Every
// schema is strict and bounded, so a field nobody planned for, or an answer larger than any honest
// one, is refused by the board as it is by the service.
import { z } from 'zod'

import { lb06ActionSchema } from './actions.ts'
import { lb06PostmortemProseSchema } from './agents.ts'
import { lb06BurnSchema, lb06EventSchema, lb06FaultParamsSchema, lb06ProposalId, lb06ScenarioSchema, lb06SloSchema } from './events.ts'
import { LB06_END_REASONS, LB06_FAULTS, LB06_LIMITS, LB06_STATES } from './limits.ts'

const sampleId = z.string().regex(/^[a-z0-9-]{1,60}$/)
const minute = z.int().min(0).max(LB06_LIMITS.maxSeriesMinutes)

/** Starts an incident: one of the curated samples (a fault with its seed, no model call until its agents run), or a fault of the visitor's own with an optional seed and parameters. */
export const lb06StartIncidentRequestSchema = z.discriminatedUnion('from', [
  z.strictObject({ from: z.literal('sample'), sampleId }),
  z.strictObject({
    from: z.literal('custom'),
    fault: z.enum(LB06_FAULTS),
    seed: z.int().min(0).max(2_147_483_647).optional(),
    params: lb06FaultParamsSchema.optional(),
  }),
])
/** A request to start an incident. */
export type Lb06StartIncidentRequest = z.infer<typeof lb06StartIncidentRequestSchema>

/** The visitor's answer to the pending proposal. */
export const lb06DecisionRequestSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
})
/** A decision. */
export type Lb06DecisionRequest = z.infer<typeof lb06DecisionRequestSchema>

/** The proposal waiting for the visitor, with the blast radius the server words from the action. */
export const lb06PendingProposalSchema = z.strictObject({
  id: lb06ProposalId,
  hypothesisId: z.string().regex(/^h[1-5]$/),
  action: lb06ActionSchema,
  rationale: z.string().min(1).max(300),
})
/** A pending proposal. */
export type Lb06PendingProposal = z.infer<typeof lb06PendingProposalSchema>

/** An incident as the API shows it: its scenario, where it stands, what it has cost, and what waits for the visitor. */
export const lb06IncidentViewSchema = z.strictObject({
  id: z.uuid(),
  // The run its trace is under: the incident's own id, so the Scope can follow it from the first answer.
  runId: z.uuid(),
  origin: z.enum(['sample', 'custom']),
  sampleId: sampleId.nullable(),
  scenario: lb06ScenarioSchema,
  state: z.enum(LB06_STATES),
  endReason: z.enum(LB06_END_REASONS).nullable(),
  // The simulated minute the incident has reached, and the minute the fault struck.
  minute,
  faultMinute: minute,
  // What the injection screen said of the visitor's parameters: nothing to check, clean, flagged (and replaced), or unchecked (the guard could not be reached).
  guard: z.enum(['not_needed', 'clean', 'flagged', 'unchecked']),
  modelCalls: z.int().min(0).max(LB06_LIMITS.stepCap),
  // Whether the agents' work came from the cache of an earlier run of the same scenario, at no model call.
  cached: z.boolean(),
  proposalsMade: z.int().min(0).max(LB06_LIMITS.maxProposals),
  pendingProposal: lb06PendingProposalSchema.nullable(),
  remediations: z.array(z.strictObject({ minute, action: lb06ActionSchema })).max(LB06_LIMITS.maxProposals),
  slo: lb06SloSchema.nullable(),
  healthyStreak: z.int().min(0).max(LB06_LIMITS.maxSeriesMinutes),
  alertMinute: minute.nullable(),
  recoveredMinute: minute.nullable(),
  // The number of the last event in the log, so a reader knows what it has missed.
  lastSeq: z.int().min(0).max(LB06_LIMITS.maxEvents),
  createdAt: z.iso.datetime(),
  // When the incident is ended whatever its state, and when it is deleted.
  deadlineAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
})
/** An incident view. */
export type Lb06IncidentView = z.infer<typeof lb06IncidentViewSchema>

/** A page of an incident's events, after a number, with where the incident stands. */
export const lb06EventsPageSchema = z.strictObject({
  events: z.array(lb06EventSchema).max(200),
  // The number of the last event in the page, or the number asked for when there is none.
  cursor: z.int().min(0).max(LB06_LIMITS.maxEvents),
  // Whether more events follow the page.
  more: z.boolean(),
  state: z.enum(LB06_STATES),
})
/** A page of events. */
export type Lb06EventsPage = z.infer<typeof lb06EventsPageSchema>

/** The postmortem: the timeline the server built from the log, and the prose a model wrote over it (null when none could be trusted). */
export const lb06PostmortemViewSchema = z.strictObject({
  incidentId: z.uuid(),
  timeline: z.array(z.strictObject({
    seq: z.int().min(1).max(LB06_LIMITS.maxEvents),
    minute,
    kind: z.string().regex(/^[a-z]+\.[a-z_]+$/),
    detail: z.string().max(300),
  })).max(60),
  prose: lb06PostmortemProseSchema.nullable(),
  modelCalls: z.int().min(0).max(LB06_LIMITS.stepCap),
  proposals: z.int().min(0).max(LB06_LIMITS.maxProposals),
  recoveredMinute: minute.nullable(),
})
/** A postmortem view. */
export type Lb06PostmortemView = z.infer<typeof lb06PostmortemViewSchema>

/** What is left of the visitor's day, and the system's limits. */
export const lb06LimitsViewSchema = z.strictObject({
  incidents: z.strictObject({ limit: z.int().min(1), used: z.int().min(0), remaining: z.int().min(0) }),
  stepCap: z.literal(LB06_LIMITS.stepCap),
  maxConcurrentIncidents: z.literal(LB06_LIMITS.maxConcurrentIncidents),
  maxWallMinutes: z.int().min(1),
  keptHours: z.literal(LB06_LIMITS.keptHours),
  // How many incidents the service is running right now, across every visitor.
  running: z.int().min(0),
  resetsAt: z.iso.datetime(),
})
/** A limits view. */
export type Lb06LimitsView = z.infer<typeof lb06LimitsViewSchema>

/** One curated sample: a fault with its seed, from the golden set. */
export const lb06SampleViewSchema = z.strictObject({
  id: sampleId,
  fault: z.enum(LB06_FAULTS),
  seed: z.int().min(0).max(2_147_483_647),
  goldenCase: sampleId,
})
/** A sample view. */
export type Lb06SampleView = z.infer<typeof lb06SampleViewSchema>

/** The catalogue: the faults, with the sample that shows each, and the words the board needs about the shop. */
export const lb06CatalogueViewSchema = z.strictObject({
  faults: z.array(z.strictObject({ fault: z.enum(LB06_FAULTS), service: z.string().min(1).max(20), sampleId: sampleId })).length(LB06_FAULTS.length),
  samples: z.array(lb06SampleViewSchema).min(1).max(8),
  baselineMinutes: z.int().min(1).max(60),
  tickMs: z.int().min(10).max(60_000),
})
/** A catalogue view. */
export type Lb06CatalogueView = z.infer<typeof lb06CatalogueViewSchema>

export { lb06BurnSchema }
