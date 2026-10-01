// Deterministic validation of a workflow graph: the checks that decide whether a graph,
// whoever wrote it (a model, the API's caller or the editor), may be stored and run.
//
// Two layers answer in one list of issues. The Zod schema checks each node by itself
// (known node types, a known connector with valid params, closed lists for every choice,
// bounded size). Then structural checks look at the whole graph: exactly one trigger, no
// dangling or duplicate edges, no loops, every step reachable, branches labelled, fan-out
// bounded, and every reference in a text or a condition pointing at a value that exists
// by the time the step runs. A model is never asked whether its own graph is valid.
//
// An issue has a stable `code`, a `path` into the graph and a message written as an
// instruction, so it can be handed to a model for its one repair or shown in the editor.
// Messages never repeat a visitor's words: they name ids, fields and the allowed choices.
import type { ZodError } from 'zod'

import { branchLabelsFor, CONNECTORS, connectorIds, TRIGGER_EVENTS, triggerEventIds } from './catalogue.ts'
import type { FieldSpec } from './catalogue.ts'
import { workflowEdgeSchema, workflowGraphSchema, workflowNodeSchema } from './graph.ts'
import type { ActionNode, ApprovalNode, ConditionNode, TriggerNode, WorkflowEdge, WorkflowGraph, WorkflowNode } from './graph.ts'
import { GRAPH_LIMITS } from './limits.ts'
import { parseReference, scanTemplate } from './references.ts'

/** Every reason a graph can be refused. The codes are stable: the API, the editor and the golden set use them. */
export const issueCodes = [
  // From the schema.
  'unknown_node_type',
  'unknown_connector',
  'unknown_trigger',
  'unknown_field',
  'invalid_param',
  'invalid_value',
  'too_many_nodes',
  'too_many_edges',
  'too_few_nodes',
  'no_edges',
  // From the structure of the whole graph.
  'no_trigger',
  'multiple_triggers',
  'duplicate_node_id',
  'dangling_edge',
  'duplicate_edge',
  'trigger_has_input',
  'missing_branch',
  'wrong_branch',
  'fan_out',
  'cycle',
  'unreachable_node',
  // From the texts and the conditions of the steps.
  'template_syntax',
  'unknown_reference',
  'unavailable_reference',
  'invalid_condition',
  'recipient_unavailable',
] as const
/** One reason a graph can be refused, such as `cycle`. */
export type IssueCode = (typeof issueCodes)[number]

/** One problem found in a graph: what, where, and how to fix it. */
export interface WorkflowIssue {
  code: IssueCode
  // Where, as a dotted path such as `nodes.2.params.channel`, or `graph` for the whole.
  path: string
  message: string
}

/** The outcome of validating a graph: the typed graph, or every issue found. */
export type ValidationResult
  = | { ok: true, graph: WorkflowGraph, issues: [] }
    | { ok: false, issues: WorkflowIssue[] }

// No answer lists more problems than this: a model's repair, and a person, can only act
// on so many at once.
const MAX_ISSUES = 30
// When a graph fails the schema, the structural checks still read the nodes and edges
// that pass it. They read at most this many, so an enormous payload costs little.
const SALVAGE_NODES = GRAPH_LIMITS.maxNodes * 4
const SALVAGE_EDGES = GRAPH_LIMITS.maxEdges * 4

/**
 * Validates a graph from any source. Returns the typed graph when it passes every
 * check, otherwise every problem found, schema and structure together, so one repair
 * can fix them all.
 */
export function validateWorkflow(input: unknown): ValidationResult {
  const parsed = workflowGraphSchema.safeParse(input)
  if (parsed.success) {
    const issues = structuralIssues({ nodes: parsed.data.nodes, edges: parsed.data.edges, brokenIds: new Set() })
    return issues.length === 0 ? { ok: true, graph: parsed.data, issues: [] } : { ok: false, issues: issues.slice(0, MAX_ISSUES) }
  }
  const issues = [...issuesFromSchema(parsed.error, input), ...structuralIssues(salvage(input))]
  return { ok: false, issues: issues.slice(0, MAX_ISSUES) }
}

