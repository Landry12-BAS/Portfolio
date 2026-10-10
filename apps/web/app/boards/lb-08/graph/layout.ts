// Where steps sit on the canvas when nobody has placed them. A workflow made by a model, a sample
// or the outline has no positions, and the canvas must still draw it readably: steps are put in
// columns by how many steps come before them (the longest way from the trigger), top to bottom in
// the order the graph lists them. A step the visitor has dragged keeps the place they gave it,
// and that place is saved with the graph.
import type { WorkflowGraph } from '@lb/contracts'

import type { Point } from './edit'

/** How far apart columns and rows are, in canvas units; a step is about 220 wide and 84 high. */
export const COLUMN_WIDTH = 280
export const ROW_HEIGHT = 130

/** The most columns the layout will spread over, so a graph with a loop ends. */
const MAX_DEPTH = 32

/**
 * Works out each step's column: zero for a step nothing leads into, and one more than the deepest
 * step that leads into it otherwise. Loops are cut by limiting the depth, so a graph the validator
 * will refuse is still drawn.
 */
export function depths(graph: WorkflowGraph): Map<string, number> {
  const depth = new Map<string, number>(graph.nodes.map(node => [node.id, 0]))
  for (let pass = 0; pass < MAX_DEPTH; pass += 1) {
    let changed = false
    for (const edge of graph.edges) {
      const from = depth.get(edge.from)
      const to = depth.get(edge.to)
      if (from === undefined || to === undefined || edge.from === edge.to) continue
      if (to < from + 1 && from + 1 <= MAX_DEPTH) {
        depth.set(edge.to, from + 1)
        changed = true
      }
    }
    if (!changed) break
  }
  return depth
}

/** Gives every step a place: the one saved with it, or the next free row of its column. */
export function layout(graph: WorkflowGraph): Map<string, Point> {
  const depth = depths(graph)
  const rows = new Map<number, number>()
  const places = new Map<string, Point>()
  for (const node of graph.nodes) {
    const column = depth.get(node.id) ?? 0
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    places.set(node.id, node.position ?? { x: column * COLUMN_WIDTH, y: row * ROW_HEIGHT })
  }
  return places
}
