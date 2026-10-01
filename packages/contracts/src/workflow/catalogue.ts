// What a workflow may be made of: the events that start one, the connectors its action
// steps may call, and the fixed choices (channels, mailboxes, endpoints) a connector
// accepts. Everything here is a closed list, so a model can't invent a connector, a
// recipient or an address: anything outside the lists fails validation.
//
// The connectors are sandboxed mocks. They record what they "sent" in a table and never
// reach the network, which is why an endpoint is a name from a list and never a URL.

/** What a value in a payload or a step's output is, so conditions can compare it sensibly. */
export type FieldKind = 'text' | 'email' | 'number' | 'boolean'

/** One named value: in a trigger's payload, or in an action step's output. */
export interface FieldSpec {
  kind: FieldKind
  description: string
  // A plausible value, used for the prefilled test payload and in the model's prompt.
  example: string | number | boolean
  // Numbers: the range a payload value must fall in. Text: the longest it may be.
  min?: number
  max?: number
}

/** The ids of the events that can start a workflow. */
export const triggerEventIds = [
  'wholesale_order',
  'stock_low',
  'new_subscription',
  'refund_request',
  'customer_review',
  'daily_schedule',
  'manual',
] as const
/** One event that can start a workflow, such as `wholesale_order`. */
export type TriggerEventId = (typeof triggerEventIds)[number]

/** An event that starts a workflow, and the payload every run of it is given. */
export interface TriggerSpec {
  label: string
  fields: Readonly<Record<string, FieldSpec>>
}

const contactEmail: FieldSpec = {
  kind: 'email',
  description: 'The contact\'s email address (a sandbox .test address)',
  example: 'orders@lumen.test',
}

/** Every trigger event, with the payload fields a workflow's steps may refer to as `trigger.<field>`. */
export const TRIGGER_EVENTS: Readonly<Record<TriggerEventId, TriggerSpec>> = {
  wholesale_order: {
    label: 'A wholesale order arrives',
    fields: {
      orderId: { kind: 'text', description: 'The order number', example: 'WO-1042' },
      cafe: { kind: 'text', description: 'The café placing the order', example: 'Café Lumen' },
      contactEmail,
      totalEur: { kind: 'number', description: 'The order total in euros', example: 640, max: 100_000 },
      sku: { kind: 'text', description: 'Product code of the main item', example: 'basalt-blend-1kg' },
      quantityKg: { kind: 'number', description: 'Kilograms ordered of the main item', example: 20, max: 10_000 },
    },
  },
  stock_low: {
    label: 'A product\'s stock runs low',
    fields: {
      sku: { kind: 'text', description: 'Product code', example: 'guji-filter-1kg' },
      availableKg: { kind: 'number', description: 'Kilograms in stock now', example: 22, max: 100_000 },
      thresholdKg: { kind: 'number', description: 'The level that raised the alert', example: 30, max: 100_000 },
    },
  },
  new_subscription: {
    label: 'A customer starts a subscription',
    fields: {
      customerName: { kind: 'text', description: 'The customer\'s name', example: 'Eva Nováková' },
      contactEmail: { ...contactEmail, example: 'eva.novakova@example.test' },
      plan: { kind: 'text', description: 'The plan chosen', example: 'weekly filter' },
      monthlyEur: { kind: 'number', description: 'The monthly price in euros', example: 38, max: 10_000 },
    },
  },
  refund_request: {
    label: 'A customer asks for a refund',
    fields: {
      orderId: { kind: 'text', description: 'The order number', example: 'BB-1043' },
      customerName: { kind: 'text', description: 'The customer\'s name', example: 'Priya Nair' },
      contactEmail: { ...contactEmail, example: 'priya.nair@example.test' },
      amountEur: { kind: 'number', description: 'The amount requested in euros', example: 120, max: 100_000 },
      reason: { kind: 'text', description: 'Why they ask', example: 'Wrong grind' },
    },
  },
  customer_review: {
    label: 'A customer leaves a review',
    fields: {
      customerName: { kind: 'text', description: 'The reviewer\'s name', example: 'Tom Okafor' },
      rating: { kind: 'number', description: 'Stars from 1 to 5', example: 2, min: 1, max: 5 },
      comment: { kind: 'text', description: 'What they wrote', example: 'The bag arrived torn.', max: 400 },
    },
  },
  daily_schedule: {
    label: 'Every morning',
    fields: {
      date: { kind: 'text', description: 'Today\'s date', example: '2026-10-01' },
    },
  },
  manual: {
    label: 'Someone starts it by hand',
    fields: {
      note: { kind: 'text', description: 'A note from the person starting it', example: 'Test run', max: 200 },
    },
  },
}