// ---- Schema issues ----

/** Reads the id of the node at an index of a raw graph, for messages, when it has one. */
function nodeIdAt(input: unknown, index: number): string {
  const nodes = (input as { nodes?: unknown } | null)?.nodes
  const node = Array.isArray(nodes) ? (nodes as unknown[])[index] as { id?: unknown } | undefined : undefined
  return typeof node?.id === 'string' && node.id.length <= 40 ? node.id : `#${index + 1}`
}

/** Writes a path of keys and indexes as `nodes.2.params.channel`, or `graph` when it is empty. */
function dottedPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? 'graph' : path.map(String).join('.')
}

/** Turns Zod's issues into the validator's own, with codes and instructions in place of Zod's wording. */
export function issuesFromSchema(error: ZodError, input: unknown): WorkflowIssue[] {
  return error.issues.map((zodIssue): WorkflowIssue => {
    const path = dottedPath(zodIssue.path)
    const [first, second] = zodIssue.path
    const where = first === 'nodes' && typeof second === 'number' ? `Step ${nodeIdAt(input, second)}: ` : ''
    if (zodIssue.code === 'invalid_union' && zodIssue.discriminator === 'connector') {
      return { code: 'unknown_connector', path, message: `${where}unknown connector. Use one of: ${connectorIds.join(', ')}.` }
    }
    if (zodIssue.code === 'invalid_union' && zodIssue.discriminator === 'type') {
      return { code: 'unknown_node_type', path, message: `${where}unknown node type. Use one of: trigger, action, condition, approval.` }
    }
    if (zodIssue.code === 'unrecognized_keys') {
      const keys = zodIssue.keys.slice(0, 3).map(key => key.slice(0, 30)).join(', ')
      return { code: 'unknown_field', path, message: `${where}unknown field ${keys}. Remove it.` }
    }
    if (zodIssue.code === 'invalid_value' && zodIssue.path.at(-1) === 'event') {
      return { code: 'unknown_trigger', path, message: `${where}unknown trigger event. Use one of: ${triggerEventIds.join(', ')}.` }
    }
    if (zodIssue.code === 'too_big' && path === 'nodes') {
      return { code: 'too_many_nodes', path, message: `A workflow has at most ${GRAPH_LIMITS.maxNodes} steps, the trigger included.` }
    }
    if (zodIssue.code === 'too_big' && path === 'edges') {
      return { code: 'too_many_edges', path, message: `A workflow has at most ${GRAPH_LIMITS.maxEdges} edges.` }
    }
    if (zodIssue.code === 'too_small' && path === 'nodes') {
      return { code: 'too_few_nodes', path, message: 'A workflow needs a trigger and at least one more step.' }
    }
    if (zodIssue.code === 'too_small' && path === 'edges') {
      return { code: 'no_edges', path, message: 'A workflow needs edges that connect its steps.' }
    }
    if (zodIssue.path.includes('params')) {
      return { code: 'invalid_param', path, message: `${where}${path}: ${zodIssue.message}` }
    }
    return { code: 'invalid_value', path, message: `${path}: ${zodIssue.message}` }
  })
}

// ---- What the structural checks read ----

/** The graph as the structural checks see it. After a schema failure it holds only the parts that passed. */
interface Shape {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  // Ids of nodes that failed the schema, so edges and references that mention them
  // aren't blamed for a problem the schema already reported. Empty for a complete graph.
  brokenIds: ReadonlySet<string>
}

