// How a step looks wherever the editor draws it, canvas or outline: which icon of the LB set stands
// for it, and which kind of step it is called. A step is never told apart by colour alone: the icon
// and the kind's name always come with it.
import type { IconName } from '@lb/icons'
import type { StepStatus, WorkflowNode } from '@lb/contracts'

import type { StepKind } from './edit'

// The icon for each kind of step, from the LB set: no icon is drawn for this editor alone.
const ICONS: Readonly<Record<StepKind, IconName>> = {
  trigger: 'play',
  condition: 'filter',
  approval: 'shield',
  stock_check: 'database',
  slack_alert: 'support',
  email: 'mail',
  webhook: 'code',
  create_task: 'check',
}

// The icon for each state of a step in a run.
const STATUS_ICONS: Readonly<Record<StepStatus, IconName>> = {
  pending: 'clock',
  ready: 'clock',
  queued: 'replay',
  running: 'play',
  awaiting_approval: 'shield',
  succeeded: 'success',
  failed: 'error',
  skipped: 'close',
}

/** The kind of step a node is: its connector for an action, its type for any other. */
export function kindOf(node: WorkflowNode): StepKind {
  return node.type === 'action' ? node.connector : node.type
}

/** The icon of the LB set that stands for a step. */
export function iconFor(node: WorkflowNode): IconName {
  return ICONS[kindOf(node)]
}

/** The icon of the LB set that stands for a step's state in a run. */
export function statusIcon(status: StepStatus): IconName {
  return STATUS_ICONS[status]
}
