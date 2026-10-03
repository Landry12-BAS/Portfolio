// The events of an incident's log: every state change of the simulator and of the incident is one,
// numbered without gaps, so an incident replays exactly from its seed and its log. The site reads
// them through the API and over the WebSocket, checked with these schemas, and the simulator's
// reducer reads the few that change the shop (the start, the ticks, the fault, a remediation).
import { z } from 'zod'

import { lb06ActionSchema } from './actions.ts'
import { lb06HypothesisSchema, lb06PlanSchema, lb06PostmortemProseSchema, lb06SpecialistReportSchema } from './agents.ts'
import { LB06_AGENTS, LB06_END_REASONS, LB06_FAULTS, LB06_LIMITS, LB06_PARAM_PATTERN, LB06_SERVICES } from './limits.ts'

const minute = z.int().min(0).max(LB06_LIMITS.maxSeriesMinutes)
const label = z.string().min(1).max(LB06_LIMITS.maxParamLength).regex(LB06_PARAM_PATTERN)

/** What a visitor may set about a fault: the label of the bad deploy, and the name of a flag the shop gains. */
export const lb06FaultParamsSchema = z.strictObject({
  version: label.optional(),
  flag: label.optional(),
})
/** A fault's parameters. */
export type Lb06FaultParams = z.infer<typeof lb06FaultParamsSchema>

/** The scenario an incident replays from: its seed, its fault, the fault's parameters and the calm minutes before it. */
export const lb06ScenarioSchema = z.strictObject({
  seed: z.int().min(0).max(2_147_483_647),
  fault: z.enum(LB06_FAULTS),
  params: lb06FaultParamsSchema,
  baselineMinutes: z.int().min(5).max(60),
})
/** A scenario. */
export type Lb06Scenario = z.infer<typeof lb06ScenarioSchema>

/** A proposal's id: `p1`, `p2`, `p3`. */
export const lb06ProposalId = z.string().regex(/^p[1-3]$/)

/** The burn rates the alert fired on, by window. */
export const lb06BurnSchema = z.strictObject({
  shortMinutes: z.int().min(1).max(60),
  longMinutes: z.int().min(1).max(60),
  shortBurn: z.number().min(0).max(1_000),
  longBurn: z.number().min(0).max(1_000),
})

/** The fields every event shares. */
const base = { seq: z.int().min(1).max(LB06_LIMITS.maxEvents), minute, at: z.iso.datetime() }

/** Makes the schema of one kind of event. */
function event<Kind extends string, Data extends z.ZodType>(kind: Kind, data: Data) {
  return z.strictObject({ ...base, kind: z.literal(kind), data })
}

/** What a specialist's tool call looked like, as the server ran it. */
const toolCall = z.strictObject({
  tool: z.enum(['query_logs', 'query_metrics', 'list_deploys']),
  args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  rows: z.int().min(0).max(LB06_LIMITS.maxToolRows),
})

/** One event of the log: its number, its kind, the simulated minute it happened at, the wall-clock moment, and its data. */
export const lb06EventSchema = z.discriminatedUnion('kind', [
  event('incident.started', lb06ScenarioSchema),
  event('tick', z.strictObject({})),
  event('fault.injected', z.strictObject({ fault: z.enum(LB06_FAULTS), service: z.enum(LB06_SERVICES) })),
  event('alert.fired', z.strictObject({ burn: lb06BurnSchema })),
  event('investigation.started', z.strictObject({ snapshotMinute: minute })),
  event('agent.step', z.strictObject({
    step: z.int().min(1).max(LB06_LIMITS.stepCap),
    agent: z.enum(LB06_AGENTS),
    kind: z.enum(['plan', 'tool_call', 'report', 'ranking', 'postmortem', 'repair']),
    // What the model said, after the server's checks; a tool call carries the call and how many rows came back.
    plan: lb06PlanSchema.optional(),
    report: lb06SpecialistReportSchema.optional(),
    toolCall: toolCall.optional(),
    // Whether this step cost a model call (a tool call the server ran costs none).
    modelCall: z.boolean(),
  })),
  event('evidence.discarded', z.strictObject({ agent: z.enum(LB06_AGENTS), count: z.int().min(1).max(100) })),
  event('hypotheses.ranked', z.strictObject({ hypotheses: z.array(lb06HypothesisSchema).min(1).max(LB06_LIMITS.maxHypotheses) })),
  event('proposal.made', z.strictObject({ proposalId: lb06ProposalId, hypothesisId: z.string().regex(/^h[1-5]$/), action: lb06ActionSchema, rationale: z.string().min(1).max(300) })),
  event('proposal.approved', z.strictObject({ proposalId: lb06ProposalId })),
  event('proposal.rejected', z.strictObject({ proposalId: lb06ProposalId })),
  event('remediation.applied', z.strictObject({ proposalId: lb06ProposalId, action: lb06ActionSchema })),
  event('slo.recovered', z.strictObject({ healthyMinutes: z.int().min(1).max(60) })),
  event('postmortem.written', z.strictObject({ prose: lb06PostmortemProseSchema.nullable(), modelCalls: z.int().min(0).max(LB06_LIMITS.stepCap) })),
  event('incident.closed', z.strictObject({ modelCalls: z.int().min(0).max(LB06_LIMITS.stepCap), proposals: z.int().min(1).max(LB06_LIMITS.maxProposals) })),
  event('incident.aborted', z.strictObject({ reason: z.enum(LB06_END_REASONS) })),
  event('incident.failed', z.strictObject({ reason: z.enum(LB06_END_REASONS) })),
])
/** One event of the log. */
export type Lb06Event = z.infer<typeof lb06EventSchema>
/** The event of one kind. */
export type Lb06EventOf<Kind extends Lb06Event['kind']> = Extract<Lb06Event, { kind: Kind }>
/** An event before it is numbered and stamped: what the engine appends. */
export type Lb06EventInput = { [Kind in Lb06Event['kind']]: { kind: Kind, minute: number, data: Lb06EventOf<Kind>['data'] } }[Lb06Event['kind']]