/** Keeps the nodes and edges of a raw graph that pass the schema on their own, and notes the ids of the nodes that don't. */
function salvage(input: unknown): Shape {
  const raw = (input ?? {}) as { nodes?: unknown, edges?: unknown }
  const rawNodes: unknown[] = Array.isArray(raw.nodes) ? (raw.nodes as unknown[]).slice(0, SALVAGE_NODES) : []
  const rawEdges: unknown[] = Array.isArray(raw.edges) ? (raw.edges as unknown[]).slice(0, SALVAGE_EDGES) : []
  const nodes: WorkflowNode[] = []
  const brokenIds = new Set<string>()
  for (const rawNode of rawNodes) {
    const parsed = workflowNodeSchema.safeParse(rawNode)
    if (parsed.success) nodes.push(parsed.data)
    else if (typeof (rawNode as { id?: unknown } | null)?.id === 'string') brokenIds.add((rawNode as { id: string }).id)
    else brokenIds.add('')
  }
  const edges: WorkflowEdge[] = []
  for (const rawEdge of rawEdges) {
    const parsed = workflowEdgeSchema.safeParse(rawEdge)
    if (parsed.success) edges.push(parsed.data)
  }
  return { nodes, edges, brokenIds }
}

/** Runs every structural check and returns what they found. */
function structuralIssues(shape: Shape): WorkflowIssue[] {
  const graph = new GraphIndex(shape)
  return [
    ...checkNodeIds(shape),
    ...checkTrigger(shape),
    ...checkEdges(shape, graph),
    ...checkFanOut(shape, graph),
    ...checkLoops(shape, graph),
    ...checkReachability(shape, graph),
    ...checkTexts(shape, graph),
  ]
}

/** Lookups over a graph that several checks share: nodes by id, and who connects to whom. */
class GraphIndex {
  readonly nodesById = new Map<string, WorkflowNode>()
  readonly nodeIndex = new Map<string, number>()
  // Edges whose two ends both exist, with their position in the graph's edge list.
  readonly links: { from: string, to: string, index: number }[] = []
  readonly #shape: Shape
  readonly #reachableWithout = new Map<string, Set<string>>()

  constructor(shape: Shape) {
    this.#shape = shape
    shape.nodes.forEach((node, index) => {
      if (!this.nodesById.has(node.id)) {
        this.nodesById.set(node.id, node)
        this.nodeIndex.set(node.id, index)
      }
    })
    shape.edges.forEach((edge, index) => {
      if (this.nodesById.has(edge.from) && this.nodesById.has(edge.to)) this.links.push({ from: edge.from, to: edge.to, index })
    })
  }

  /** The trigger node, when there is exactly one. */
  get trigger(): TriggerNode | undefined {
    const triggers = this.#shape.nodes.filter((node): node is TriggerNode => node.type === 'trigger')
    return triggers.length === 1 ? triggers[0] : undefined
  }

  /** Tells whether a node failed the schema, so a problem with it was already reported. */
  isBroken(id: string): boolean {
    return this.#shape.brokenIds.has(id)
  }

  /** Tells whether every node passed the schema, so nothing the graph says is missing from the shape. */
  get complete(): boolean {
    return this.#shape.brokenIds.size === 0
  }

  /** Every step the trigger can reach, without passing through `avoid` when it is given. */
  reachable(avoid = ''): Set<string> {
    const known = this.#reachableWithout.get(avoid)
    if (known) return known
    const seen = new Set<string>()
    const start = this.trigger
    if (start && start.id !== avoid) {
      const queue = [start.id]
      seen.add(start.id)
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        for (const link of this.links) {
          if (link.from === next && link.to !== avoid && !seen.has(link.to)) {
            seen.add(link.to)
            queue.push(link.to)
          }
        }
      }
    }
    this.#reachableWithout.set(avoid, seen)
    return seen
  }

  /** Tells whether `before` runs on every path from the trigger to `step`, so its output is there when `step` runs. */
  alwaysRunsBefore(before: string, step: string): boolean {
    if (before === step) return false
    const reachable = this.reachable()
    return reachable.has(before) && reachable.has(step) && !this.reachable(before).has(step)
  }
}

// ---- Structural checks ----

/** Refuses two steps with the same id. */
function checkNodeIds(shape: Shape): WorkflowIssue[] {
  const seen = new Set<string>()
  const issues: WorkflowIssue[] = []
  shape.nodes.forEach((node, index) => {
    if (seen.has(node.id)) issues.push({ code: 'duplicate_node_id', path: `nodes.${index}.id`, message: `Two steps are called ${node.id}. Give every step its own id.` })
    seen.add(node.id)
  })
  return issues
}

