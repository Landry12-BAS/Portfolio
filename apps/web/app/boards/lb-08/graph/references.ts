// The values a step may read, for the editor's "insert a value" and condition pickers. A step reads
// `trigger.<field>` (the test order's fields, which depend on the event) and `<step>.<field>` (what an
// earlier action step produced). The validator accepts a step's output only when that step runs on
// every path to the one that reads it, since otherwise the value might not exist; this module offers
// exactly those values, so the editor does not suggest what the validator would refuse. The
// validator stays the authority: this is a convenience, and a test checks the two agree.
import { CONNECTORS, TRIGGER_EVENTS } from '@lb/contracts'
import type { FieldKind, WorkflowGraph } from '@lb/contracts'

import { triggerEventOf } from './edit'

/** One value a step may read. */
export interface ReferenceOption {
  // The reference as it is written, such as `trigger.totalEur` or `check_stock.etaDays`.
  reference: string
  // `trigger`, or the id of the action step that produces it.
  source: string
  // The field's name, such as `totalEur`.
  field: string
  kind: FieldKind
}

/** Finds every step the trigger can reach without passing through `avoid`. */
function reachableWithout(graph: WorkflowGraph, avoid: string): Set<string> {
  const seen = new Set<string>()
  const trigger = graph.nodes.find(node => node.type === 'trigger')
  if (!trigger || trigger.id === avoid) return seen
  const queue = [trigger.id]
  seen.add(trigger.id)
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const edge of graph.edges) {
      if (edge.from === next && edge.to !== avoid && !seen.has(edge.to)) {
        seen.add(edge.to)
        queue.push(edge.to)
      }
    }
  }
  return seen
}

/** Tells whether `before` runs on every path from the trigger to `step`, so its output exists when `step` runs. */
export function alwaysRunsBefore(graph: WorkflowGraph, before: string, step: string): boolean {
  if (before === step) return false
  const reachable = reachableWithout(graph, '')
  return reachable.has(before) && reachable.has(step) && !reachableWithout(graph, before).has(step)
}

/** Lists the values the step with this id may read: the event's fields first, then the outputs of the action steps that always run before it. */
export function referencesAt(graph: WorkflowGraph, stepId: string): ReferenceOption[] {
  const options: ReferenceOption[] = Object.entries(TRIGGER_EVENTS[triggerEventOf(graph)].fields)
    .map(([field, spec]) => ({ reference: `trigger.${field}`, source: 'trigger', field, kind: spec.kind }))
  for (const node of graph.nodes) {
    if (node.type !== 'action' || !alwaysRunsBefore(graph, node.id, stepId)) continue
    for (const [field, spec] of Object.entries(CONNECTORS[node.connector].outputs)) {
      options.push({ reference: `${node.id}.${field}`, source: node.id, field, kind: spec.kind })
    }
  }
  return options
}

/** Finds one value among a step's options by its reference. */
export function findReference(options: readonly ReferenceOption[], reference: string): ReferenceOption | undefined {
  return options.find(option => option.reference === reference)
}
