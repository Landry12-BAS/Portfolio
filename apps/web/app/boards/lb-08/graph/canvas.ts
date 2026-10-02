// What the canvas draws, worked out from the draft: a node for each step and an edge for each
// connection, with the words that go on them. Nothing here touches Vue Flow or the page, so the
// mapping can be tested on its own. The canvas is a picture of the same graph the outline lists: the
// same steps in the same numbers, the same problems, and, after a run, the same step states.
import { branchLabelsFor } from '@lb/contracts'
import type { BranchLabel, StepStatus, WorkflowGraph } from '@lb/contracts'
import type { IconName } from '@lb/icons'

import type { RunModel, StepRun } from '../run/model'
import type { Selection } from '../store'

import type { StepKind } from './edit'
import type { IssueIndex, LocatedIssue } from './issues'
import { wordsFor } from './issues'
import { layout } from './layout'
import { outlineOf } from './outline'
import { iconFor, kindOf, statusIcon } from './visual'
import type { Words } from './words'

/** The id of the handle a step offers when it does not branch. */
export const PLAIN_HANDLE = 'out'

/** One dot on the right of a step that a connection can be dragged from. */
export interface SourceHandle {
  // The branch a connection made from this dot takes; none for a step that does not branch.
  id: string
  branch: BranchLabel | undefined
  // Where the dot sits on the step's right edge, as a share of its height.
  top: string
  // The branch's name in words, drawn beside the dot; empty for a step that does not branch.
  label: string
}

/** What a step shows of the run, when the run is of this workflow. */
export interface RunBadge {
  status: StepStatus
  icon: IconName
  text: string
  attempt: string | undefined
  deadLetter: string | undefined
}

/** What a step node needs to be drawn. */
export interface StepNodeData {
  number: number
  kind: StepKind
  kindLabel: string
  icon: IconName
  label: string
  // The first problem in a few words, how many more there are, and whether there are any.
  reason: string | undefined
  moreProblems: number
  badge: RunBadge | undefined
  handles: SourceHandle[]
  // A trigger has nothing leading into it, so it has no dot on the left.
  acceptsInput: boolean
  editable: boolean
}

/** A step as the canvas takes it. The fields are those of a Vue Flow node, and only those used here. */
export interface CanvasNode {
  id: string
  type: 'step'
  position: { x: number, y: number }
  selected: boolean
  draggable: boolean
  connectable: boolean
  deletable: false
  focusable: true
  ariaLabel: string
  domAttributes: { 'aria-describedby': string, 'aria-roledescription': string }
  data: StepNodeData
}

/** What a connection shows. */
export interface StepEdgeData {
  // The connection's place in the graph's edge list.
  index: number
  branch: string | undefined
  reason: string | undefined
}

/** A connection as the canvas takes it. The fields are those of a Vue Flow edge, and only those used here. */
export interface CanvasEdge {
  id: string
  type: 'step'
  source: string
  target: string
  sourceHandle: string
  selected: boolean
  focusable: false
  deletable: false
  markerEnd: 'arrowclosed'
  interactionWidth: number
  ariaLabel: string
  domAttributes: { 'aria-roledescription': string }
  data: StepEdgeData
}

/** Everything the canvas is drawn from. */
export interface CanvasInput {
  graph: WorkflowGraph
  issues: IssueIndex | undefined
  selection: Selection | undefined
  // Whether the visitor may change the workflow: false while a recording plays.
  editable: boolean
  // The run whose step states the steps show, when it ran this very workflow.
  run: RunModel | undefined
  // The id of the element that tells how to use the keyboard on a step.
  helpId: string
  words: Words
}

const EDGE_ID = /^edge-(\d+)$/

/** The id the canvas gives the connection at a place in the edge list. */
export function edgeIdOf(index: number): string {
  return `edge-${index}`
}

/** Reads a connection's place in the edge list back out of its id. */
export function edgeIndexOf(id: string): number | undefined {
  const found = EDGE_ID.exec(id)
  return found?.[1] === undefined ? undefined : Number(found[1])
}

/** The words for a field's name in a message. */
function fieldLabeller(words: Words): (owner: string, name: string) => string {
  return (owner, name) => {
    const key = `lb08.fields.${owner}.${name}.label`
    return words.has(key) ? words.say(key) : name
  }
}

/** A problem in a few words: the validator's code, said in the visitor's language. */
function shortReason(words: Words, located: LocatedIssue): string {
  const key = `lb08.codes.${located.issue.code}`
  return words.has(key) ? words.say(key) : words.say('lb08.codes.invalid_value')
}

/** A problem as a whole sentence. */
function sentence(graph: WorkflowGraph, words: Words, located: LocatedIssue): string {
  const found = wordsFor(graph, located, fieldLabeller(words))
  return words.say(found.key, found.params)
}