/** Requires exactly one trigger. */
function checkTrigger(shape: Shape): WorkflowIssue[] {
  const triggers = shape.nodes.filter(node => node.type === 'trigger')
  if (triggers.length > 1) {
    return [{ code: 'multiple_triggers', path: 'nodes', message: 'A workflow has exactly one trigger. Keep one and remove the others.' }]
  }
  // A step the schema rejected might have been the trigger, so only a complete graph can lack one.
  if (triggers.length === 0 && shape.brokenIds.size === 0) {
    return [{ code: 'no_trigger', path: 'nodes', message: 'A workflow needs a trigger step that says what starts it.' }]
  }
  return []
}

/** Checks each edge: both ends exist, it isn't repeated, nothing leads into the trigger, and its branch label fits its source. */
function checkEdges(shape: Shape, graph: GraphIndex): WorkflowIssue[] {
  const issues: WorkflowIssue[] = []
  const seen = new Set<string>()
  shape.edges.forEach((edge, index) => {
    const path = `edges.${index}`
    const missing = [edge.from, edge.to].filter(id => !graph.nodesById.has(id) && !graph.isBroken(id))
    if (missing.length > 0) {
      issues.push({ code: 'dangling_edge', path, message: `Edge ${edge.from} to ${edge.to} refers to ${missing.join(' and ')}, which isn't a step. Connect existing steps only.` })
      return
    }
    const key = `${edge.from}>${edge.to}>${edge.branch ?? ''}`
    if (seen.has(key)) issues.push({ code: 'duplicate_edge', path, message: `Edge ${edge.from} to ${edge.to} appears twice. Remove the repeat.` })
    seen.add(key)
    if (graph.nodesById.get(edge.to)?.type === 'trigger') {
      issues.push({ code: 'trigger_has_input', path, message: `Edge ${edge.from} to ${edge.to} leads into the trigger. Nothing may lead into the trigger.` })
    }
    const source = graph.nodesById.get(edge.from)
    if (source) issues.push(...checkBranch(edge, source, path))
  })
  return issues
}

/** Checks that an edge carries a branch label exactly when its source branches, and the right one. */
function checkBranch(edge: WorkflowEdge, source: WorkflowNode, path: string): WorkflowIssue[] {
  const allowed = branchLabelsFor(source.type)
  const quoted = allowed.map(label => `"${label}"`).join(' or ')
  if (allowed.length > 0 && edge.branch === undefined) {
    return [{ code: 'missing_branch', path, message: `Edge ${edge.from} to ${edge.to} leaves a ${source.type} step, so it needs branch ${quoted}.` }]
  }
  if (edge.branch !== undefined && !(allowed as readonly string[]).includes(edge.branch)) {
    const rule = allowed.length === 0 ? 'only condition and approval steps have branches' : `use ${quoted} here`
    return [{ code: 'wrong_branch', path, message: `Edge ${edge.from} to ${edge.to} has branch "${edge.branch}": ${rule}.` }]
  }
  return []
}

/** Refuses a step with more outgoing edges than the fan-out limit. */
function checkFanOut(shape: Shape, graph: GraphIndex): WorkflowIssue[] {
  const issues: WorkflowIssue[] = []
  for (const node of shape.nodes) {
    const outgoing = graph.links.filter(link => link.from === node.id).length
    if (outgoing > GRAPH_LIMITS.maxFanOut) {
      issues.push({ code: 'fan_out', path: `nodes.${graph.nodeIndex.get(node.id) ?? 0}`, message: `Step ${node.id} leads to ${outgoing} steps. At most ${GRAPH_LIMITS.maxFanOut} may follow one step.` })
    }
  }
  return issues
}

