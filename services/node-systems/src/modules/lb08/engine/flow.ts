// How a run moves through its graph. Given where every step stands, these functions say
// which steps may start, which can never run, and where the run as a whole is. They are
// pure: they read the graph and the steps' states and return decisions, so the rules can be
// tested without a database, and the code that writes the decisions down stays small.
//
// The rules:
// - A step becomes ready when every edge leading into it has an answer and at least one
//   of them is live. An edge is live when its source succeeded and, if the source chose a
//   branch, the edge is the branch it chose. An edge is dead when its source was skipped or
//   chose the other branch. A source that is still working leaves the edge open.
// - A step whose edges are all dead is skipped, and skipping it can settle the steps after
//   it, so a skip ripples down its whole dead branch in one call.
// - After a step fails, the run starts nothing new: what is already running finishes, and
//   the run then ends as failed.
import type { BranchLabel, RunStatus, StepStatus, WorkflowEdge, WorkflowGraph } from '@lb/contracts'

/** Where one step stands, and, once a condition or an approval has chosen, which way it went. */
export interface StepProgress {
  status: StepStatus
  branch: BranchLabel | null
}

/** Why a step will not run: its branch wasn't taken, or everything before it was skipped. */
export type SkipReason = 'branch_not_taken' | 'upstream_skipped'

/** What the next move of a run is: the steps that may start, and the steps that never will. */
export interface Advance {
  // Steps that have what they need, in the graph's order.
  ready: string[]
  skipped: { nodeId: string, reason: SkipReason }[]
}

/** What an edge says to the step it leads into: its source is still working, it leads on, or it will never be taken. */
type Verdict = 'open' | 'live' | 'dead'

// The states in which a step is still moving without anyone's help.
const IN_FLIGHT: ReadonlySet<StepStatus> = new Set(['ready', 'queued', 'running'])

/** Reads one edge: still open, live, or dead, from the state of the step it starts at. */
function verdictOf(edge: WorkflowEdge, source: StepProgress | undefined): Verdict {
  if (!source) return 'open'
  if (source.status === 'skipped') return 'dead'
  if (source.status !== 'succeeded') return 'open'
  return edge.branch === undefined || edge.branch === source.branch ? 'live' : 'dead'
}

/** Groups a graph's edges by the step they lead into. */
function incomingEdges(graph: WorkflowGraph): Map<string, WorkflowEdge[]> {
  const incoming = new Map<string, WorkflowEdge[]>()
  for (const edge of graph.edges) {
    const list = incoming.get(edge.to) ?? []
    list.push(edge)
    incoming.set(edge.to, list)
  }
  return incoming
}

/**
 * Finds the steps that may start now, and the steps that can never run, given where every
 * step stands. It doesn't start or skip anything itself: the caller writes the decisions
 * down, and asks again, because a condition that runs may settle more steps.
 */
export function advance(graph: WorkflowGraph, progress: ReadonlyMap<string, StepProgress>): Advance {
  const current = new Map(progress)
  const incoming = incomingEdges(graph)
  const outcome: Advance = { ready: [], skipped: [] }
  let settledSomething = true
  while (settledSomething) {
    settledSomething = false
    for (const node of graph.nodes) {
      if (current.get(node.id)?.status !== 'pending') continue
      const edges = incoming.get(node.id) ?? []
      const verdicts = edges.map(edge => verdictOf(edge, current.get(edge.from)))
      if (verdicts.includes('open')) continue
      settledSomething = true
      if (verdicts.includes('live')) {
        current.set(node.id, { status: 'ready', branch: null })
        outcome.ready.push(node.id)
        continue
      }
      // Every edge is dead. If a source that did run chose another branch, say so.
      const passedOver = edges.some(edge => current.get(edge.from)?.status === 'succeeded')
      current.set(node.id, { status: 'skipped', branch: null })
      outcome.skipped.push({ nodeId: node.id, reason: passedOver ? 'branch_not_taken' : 'upstream_skipped' })
    }
  }
  return outcome
}

/**
 * Says where a run is, from the states of its steps. `started` is whether a worker has
 * begun on it. A run waits for approval only when nothing else can move, and a run with a
 * failed step stays `running` until the steps still in flight have finished.
 */
export function runStatusOf(statuses: readonly StepStatus[], started: boolean): RunStatus {
  const inFlight = statuses.some(status => IN_FLIGHT.has(status))
  if (statuses.includes('failed')) return inFlight ? 'running' : 'failed'
  if (statuses.every(status => status === 'succeeded' || status === 'skipped')) return 'succeeded'
  if (inFlight) return started ? 'running' : 'queued'
  if (statuses.includes('awaiting_approval')) return 'awaiting_approval'
  // Nothing can move and nothing waits for a person. A valid graph never gets here; if it
  // did, showing the run as finished would hide it, so it stays running.
  return 'running'
}

/** Tells whether a step is in one of the states from which it still moves on its own. */
export function isInFlight(status: StepStatus): boolean {
  return IN_FLIGHT.has(status)
}
