// The operations an editor can do to a workflow graph: add a step, remove one, change one, connect
// two steps, cut a connection, move a step on the canvas, rename the workflow. The outline and the
// canvas call these same functions, so both edit one state in one way. Every operation is pure: it
// takes a graph and returns a new one, never changing the old, so a store can compare the two,
// keep an undo history and hand the result straight to the validator.
//
// A graph made here may be invalid (an empty text, a loop): that is what the validator is for, and
// the editor shows its reasons. These functions only make sure the graph keeps the shape the
// validator can read, and that the steps they add are valid to begin with.
import { branchLabelsFor, CONNECTORS, connectorIds, TRIGGER_EVENTS } from '@lb/contracts'
import type { ActionNode, BranchLabel, ConnectorId, TriggerEventId, WorkflowEdge, WorkflowGraph, WorkflowNode } from '@lb/contracts'

/** What kind of step the editor can add: a trigger, a condition, an approval, or an action for one connector. */
export type StepKind = 'trigger' | 'condition' | 'approval' | ConnectorId

/** Every kind of step, in the order the editor offers them. */
export const STEP_KINDS: readonly StepKind[] = ['trigger', 'condition', 'approval', ...connectorIds]

/** The words a new step starts with, in the visitor's language, so a step the editor adds reads naturally. */
export interface DefaultTexts {
  // The step's label.
  label: string
  // The text of a Slack message.
  message: string
  // An email's subject.
  subject: string
  // An email's body.
  body: string
  // A task's title.
  title: string
  // What an approver is asked.
  question: string
}

/** A position on the canvas. */
export interface Point {
  x: number
  y: number
}

/** Tells whether a value is a kind of step the editor knows. */
export function isStepKind(value: unknown): value is StepKind {
  return STEP_KINDS.includes(value as StepKind)
}

/**
 * Returns an id no step of the graph has: the base, or the base with a number after it. An id is a
 * lowercase letter followed by letters, digits and underscores, at most 32 long, and `trigger` is
 * reserved, so the base is cut to leave room for the number.
 */
export function uniqueId(graph: WorkflowGraph, base: string): string {
  const taken = new Set(graph.nodes.map(node => node.id))
  const stem = base.slice(0, 28)
  if (!taken.has(stem) && stem !== 'trigger') return stem
  for (let number = 2; ; number += 1) {
    const candidate = `${stem}_${number}`
    if (!taken.has(candidate)) return candidate
  }
}

/** The event the graph's trigger listens for; manual when it has none yet. */
export function triggerEventOf(graph: WorkflowGraph): TriggerEventId {
  const trigger = graph.nodes.find(node => node.type === 'trigger')
  return trigger?.type === 'trigger' ? trigger.event : 'manual'
}

/** Builds an action step for a connector, with settings that pass the schema for any trigger. */
export function newAction(connector: ConnectorId, id: string, texts: DefaultTexts): ActionNode {
  const base = { id, type: 'action' as const, label: texts.label }
  switch (connector) {
    case 'stock_check': return { ...base, connector, params: { sku: 'basalt-blend-1kg' } }
    case 'slack_alert': return { ...base, connector, params: { channel: '#alerts', message: texts.message } }
    case 'email': return { ...base, connector, params: { to: 'support', subject: texts.subject, body: texts.body } }
    case 'webhook': return { ...base, connector, params: { endpoint: 'erp', event: 'step.done', fields: {} } }
    case 'create_task': return { ...base, connector, params: { board: 'packing', title: texts.title } }
  }
}

/** Builds a condition on the first value the trigger's event carries, which always exists and is always comparable for equality. */
function newCondition(graph: WorkflowGraph, id: string, texts: DefaultTexts): WorkflowNode {
  const fields = Object.entries(TRIGGER_EVENTS[triggerEventOf(graph)].fields)
  const [name, spec] = fields[0] ?? ['note', { kind: 'text' as const }]
  const value = spec.kind === 'number' ? 0 : spec.kind === 'boolean' ? true : ''
  return { id, type: 'condition', label: texts.label, field: `trigger.${name}`, op: 'eq', value }
}

/** Builds a step of any kind with settings that pass the schema; a condition reads from the graph's trigger. */
export function newStep(graph: WorkflowGraph, kind: StepKind, texts: DefaultTexts): WorkflowNode {
  const id = uniqueId(graph, kind)
  if (kind === 'trigger') return { id, type: 'trigger', label: texts.label, event: 'manual' }
  if (kind === 'condition') return newCondition(graph, id, texts)
  if (kind === 'approval') return { id, type: 'approval', label: texts.label, approver: 'roastery_manager', message: texts.question }
  return newAction(kind, id, texts)
}