/** Finds the edges that close a loop. A workflow is a DAG, so every run takes a bounded number of steps. */
function checkLoops(shape: Shape, graph: GraphIndex): WorkflowIssue[] {
  // Absent: not visited yet. 1: on the path being explored. 2: finished.
  const state = new Map<string, 1 | 2>()
  const closing: number[] = []
  const visit = (id: string): void => {
    state.set(id, 1)
    for (const link of graph.links.filter(candidate => candidate.from === id)) {
      const seen = state.get(link.to)
      if (seen === 1) closing.push(link.index)
      else if (seen === undefined) visit(link.to)
    }
    state.set(id, 2)
  }
  for (const node of shape.nodes) {
    if (!state.has(node.id)) visit(node.id)
  }
  return closing.sort((a, b) => a - b).map((index): WorkflowIssue => {
    const edge = shape.edges[index]
    return { code: 'cycle', path: `edges.${index}`, message: `Edge ${edge?.from ?? '?'} to ${edge?.to ?? '?'} closes a loop. Workflows can't loop or repeat: remove this edge.` }
  })
}

/** Requires every step to be reachable from the trigger. */
function checkReachability(shape: Shape, graph: GraphIndex): WorkflowIssue[] {
  if (!graph.trigger || !graph.complete) return []
  const reachable = graph.reachable()
  const issues: WorkflowIssue[] = []
  for (const node of shape.nodes) {
    if (!reachable.has(node.id)) {
      issues.push({ code: 'unreachable_node', path: `nodes.${graph.nodeIndex.get(node.id) ?? 0}`, message: `Step ${node.id} can't be reached from the trigger. Connect it, or remove it.` })
    }
  }
  return issues
}

// ---- Texts, conditions and recipients ----

/** One piece of text in a step that may hold {{placeholders}}, and where it is. */
interface TextSlot {
  path: string
  text: string
}

/** Lists the texts of a step that may hold placeholders. */
function textsOf(node: ActionNode | ApprovalNode): TextSlot[] {
  if (node.type === 'approval') return [{ path: 'message', text: node.message }]
  switch (node.connector) {
    case 'stock_check':
      return [{ path: 'params.sku', text: node.params.sku }, ...(node.params.quantityKg === undefined ? [] : [{ path: 'params.quantityKg', text: node.params.quantityKg }])]
    case 'slack_alert':
      return [{ path: 'params.message', text: node.params.message }]
    case 'email':
      return [{ path: 'params.subject', text: node.params.subject }, { path: 'params.body', text: node.params.body }]
    case 'webhook':
      return Object.entries(node.params.fields).map(([name, text]) => ({ path: `params.fields.${name}`, text }))
    case 'create_task':
      return [{ path: 'params.title', text: node.params.title }]
  }
}

/** What looking up a reference found: the field it names, a problem with it, or nothing to check. */
type Resolved
  = | { field: FieldSpec }
    | { problem: { code: IssueCode, message: string } }
    | { skipped: true }

/** Looks up the field a reference points at, or explains why it points at nothing usable. */
function resolveReference(reference: string, user: WorkflowNode, graph: GraphIndex): Resolved {
  const parsed = parseReference(reference)
  if (!parsed) {
    return { problem: { code: 'unknown_reference', message: `"${reference.slice(0, 40)}" isn't a reference. Write trigger.field or step_id.field.` } }
  }
  if (parsed.source === 'trigger') {
    const event = graph.trigger?.event
    if (event === undefined) return graph.complete ? { problem: { code: 'unknown_reference', message: `${reference} needs a trigger step.` } } : { skipped: true }
    const field = TRIGGER_EVENTS[event].fields[parsed.field]
    if (!field) {
      const known = Object.keys(TRIGGER_EVENTS[event].fields).join(', ')
      return { problem: { code: 'unknown_reference', message: `${reference} isn't in the ${event} event's payload. Its fields are: ${known}.` } }
    }
    return { field }
  }
  if (graph.isBroken(parsed.source)) return { skipped: true }
  const source = graph.nodesById.get(parsed.source)
  if (!source || source.type !== 'action') {
    return { problem: { code: 'unknown_reference', message: `${reference} refers to ${parsed.source}, which isn't an action step. Only the trigger and action steps have values.` } }
  }
  const field = CONNECTORS[source.connector].outputs[parsed.field]
  if (!field) {
    const known = Object.keys(CONNECTORS[source.connector].outputs).join(', ')
    return { problem: { code: 'unknown_reference', message: `${reference}: a ${source.connector} step produces ${known}, not ${parsed.field}.` } }
  }
  if (!graph.alwaysRunsBefore(source.id, user.id)) {
    return { problem: { code: 'unavailable_reference', message: `${reference} may not exist when ${user.id} runs: ${source.id} isn't on every path to it. Use a value from the trigger, or from a step that always runs first.` } }
  }
  return { field }
}

