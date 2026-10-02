// The workflow as a list of steps, for the editor a keyboard and a screen reader can use: each step
// in the order a run reaches it, with where it comes from and where it goes. It is the same graph
// the canvas draws, read as text instead of as a picture.
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from '@lb/contracts'

import { depths } from './layout'

/** One connection leaving a step: its place in the graph's edge list, the edge and the step it leads to (absent when it leads nowhere). */
export interface OutlineConnection {
  index: number
  edge: WorkflowEdge
  target: WorkflowNode | undefined
}

/** One step of the outline. */
export interface OutlineItem {
  node: WorkflowNode
  // Its place in the outline, from 1.
  number: number
  // The connections that lead into it, by position in the graph's edge list.
  incoming: { index: number, edge: WorkflowEdge, source: WorkflowNode | undefined }[]
  outgoing: OutlineConnection[]
}

/** Lists the steps in the order a run reaches them (earlier columns first, then the graph's own order), with their connections. */
export function outlineOf(graph: WorkflowGraph): OutlineItem[] {
  const depth = depths(graph)
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const ordered = graph.nodes
    .map((node, position) => ({ node, position }))
    .sort((a, b) => (depth.get(a.node.id) ?? 0) - (depth.get(b.node.id) ?? 0) || a.position - b.position)
  return ordered.map(({ node }, position): OutlineItem => ({
    node,
    number: position + 1,
    incoming: graph.edges.flatMap((edge, index) => (edge.to === node.id ? [{ index, edge, source: byId.get(edge.from) }] : [])),
    outgoing: graph.edges.flatMap((edge, index) => (edge.from === node.id ? [{ index, edge, target: byId.get(edge.to) }] : [])),
  }))
}
