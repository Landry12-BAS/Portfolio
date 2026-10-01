// The workflow graph: the one Zod schema that checks the model's answer, the API payload
// and the editor form on the site. Every object is strict, so a field nobody defined is an
// error rather than something quietly dropped, and every choice (node type, connector,
// channel, endpoint) is a closed list.
//
// A graph is nodes and edges. A trigger starts the run, an action calls a connector, a
// condition sends the run down its `true` or `false` branch, and an approval waits for a
// person. The schema checks each node on its own; `validate.ts` checks what only the
// whole graph can show (no cycles, no dangling edges, references that resolve).
import { z } from 'zod'

import {
  APPROVERS,
  BRANCH_LABELS,
  COMPARISON_OPS,
  EMAIL_RECIPIENTS,
  SLACK_CHANNELS,
  TASK_BOARDS,
  triggerEventIds,
  WEBHOOK_ENDPOINTS,
} from './catalogue.ts'
import { GRAPH_LIMITS } from './limits.ts'
import { referencePattern } from './references.ts'

// `trigger` is reserved: in a reference it always means the event's payload, never a step.
const nodeId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'a lowercase id such as check_stock').refine(id => id !== 'trigger', 'trigger is a reserved word, not a step id')
const label = z.string().trim().min(1).max(GRAPH_LIMITS.maxLabelLength)
const position = z.strictObject({ x: z.number().min(-10_000).max(10_000), y: z.number().min(-10_000).max(10_000) })

/** Text that may hold {{placeholders}}, up to `maxLength` characters; `validate.ts` checks that each one resolves. */
const template = (maxLength: number) => z.string().min(1).max(maxLength)

/** What every node has: its id, the label the editor shows, and (optionally) where the editor drew it. */
const nodeBase = { id: nodeId, label, position: position.optional() }

/** The parameters of each connector. A param the connector doesn't define is an error. */
export const connectorParams = {
  stock_check: z.strictObject({
    // A product code, usually `{{trigger.sku}}`.
    sku: template(60),
    // The quantity to cover, usually `{{trigger.quantityKg}}`; without it, any stock counts.
    quantityKg: template(30).optional(),
  }),
  slack_alert: z.strictObject({
    channel: z.enum(SLACK_CHANNELS),
    message: template(GRAPH_LIMITS.maxTemplateLength),
  }),
  email: z.strictObject({
    to: z.enum(EMAIL_RECIPIENTS),
    subject: template(120),
    body: template(600),
  }),
  webhook: z.strictObject({
    endpoint: z.enum(WEBHOOK_ENDPOINTS),
    event: z.string().regex(/^[a-z][a-z0-9_.]{2,39}$/, 'an event name such as order.confirmed'),
    fields: z.record(z.string().regex(/^[a-z]\w{0,31}$/, 'a field name such as orderId'), template(200))
      .refine(fields => Object.keys(fields).length <= GRAPH_LIMITS.maxWebhookFields, `at most ${GRAPH_LIMITS.maxWebhookFields} fields`),
  }),
  create_task: z.strictObject({
    board: z.enum(TASK_BOARDS),
    title: template(120),
    priority: z.enum(['normal', 'high']).optional(),
  }),
} as const

/** The step that starts every run, with the event it listens for. A graph has exactly one. */
export const triggerNodeSchema = z.strictObject({
  ...nodeBase,
  type: z.literal('trigger'),
  event: z.enum(triggerEventIds),
})

/** A step that checks one value and sends the run down its `true` or `false` branch. */
export const conditionNodeSchema = z.strictObject({
  ...nodeBase,
  type: z.literal('condition'),
  // A reference such as `trigger.totalEur`.
  field: z.string().regex(referencePattern, 'a reference such as trigger.totalEur'),
  op: z.enum(COMPARISON_OPS),
  value: z.union([z.number(), z.string().max(60), z.boolean()]),
})

/** A step that waits until a person approves or rejects, then goes down that branch. */
export const approvalNodeSchema = z.strictObject({
  ...nodeBase,
  type: z.literal('approval'),
  approver: z.enum(APPROVERS),
  // What the person is asked, which may hold {{placeholders}}.
  message: template(GRAPH_LIMITS.maxTemplateLength),
})

/** One action step per connector, so each connector's params are checked against its own schema. */
export const actionNodeSchema = z.discriminatedUnion('connector', [
  z.strictObject({ ...nodeBase, type: z.literal('action'), connector: z.literal('stock_check'), params: connectorParams.stock_check }),
  z.strictObject({ ...nodeBase, type: z.literal('action'), connector: z.literal('slack_alert'), params: connectorParams.slack_alert }),
  z.strictObject({ ...nodeBase, type: z.literal('action'), connector: z.literal('email'), params: connectorParams.email }),
  z.strictObject({ ...nodeBase, type: z.literal('action'), connector: z.literal('webhook'), params: connectorParams.webhook }),
  z.strictObject({ ...nodeBase, type: z.literal('action'), connector: z.literal('create_task'), params: connectorParams.create_task }),
])

/** Any node of a workflow graph. */
export const workflowNodeSchema = z.discriminatedUnion('type', [
  triggerNodeSchema,
  conditionNodeSchema,
  approvalNodeSchema,
  actionNodeSchema,
])

/** A line from one step to the next. Edges that leave a condition or an approval carry a branch label. */
export const workflowEdgeSchema = z.strictObject({
  from: nodeId,
  to: nodeId,
  branch: z.enum(BRANCH_LABELS).optional(),
})

/** A whole workflow: a name, its steps and the edges between them. */
export const workflowGraphSchema = z.strictObject({
  name: z.string().trim().min(3).max(GRAPH_LIMITS.maxNameLength),
  nodes: z.array(workflowNodeSchema).min(2).max(GRAPH_LIMITS.maxNodes),
  edges: z.array(workflowEdgeSchema).min(1).max(GRAPH_LIMITS.maxEdges),
})

/** A node of a workflow graph. */
export type WorkflowNode = z.infer<typeof workflowNodeSchema>
/** The node that starts a workflow. */
export type TriggerNode = z.infer<typeof triggerNodeSchema>
/** A node that checks a value and branches. */
export type ConditionNode = z.infer<typeof conditionNodeSchema>
/** A node that waits for a person. */
export type ApprovalNode = z.infer<typeof approvalNodeSchema>
/** A node that calls a connector. */
export type ActionNode = z.infer<typeof actionNodeSchema>
/** An edge between two nodes. */
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>
/** A workflow graph that satisfies the schema (its structure is checked separately by `validateWorkflow`). */
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>