/** Checks every placeholder in the texts of an action or approval step. */
function checkTemplates(node: ActionNode | ApprovalNode, index: number, graph: GraphIndex): WorkflowIssue[] {
  const issues: WorkflowIssue[] = []
  for (const slot of textsOf(node)) {
    const path = `nodes.${index}.${slot.path}`
    const scan = scanTemplate(slot.text)
    if (scan.stray) {
      issues.push({ code: 'template_syntax', path, message: `Step ${node.id}: ${slot.path} has braces that aren't a {{reference}}. Close every {{ with }}, or remove it.` })
    }
    for (const reference of scan.placeholders) {
      const found = resolveReference(reference, node, graph)
      if ('problem' in found) issues.push({ code: found.problem.code, path, message: `Step ${node.id}: ${found.problem.message}` })
    }
  }
  return issues
}

// Which comparisons make sense for each kind of value.
const OPS_BY_KIND = {
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  boolean: ['eq', 'neq'],
  text: ['eq', 'neq', 'contains'],
  email: ['eq', 'neq', 'contains'],
} as const

/** Checks a condition's reference, and that its comparison suits the kind of value it reads. */
function checkCondition(node: ConditionNode, index: number, graph: GraphIndex): WorkflowIssue[] {
  const found = resolveReference(node.field, node, graph)
  if ('skipped' in found) return []
  if ('problem' in found) return [{ code: found.problem.code, path: `nodes.${index}.field`, message: `Step ${node.id}: ${found.problem.message}` }]
  const kind = found.field.kind === 'email' ? 'text' : found.field.kind
  const allowedOps: readonly string[] = OPS_BY_KIND[kind]
  const valueFits = kind === 'number' ? typeof node.value === 'number' : kind === 'boolean' ? typeof node.value === 'boolean' : typeof node.value === 'string'
  if (allowedOps.includes(node.op) && valueFits) return []
  return [{ code: 'invalid_condition', path: `nodes.${index}`, message: `Step ${node.id}: ${node.field} is ${kind}, so compare it with ${allowedOps.join(', ')} and a ${kind} value.` }]
}

/** Requires an email to the customer to have an address to go to. */
function checkRecipient(node: ActionNode, index: number, graph: GraphIndex): WorkflowIssue[] {
  if (node.connector !== 'email' || node.params.to !== 'customer') return []
  const event = graph.trigger?.event
  if (event === undefined || TRIGGER_EVENTS[event].fields.contactEmail !== undefined) return []
  return [{ code: 'recipient_unavailable', path: `nodes.${index}.params.to`, message: `Step ${node.id}: the ${event} event carries no customer email, so "customer" can't be the recipient. Use a team mailbox.` }]
}

/** Checks the placeholders, conditions and recipients of every step. */
function checkTexts(shape: Shape, graph: GraphIndex): WorkflowIssue[] {
  const issues: WorkflowIssue[] = []
  shape.nodes.forEach((node, index) => {
    if (node.type === 'condition') issues.push(...checkCondition(node, index, graph))
    if (node.type === 'approval' || node.type === 'action') issues.push(...checkTemplates(node, index, graph))
    if (node.type === 'action') issues.push(...checkRecipient(node, index, graph))
  })
  return issues
}
