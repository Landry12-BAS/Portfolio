// Where the validator's problems belong. `validateWorkflow` (in @lb/contracts) answers with a stable
// code, a path into the graph such as `nodes.2.params.channel` or `edges.4`, and a message written
// as an instruction in English. The editor shows each problem at the step or the connection it
// concerns, in the visitor's language, so this module reads the path to find the place, and turns
// the code and the place into a key of the locale files and the words to fill into it. The
// validator's own English message stays available as the technical detail.
import { GRAPH_LIMITS } from '@lb/contracts'
import type { IssueCode, WorkflowGraph, WorkflowIssue, WorkflowNode } from '@lb/contracts'

/** What a problem is about. */
export type IssueTarget
  = | { kind: 'node', nodeId: string, field: string | undefined }
    | { kind: 'edge', index: number }
    | { kind: 'graph', field: string | undefined }

/** A problem and the place it belongs to. */
export interface LocatedIssue {
  issue: WorkflowIssue
  target: IssueTarget
}

/** The problems of a graph, sorted by where they belong, so each step and each connection can show its own. */
export interface IssueIndex {
  all: readonly LocatedIssue[]
  byNode: ReadonlyMap<string, readonly LocatedIssue[]>
  byEdge: ReadonlyMap<number, readonly LocatedIssue[]>
  graph: readonly LocatedIssue[]
}

/** Reads a path of the form `nodes.2.params.channel` into the place it points at. */
export function locate(graph: WorkflowGraph, issue: WorkflowIssue): LocatedIssue {
  const [first, second, ...rest] = issue.path.split('.')
  const index = second === undefined ? Number.NaN : Number(second)
  const field = rest.length > 0 ? rest.join('.') : undefined
  if (first === 'nodes' && Number.isInteger(index)) {
    const node = graph.nodes[index]
    if (node) return { issue, target: { kind: 'node', nodeId: node.id, field } }
  }
  if (first === 'edges' && Number.isInteger(index) && index >= 0 && index < graph.edges.length) {
    return { issue, target: { kind: 'edge', index } }
  }
  return { issue, target: { kind: 'graph', field: first === 'name' ? 'name' : undefined } }
}

/** Locates every problem of a validation and sorts them by place. */
export function indexIssues(graph: WorkflowGraph, issues: readonly WorkflowIssue[]): IssueIndex {
  const all = issues.map(issue => locate(graph, issue))
  const byNode = new Map<string, LocatedIssue[]>()
  const byEdge = new Map<number, LocatedIssue[]>()
  const onGraph: LocatedIssue[] = []
  for (const located of all) {
    const { target } = located
    if (target.kind === 'node') byNode.set(target.nodeId, [...byNode.get(target.nodeId) ?? [], located])
    else if (target.kind === 'edge') byEdge.set(target.index, [...byEdge.get(target.index) ?? [], located])
    else onGraph.push(located)
  }
  return { all, byNode, byEdge, graph: onGraph }
}

/** What a field is called, for the words of a problem about it: the owner is `trigger`, `condition`, `approval` or a connector's id. */
export type FieldLabeller = (owner: string, name: string) => string

/** The key of the locale files for a problem's words, and the words to fill into it. */
export interface IssueWords {
  key: string
  params: Record<string, string | number>
}

/** A step's name for a message: its label, or its id when it has none. */
function nameOf(node: WorkflowNode | undefined, fallback: string): string {
  return node?.label || fallback
}

/** What owns the fields of a step: the connector of an action, or the step's type. */
export function ownerOf(node: WorkflowNode): string {
  return node.type === 'action' ? node.connector : node.type
}

/** The name of the last part of a field path, such as `channel` for `params.channel` and `orderId` for `params.fields.orderId`. */
function fieldName(path: string): string {
  return path.split('.').at(-1) ?? path
}

/** Which locale message a code uses; a code with no message of its own falls back to the general one. */
const GENERAL: Readonly<Partial<Record<IssueCode, string>>> = {
  unknown_node_type: 'invalid_value',
  unknown_field: 'invalid_value',
}

/** The limit a size problem is about: how many steps, connections or follow-ups a graph may have. */
function limitFor(code: IssueCode): number {
  if (code === 'too_many_nodes') return GRAPH_LIMITS.maxNodes
  if (code === 'too_many_edges') return GRAPH_LIMITS.maxEdges
  return GRAPH_LIMITS.maxFanOut
}

/**
 * Chooses the words for a problem. The key is `lb08.issues.<code>`, and the parameters name the
 * step (`step`), the connection (`from`, `to`, `branch`) or the field (`field`) it concerns, so
 * every message reads as a sentence about that one thing.
 */
export function wordsFor(graph: WorkflowGraph, located: LocatedIssue, label: FieldLabeller): IssueWords {
  const { issue, target } = located
  const key = `lb08.issues.${GENERAL[issue.code] ?? issue.code}`
  const params: Record<string, string | number> = {}
  if (target.kind === 'node') {
    const node = graph.nodes.find(candidate => candidate.id === target.nodeId)
    params.step = nameOf(node, target.nodeId)
    params.id = target.nodeId
    if (node && target.field) params.field = label(ownerOf(node), fieldName(target.field))
  }
  else if (target.kind === 'edge') {
    const edge = graph.edges[target.index]
    const from = graph.nodes.find(node => node.id === edge?.from)
    const to = graph.nodes.find(node => node.id === edge?.to)
    params.from = nameOf(from, edge?.from ?? '')
    params.to = nameOf(to, edge?.to ?? '')
    params.branch = edge?.branch ?? ''
  }
  params.max = limitFor(issue.code)
  if (target.kind === 'node') params.count = graph.edges.filter(edge => edge.from === target.nodeId).length
  return { key, params }
}
