// What the models may answer, checked strictly: the commander's plan, a specialist's turn (tool
// calls, or its findings), the commander's ranking with its proposal, and the postmortem's prose.
// The shapes the board sees are @lb/contracts'; these add the two forms that exist only between
// the orchestrator and the model (a turn, a ranking with a proposal).
import { LB06_LIMITS, lb06ActionSchema, lb06FindingSchema, lb06HypothesisSchema, lb06PlanSchema, lb06PostmortemProseSchema } from '@lb/contracts'
import { z } from 'zod'

import { toolCallSchema } from './tools.ts'

/** The commander's plan. */
export const planAnswerSchema = lb06PlanSchema

/** A specialist's turn: tool calls to run, or its findings when it is done. */
export const specialistTurnSchema = z.union([
  z.strictObject({ toolCalls: z.array(toolCallSchema).min(1).max(2) }),
  z.strictObject({ findings: z.array(lb06FindingSchema).max(5) }),
])
/** A specialist's turn. */
export type SpecialistTurn = z.infer<typeof specialistTurnSchema>

/** The proposal the commander makes with its ranking. */
export const proposalAnswerSchema = z.strictObject({
  hypothesisId: z.string().regex(/^h[1-5]$/),
  action: lb06ActionSchema,
  rationale: z.string().trim().min(1).max(300),
})
/** A proposal as the model wrote it. */
export type ProposalAnswer = z.infer<typeof proposalAnswerSchema>

/** The commander's ranking: the hypotheses, best first, and the one proposal. */
export const rankingAnswerSchema = z.strictObject({
  hypotheses: z.array(lb06HypothesisSchema).min(1).max(LB06_LIMITS.maxHypotheses),
  proposal: proposalAnswerSchema,
})
/** A ranking as the model wrote it. */
export type RankingAnswer = z.infer<typeof rankingAnswerSchema>

/** The postmortem's prose. */
export const postmortemAnswerSchema = lb06PostmortemProseSchema