/** The ids of the sandboxed connectors an action step may call. */
export const connectorIds = ['stock_check', 'slack_alert', 'email', 'webhook', 'create_task'] as const
/** One connector, such as `slack_alert`. */
export type ConnectorId = (typeof connectorIds)[number]

/** A connector: what it does, whether it changes anything, and the values it hands the next steps. */
export interface ConnectorSpec {
  label: string
  description: string
  // `read` connectors look something up; `write` connectors send something, so they go
  // through the idempotency key and the outbox.
  effect: 'read' | 'write'
  // Values later steps may refer to as `<step id>.<field>`.
  outputs: Readonly<Record<string, FieldSpec>>
}

/** The sandboxed connectors. None of them can reach the network. */
export const CONNECTORS: Readonly<Record<ConnectorId, ConnectorSpec>> = {
  stock_check: {
    label: 'Check stock',
    description: 'Looks up a product\'s stock in the roastery\'s stock list and works out a delivery estimate.',
    effect: 'read',
    outputs: {
      inStock: { kind: 'boolean', description: 'Whether the stock covers the quantity', example: true },
      availableKg: { kind: 'number', description: 'Kilograms in stock', example: 180 },
      etaDays: { kind: 'number', description: 'Days until the order can arrive', example: 2 },
      productName: { kind: 'text', description: 'The product\'s name', example: 'Basalt Blend 1 kg' },
    },
  },
  slack_alert: {
    label: 'Slack alert',
    description: 'Posts a message to one of the roastery\'s Slack channels.',
    effect: 'write',
    outputs: {
      messageId: { kind: 'text', description: 'The message\'s id in the sandbox', example: 'msg-1' },
    },
  },
  email: {
    label: 'Email',
    description: 'Sends an email to a customer or to a team mailbox.',
    effect: 'write',
    outputs: {
      messageId: { kind: 'text', description: 'The email\'s id in the sandbox', example: 'msg-1' },
    },
  },
  webhook: {
    label: 'Webhook call',
    description: 'Sends an event with a few fields to one of the business systems.',
    effect: 'write',
    outputs: {
      messageId: { kind: 'text', description: 'The call\'s id in the sandbox', example: 'msg-1' },
    },
  },
  create_task: {
    label: 'Create a task',
    description: 'Adds a task to one of the teams\' boards.',
    effect: 'write',
    outputs: {
      taskId: { kind: 'text', description: 'The task\'s id in the sandbox', example: 'task-1' },
    },
  },
}

/** The roastery's Slack channels. */
export const SLACK_CHANNELS = ['#roastery', '#purchasing', '#support', '#wholesale', '#alerts'] as const
/** Who an email may go to: the customer in the trigger's payload, or a team mailbox. */
export const EMAIL_RECIPIENTS = ['customer', 'roastery', 'purchasing', 'support', 'finance'] as const
/** The business systems a webhook call may reach, by name: never by URL. */
export const WEBHOOK_ENDPOINTS = ['erp', 'crm', 'courier', 'accounting'] as const
/** The boards a task may be added to. */
export const TASK_BOARDS = ['roasting', 'packing', 'purchasing'] as const
/** The people an approval step may ask. */
export const APPROVERS = ['roastery_manager', 'purchasing_lead', 'finance', 'support_lead'] as const
/** How a condition compares a value with its operand. */
export const COMPARISON_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'] as const
/** One comparison a condition step can make. */
export type ComparisonOp = (typeof COMPARISON_OPS)[number]

/** The labels on edges that leave a condition (`true`, `false`) or an approval (`approved`, `rejected`). */
export const BRANCH_LABELS = ['true', 'false', 'approved', 'rejected'] as const
/** One label an edge may carry. */
export type BranchLabel = (typeof BRANCH_LABELS)[number]

/** The sandbox addresses a payload may hold: every one ends in the reserved .test domain. */
export const SANDBOX_EMAIL = /^[a-z0-9][a-z0-9._+-]{0,39}@[a-z0-9][a-z0-9-]{0,39}\.test$/

/**
 * Returns the labels the edges leaving a node of this type must carry: `true` and `false`
 * for a condition, `approved` and `rejected` for an approval, and none for any other node.
 */
export function branchLabelsFor(nodeType: string): readonly BranchLabel[] {
  if (nodeType === 'condition') return ['true', 'false']
  if (nodeType === 'approval') return ['approved', 'rejected']
  return []
}
