// What the agents write, after the server's checks: the commander's plan, a specialist's report with
// its findings and the evidence each one rests on, the ranked hypotheses, a proposal, and the
// postmortem's prose. Every schema is strict and bounded, because what fills it is a model's answer:
// a field nobody planned for, a text longer than any honest one, or an evidence reference outside
// the closed form is refused. The board draws the agents' reasoning from these shapes and never from
// raw model text.
import { z } from 'zod'

import { LB06_AGENTS, LB06_LIMITS, LB06_SERVICES, LB06_TOOLS } from './limits.ts'

/**
 * A reference to a piece of evidence the server holds: a metric's divergence, a log signature, a
 * deploy, a flag or an event. The server checks each one exists; a reference it does not hold is
 * dropped and counted.
 */
export const lb06EvidenceRefSchema = z.string().regex(/^(?:metric|log|deploy|flag|event):[\w.:-]{1,80}$/)
/** One evidence reference. */
export type Lb06EvidenceRef = z.infer<typeof lb06EvidenceRefSchema>

/** The causes an incident can have, as the hypotheses name them. `unknown` is allowed so a model never has to invent one. */
export const LB06_CAUSES = ['bad_deploy', 'slow_provider', 'memory_leak', 'cache_stampede', 'overload', 'unknown'] as const
/** One cause. */
export type Lb06Cause = (typeof LB06_CAUSES)[number]

/** The commander's plan: which specialist to ask what. Three questions at most, one per specialist. */
export const lb06PlanSchema = z.strictObject({
  questions: z.array(z.strictObject({
    agent: z.enum(['logs', 'metrics', 'deploys']),
    question: z.string().trim().min(1).max(200),
  })).min(1).max(3),
})
/** A plan. */
export type Lb06Plan = z.infer<typeof lb06PlanSchema>

/** One thing a specialist found, and the evidence it rests on. */
export const lb06FindingSchema = z.strictObject({
  text: z.string().trim().min(1).max(240),
  evidence: z.array(lb06EvidenceRefSchema).max(LB06_LIMITS.maxEvidencePerHypothesis),
})

/** A specialist's report after its tool calls: its findings, each with verified evidence. */
export const lb06SpecialistReportSchema = z.strictObject({
  agent: z.enum(['logs', 'metrics', 'deploys']),
  findings: z.array(lb06FindingSchema).max(5),
  // The tool calls the specialist made, as the server ran them: the tool, the arguments and how many rows came back.
  toolCalls: z.array(z.strictObject({
    tool: z.enum(LB06_TOOLS),
    args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    rows: z.int().min(0).max(LB06_LIMITS.maxToolRows),
  })).max(4),
})
/** A specialist's report. */
export type Lb06SpecialistReport = z.infer<typeof lb06SpecialistReportSchema>

/** One hypothesis the commander ranks: a service, a cause, how sure, in a sentence, with its evidence. */
export const lb06HypothesisSchema = z.strictObject({
  id: z.string().regex(/^h[1-5]$/),
  service: z.enum(LB06_SERVICES),
  cause: z.enum(LB06_CAUSES),
  confidence: z.number().min(0).max(1),
  summary: z.string().trim().min(1).max(240),
  evidence: z.array(lb06EvidenceRefSchema).max(LB06_LIMITS.maxEvidencePerHypothesis),
})
/** A hypothesis. */
export type Lb06Hypothesis = z.infer<typeof lb06HypothesisSchema>

/** The prose of a postmortem, written by a model and checked to reference only events the log holds. */
export const lb06PostmortemProseSchema = z.strictObject({
  summary: z.string().trim().min(1).max(600),
  rootCause: z.string().trim().min(1).max(400),
  whatWentWell: z.string().trim().min(1).max(400),
  actionItems: z.array(z.string().trim().min(1).max(160)).min(1).max(4),
  // The kinds of event the prose rests on: each must be in the log.
  references: z.array(z.string().regex(/^[a-z]+\.[a-z_]+$/)).min(1).max(12),
})
/** A postmortem's prose. */
export type Lb06PostmortemProse = z.infer<typeof lb06PostmortemProseSchema>

/** The agents, for the board's labels. */
export const LB06_AGENT_LIST = LB06_AGENTS
