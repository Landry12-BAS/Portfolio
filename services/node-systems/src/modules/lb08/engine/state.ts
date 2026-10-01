// A run as a transaction sees it: its row, its graph and its steps, loaded under the run's
// row lock.
//
// Every change to a run's steps happens in a transaction that starts by locking the run's
// row (`SELECT ... FOR UPDATE`). Two steps that finish at the same moment then take turns,
// and the second one sees the first one's result when it decides what may start next.
// Without the lock, both could see the other still running, start nothing, and leave the
// run stuck.
import type { BranchLabel, StepStatus, Values, WorkflowGraph, WorkflowNode } from '@lb/contracts'
import { and, eq } from 'drizzle-orm'

import type { Lb08Tx } from '../db/connection.ts'
import { runs, runSteps, workflowVersions } from '../db/schema.ts'
import type { RunContext } from './context.ts'
import { RunLog } from './events.ts'
import type { StepProgress } from './flow.ts'

/** A run's row. */
export type RunRow = typeof runs.$inferSelect
/** A step's row. */
export type StepRow = typeof runSteps.$inferSelect

/** A run loaded under its lock: the row, the version's graph and one row for every step. */
export interface RunState {
  run: RunRow
  graph: WorkflowGraph
  steps: Map<string, StepRow>
}

/** What a transaction working on a run needs: the transaction, the run, the log it adds to, and the time it works at. */
export interface Work {
  tx: Lb08Tx
  state: RunState
  log: RunLog
  now: Date
}

/** The fields of a step that a change may set. */
export interface StepChanges {
  status?: StepStatus
  attempts?: number
  output?: Values | null
  errorCode?: string | null
  errorMessage?: string | null
  startedAt?: Date | null
  finishedAt?: Date | null
}

/** Reads a step's status as the typed value it always is (the database's check constraint allows no other). */
export function statusOf(step: StepRow): StepStatus {
  return step.status as StepStatus
}

/** Tells whether text is one of the labels an edge may carry. */
function isBranchLabel(value: unknown): value is BranchLabel {
  return typeof value === 'string' && (['true', 'false', 'approved', 'rejected'] as readonly string[]).includes(value)
}

/** Reads which way a condition or an approval went, from its output; null for any other step. */
export function branchOf(step: StepRow): BranchLabel | null {
  const branch = step.output?.branch
  return isBranchLabel(branch) ? branch : null
}

/** Finds a node of the graph by its id. */
export function nodeOf(graph: WorkflowGraph, nodeId: string): WorkflowNode | undefined {
  return graph.nodes.find(node => node.id === nodeId)
}

/** Tells where every step stands, for `advance`. */
export function progressOf(state: RunState): Map<string, StepProgress> {
  const progress = new Map<string, StepProgress>()
  for (const step of state.steps.values()) progress.set(step.nodeId, { status: statusOf(step), branch: branchOf(step) })
  return progress
}

/** Builds what steps can read: the run's payload, and the outputs of the action steps that have succeeded. */
export function contextOf(state: RunState): RunContext {
  const outputs = new Map<string, Values>()
  for (const node of state.graph.nodes) {
    const step = state.steps.get(node.id)
    if (node.type === 'action' && step?.status === 'succeeded' && step.output) outputs.set(node.id, step.output)
  }
  return { trigger: state.run.input, outputs }
}

/** Returns the id of the first step, in the graph's order, that is in the given state. */
export function firstNodeWith(state: RunState, status: StepStatus): string | undefined {
  return state.graph.nodes.find(node => state.steps.get(node.id)?.status === status)?.id
}

/**
 * Locks a run's row and loads it with its graph and steps. Returns undefined when the run
 * is gone, for instance because its workflow expired and was deleted while a job waited.
 */
export async function loadLocked(tx: Lb08Tx, runId: string): Promise<RunState | undefined> {
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update')
  if (!run) return undefined
  const [version] = await tx.select({ graph: workflowVersions.graph })
    .from(workflowVersions)
    .where(and(eq(workflowVersions.workflowId, run.workflowId), eq(workflowVersions.version, run.version)))
    .limit(1)
  if (!version) return undefined
  const rows = await tx.select().from(runSteps).where(eq(runSteps.runId, runId))
  return { run, graph: version.graph, steps: new Map(rows.map(row => [row.nodeId, row])) }
}

/** Writes changes to one step, and keeps the loaded copy in step with the row. */
export async function updateStep(work: Work, nodeId: string, changes: StepChanges): Promise<void> {
  const step = work.state.steps.get(nodeId)
  if (!step) throw new Error('The step to update does not exist.')
  await work.tx.update(runSteps)
    .set({ ...changes, updatedAt: work.now })
    .where(and(eq(runSteps.runId, work.state.run.id), eq(runSteps.nodeId, nodeId)))
  Object.assign(step, changes, { updatedAt: work.now })
}

/** Starts a transaction's work on a run: its loaded state, a fresh log and the time. */
export function workOn(tx: Lb08Tx, state: RunState, now: Date): Work {
  return { tx, state, log: new RunLog(state.run.id, () => now), now }
}