/** The dots a step offers to start connections from: one for each branch, or a single plain one. */
function handlesOf(type: string, words: Words): SourceHandle[] {
  const branches = branchLabelsFor(type)
  if (branches.length === 0) return [{ id: PLAIN_HANDLE, branch: undefined, top: '50%', label: '' }]
  return branches.map((branch, position) => ({
    id: branch,
    branch,
    top: `${Math.round(((position + 1) / (branches.length + 1)) * 100)}%`,
    label: words.say(`lb08.branches.${branch}`),
  }))
}

/** The handle a connection leaves from: the one of its branch, or the first one when the branch is not one the step has. */
export function handleFor(type: string, branch: BranchLabel | undefined): string {
  const branches = branchLabelsFor(type)
  if (branch !== undefined && branches.includes(branch)) return branch
  return branches[0] ?? PLAIN_HANDLE
}

/** What a step shows of the run. */
function badgeOf(step: StepRun | undefined, words: Words): RunBadge | undefined {
  if (!step) return undefined
  const used = step.attempts > 0
  return {
    status: step.status,
    icon: statusIcon(step.status),
    text: words.say(`lb08.steps.statuses.${step.status}`),
    attempt: used ? words.say('lb08.steps.attempt', { attempt: step.attempts, max: step.maxAttempts }) : undefined,
    deadLetter: step.deadLettered ? words.say('lb08.steps.dead') : undefined,
  }
}

/** The steps as nodes, each in its place, numbered as in the outline. */
export function canvasNodes(input: CanvasInput): CanvasNode[] {
  const { graph, issues, selection, editable, run, helpId, words } = input
  const places = layout(graph)
  const numbers = new Map(outlineOf(graph).map(item => [item.node.id, item.number]))
  const seen = new Set<string>()
  const nodes: CanvasNode[] = []
  for (const node of graph.nodes) {
    if (seen.has(node.id)) continue
    seen.add(node.id)
    const kind = kindOf(node)
    const problems = issues?.byNode.get(node.id) ?? []
    const first = problems[0]
    const badge = badgeOf(run?.steps.find(step => step.nodeId === node.id), words)
    const name = node.label || node.id
    const parts = [words.say('lb08.canvas.nodeLabel', { number: numbers.get(node.id) ?? 0, kind: words.say(`lb08.kinds.${kind}`), step: name })]
    if (badge) parts.push(badge.text + (badge.attempt ? `, ${badge.attempt}` : '') + (badge.deadLetter ? `, ${badge.deadLetter}` : ''))
    for (const located of problems) parts.push(sentence(graph, words, located))
    nodes.push({
      id: node.id,
      type: 'step',
      position: places.get(node.id) ?? { x: 0, y: 0 },
      selected: selection?.kind === 'node' && selection.id === node.id,
      draggable: editable,
      connectable: editable,
      deletable: false,
      focusable: true,
      ariaLabel: parts.join(' '),
      domAttributes: { 'aria-describedby': helpId, 'aria-roledescription': words.say('lb08.canvas.nodeRole') },
      data: {
        number: numbers.get(node.id) ?? 0,
        kind,
        kindLabel: words.say(`lb08.kinds.${kind}`),
        icon: iconFor(node),
        label: name,
        reason: first ? shortReason(words, first) : undefined,
        moreProblems: Math.max(0, problems.length - 1),
        badge,
        handles: handlesOf(node.type, words),
        acceptsInput: node.type !== 'trigger',
        editable,
      },
    })
  }
  return nodes
}

/** The connections as edges. A connection to or from a step that is not there is left out: there is nothing to draw it between. */
export function canvasEdges(input: CanvasInput): CanvasEdge[] {
  const { graph, issues, selection, words } = input
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const edges: CanvasEdge[] = []
  graph.edges.forEach((edge, index) => {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) return
    const problems = issues?.byEdge.get(index) ?? []
    const first = problems[0]
    const branch = edge.branch === undefined ? undefined : words.say(`lb08.branches.${edge.branch}`)
    const parts = [words.say('lb08.outline.connectionLabel', { from: from.label || from.id, to: to.label || to.id })]
    if (branch) parts.push(words.say('lb08.canvas.edgeBranch', { branch }))
    for (const located of problems) parts.push(sentence(graph, words, located))
    edges.push({
      id: edgeIdOf(index),
      type: 'step',
      source: edge.from,
      target: edge.to,
      sourceHandle: handleFor(from.type, edge.branch),
      selected: selection?.kind === 'edge' && selection.index === index,
      focusable: false,
      deletable: false,
      markerEnd: 'arrowclosed',
      interactionWidth: 24,
      ariaLabel: parts.join(' '),
      domAttributes: { 'aria-roledescription': words.say('lb08.canvas.edgeRole') },
      data: { index, branch, reason: first ? shortReason(words, first) : undefined },
    })
  })
  return edges
}

/** The branch a dot stands for, or none for the plain dot of a step that does not branch. */
export function branchOfHandle(handle: string | null | undefined): BranchLabel | undefined {
  if (handle === 'true' || handle === 'false' || handle === 'approved' || handle === 'rejected') return handle
  return undefined
}