/** Returns the first branch label an edge out of a step may still take, or undefined for a step that does not branch or has used both. */
export function nextBranch(graph: WorkflowGraph, sourceId: string): BranchLabel | undefined {
  const source = graph.nodes.find(node => node.id === sourceId)
  if (!source) return undefined
  const used = new Set(graph.edges.filter(edge => edge.from === sourceId).map(edge => edge.branch))
  return branchLabelsFor(source.type).find(label => !used.has(label))
}

/** Adds a step. With `after`, it is also connected from that step, on the next free branch when that step branches. */
export function addStep(graph: WorkflowGraph, node: WorkflowNode, after?: string): WorkflowGraph {
  const grown = { ...graph, nodes: [...graph.nodes, node] }
  if (after === undefined || !graph.nodes.some(candidate => candidate.id === after)) return grown
  const branch = nextBranch(graph, after)
  const edge: WorkflowEdge = branch === undefined ? { from: after, to: node.id } : { from: after, to: node.id, branch }
  return { ...grown, edges: [...grown.edges, edge] }
}

/** Removes a step and every edge that touches it. */
export function removeStep(graph: WorkflowGraph, id: string): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.filter(node => node.id !== id),
    edges: graph.edges.filter(edge => edge.from !== id && edge.to !== id),
  }
}

/** Replaces the step that has the same id as `node`. */
export function replaceStep(graph: WorkflowGraph, node: WorkflowNode): WorkflowGraph {
  return { ...graph, nodes: graph.nodes.map(candidate => (candidate.id === node.id ? node : candidate)) }
}

/**
 * Changes the connector of an action step. The settings start again from the new connector's
 * defaults, because the old connector's settings mean nothing to it; the id, the label and the
 * position stay.
 */
export function changeConnector(graph: WorkflowGraph, id: string, connector: ConnectorId, texts: DefaultTexts): WorkflowGraph {
  const current = graph.nodes.find(node => node.id === id)
  if (current?.type !== 'action' || !(connector in CONNECTORS)) return graph
  const next = newAction(connector, id, texts)
  return replaceStep(graph, { ...next, label: current.label, ...(current.position === undefined ? {} : { position: current.position }) })
}

/** Moves a step to a place on the canvas. */
export function moveStep(graph: WorkflowGraph, id: string, position: Point): WorkflowGraph {
  const current = graph.nodes.find(node => node.id === id)
  if (!current) return graph
  return replaceStep(graph, { ...current, position: { x: Math.round(position.x), y: Math.round(position.y) } })
}

/** Connects two steps, with a branch label when the first one branches. Connecting the same pair the same way twice changes nothing. */
export function connect(graph: WorkflowGraph, from: string, to: string, branch?: BranchLabel): WorkflowGraph {
  const resolved = branch ?? nextBranch(graph, from)
  const same = graph.edges.some(edge => edge.from === from && edge.to === to && edge.branch === resolved)
  if (same) return graph
  const edge: WorkflowEdge = resolved === undefined ? { from, to } : { from, to, branch: resolved }
  return { ...graph, edges: [...graph.edges, edge] }
}

/** Cuts the connection at a position in the graph's edge list. */
export function disconnect(graph: WorkflowGraph, index: number): WorkflowGraph {
  return { ...graph, edges: graph.edges.filter((_, position) => position !== index) }
}

/** Changes the branch label of the connection at a position; undefined takes the label off. */
export function relabel(graph: WorkflowGraph, index: number, branch: BranchLabel | undefined): WorkflowGraph {
  return {
    ...graph,
    edges: graph.edges.map((edge, position) => {
      if (position !== index) return edge
      const { branch: _old, ...rest } = edge
      return branch === undefined ? rest : { ...rest, branch }
    }),
  }
}

/** Renames the workflow. */
export function rename(graph: WorkflowGraph, name: string): WorkflowGraph {
  return { ...graph, name }
}

/** Tells whether two JSON values hold the same data, whatever order their object keys were written in. */
function equalJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => equalJson(item, b[index]))
  }
  const left = Object.entries(a)
  const right = b as Record<string, unknown>
  return left.length === Object.keys(right).length && left.every(([key, value]) => Object.hasOwn(right, key) && equalJson(value, right[key]))
}

/** Tells whether two graphs are the same workflow, step for step, including where each step sits. */
export function sameGraph(a: WorkflowGraph, b: WorkflowGraph): boolean {
  return equalJson(a, b)
}
