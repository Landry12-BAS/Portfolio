// What a correct workflow must look like for one golden case, as rules over its structure.
// A rule never names a step id (the model chooses those): it names node types, connectors,
// channels, recipients and values. Every rule is checked by code, never by a model.
//
// - trigger: the event that starts the workflow.
// - connectors: each listed connector appears at least as often as it is listed.
// - forbidConnectors: none of these may appear.
// - conditions: a condition step reads one of the listed fields (`trigger.totalEur`, or an
//   output of a connector, such as `stock_check.inStock`) and, when `anyOf` is given,
//   compares it the way one of its entries says.
// - approvals, slackChannels, emailsTo, endpoints, boards, taskPriorities: each listed
//   choice is made by at least one step.
// - before: for each pair, some step of the first kind has a path to some step of the second.
// - uses: some text or condition reads the named output of the named connector.
// - bothBranches: some condition or approval has an edge for each of its two outcomes.
// - steps: how many steps there are besides the trigger.
// - forbidText: phrases that must appear nowhere in the workflow's texts, compared without
//   regard to case.
import { APPROVERS, COMPARISON_OPS, CONNECTORS, connectorIds, EMAIL_RECIPIENTS, SLACK_CHANNELS, TASK_BOARDS, TRIGGER_EVENTS, triggerEventIds, WEBHOOK_ENDPOINTS } from '@lb/contracts'
import { z } from 'zod'

/** What a step can be, for the `before` rule: a connector, or one of the two other kinds that branch. */
const stepKind = z.enum([...connectorIds, 'condition', 'approval'])

const scalar = z.union([z.number(), z.string().max(60), z.boolean()])

/** One comparison a condition may make. */
const comparison = z.strictObject({ op: z.enum(COMPARISON_OPS), value: scalar })

/** A condition the workflow must contain. */
const conditionRule = z.strictObject({
  // `trigger.<field>` or `<connector>.<output>`; the condition may read any one of them.
  fields: z.array(z.string().regex(/^[a-z_]+\.[a-zA-Z]+$/)).min(1).max(4),
  anyOf: z.array(comparison).min(1).max(4).optional(),
})

/** The rules for a workflow a correct answer must satisfy. */
export const expectationSchema = z.strictObject({
  trigger: z.enum(triggerEventIds).optional(),
  connectors: z.array(z.enum(connectorIds)).max(12).optional(),
  forbidConnectors: z.array(z.enum(connectorIds)).max(5).optional(),
  conditions: z.array(conditionRule).max(4).optional(),
  approvals: z.array(z.enum(APPROVERS)).max(4).optional(),
  slackChannels: z.array(z.enum(SLACK_CHANNELS)).max(4).optional(),
  emailsTo: z.array(z.enum(EMAIL_RECIPIENTS)).max(5).optional(),
  endpoints: z.array(z.enum(WEBHOOK_ENDPOINTS)).max(4).optional(),
  boards: z.array(z.enum(TASK_BOARDS)).max(3).optional(),
  taskPriorities: z.array(z.enum(['normal', 'high'])).max(2).optional(),
  before: z.array(z.tuple([stepKind, stepKind])).max(4).optional(),
  uses: z.array(z.strictObject({ connector: z.enum(connectorIds), field: z.string().regex(/^[a-z]+$/i) })).max(4).optional(),
  bothBranches: z.boolean().optional(),
  steps: z.strictObject({ min: z.int().min(1).max(15).optional(), max: z.int().min(1).max(15).optional() }).optional(),
  forbidText: z.array(z.string().min(3).max(60)).max(5).optional(),
}).refine(rules => Object.values(rules).some(rule => rule !== undefined), 'a case with no rules grades nothing')

/** The rules a correct workflow must satisfy. */
export type Expectation = z.infer<typeof expectationSchema>
/** One kind of step: a connector, a condition or an approval. */
export type StepKind = z.infer<typeof stepKind>

/**
 * Finds what is wrong with a rule set on its own, before any workflow is graded against
 * it: a field that no event or connector has, or a range that can't hold anything.
 */
export function problemsInExpectation(rules: Expectation): string[] {
  const problems: string[] = []
  for (const condition of rules.conditions ?? []) {
    for (const field of condition.fields) {
      const [source = '', name = ''] = field.split('.')
      if (source === 'trigger') {
        if (rules.trigger === undefined) problems.push(`${field}: name the trigger event before reading its fields`)
        else if (!(name in TRIGGER_EVENTS[rules.trigger].fields)) problems.push(`${field}: ${rules.trigger} has no such field`)
      }
      else if (!(connectorIds as readonly string[]).includes(source)) {
        problems.push(`${field}: ${source} is neither trigger nor a connector`)
      }
      else if (!(name in CONNECTORS[source as keyof typeof CONNECTORS].outputs)) {
        problems.push(`${field}: ${source} produces no such value`)
      }
    }
  }
  for (const use of rules.uses ?? []) {
    if (!(use.field in CONNECTORS[use.connector].outputs)) problems.push(`uses ${use.connector}.${use.field}: ${use.connector} produces no such value`)
  }
  const { min, max } = rules.steps ?? {}
  if (min !== undefined && max !== undefined && min > max) problems.push('steps: min is above max')
  return problems
}
