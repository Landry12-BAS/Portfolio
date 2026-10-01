// Reading LB-08's data for the API: rows become the views the site is built against
// (`@lb/contracts`). Every read is scoped to the visitor's own session, in the query
// itself, so another visitor's workflow, run or delivery is never reachable: asking for
// one finds nothing, exactly as if it did not exist.
import type { ConnectorId, DeadLetterView, RunEvent, RunStatus, RunSummary, RunView, SentView, StepStatus, StepView, WorkflowSummary, WorkflowVersion, WorkflowView } from '@lb/contracts'
import { and, desc, eq } from 'drizzle-orm'

import type { Executor } from '../db/connection.ts'
import { deadLetters, runs, runSteps, sandboxDeliveries, workflows, workflowVersions } from '../db/schema.ts'
import { readEvents } from './events.ts'

// How many of a visitor's workflows, runs and deliveries one listing returns, newest first.
const LIST_LENGTH = 50

/** Turns a moment into the text the API uses for it. */
function iso(moment: Date): string {
  return moment.toISOString()
}

/** Describes a step for the run page. */
function stepViewOf(row: typeof runSteps.$inferSelect): StepView {
  return {
    nodeId: row.nodeId,
    status: row.status as StepStatus,
    attempts: row.attempts,
    output: row.output,
    error: row.errorCode !== null && row.errorMessage !== null ? { code: row.errorCode, message: row.errorMessage } : null,
    startedAt: row.startedAt === null ? null : iso(row.startedAt),
    finishedAt: row.finishedAt === null ? null : iso(row.finishedAt),
  }
}

/** Describes a run for the run list. */
function runSummaryOf(run: typeof runs.$inferSelect, workflowName: string): RunSummary {
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName,
    version: run.version,
    rootRunId: run.rootRunId,
    replayOf: run.replayOf,
    status: run.status as RunStatus,
    createdAt: iso(run.createdAt),
    finishedAt: run.finishedAt === null ? null : iso(run.finishedAt),
  }
}

/** Describes a workflow for the workflow list. */
function workflowSummaryOf(row: typeof workflows.$inferSelect): WorkflowSummary {
  return { id: row.id, name: row.name, version: row.latestVersion, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), expiresAt: iso(row.expiresAt) }
}

/** Describes one saved version of a workflow. */
function versionOf(row: typeof workflowVersions.$inferSelect): WorkflowVersion {
  return { version: row.version, origin: row.origin as WorkflowVersion['origin'], createdAt: iso(row.createdAt), modelCalls: row.modelCalls, traceRunId: row.traceRunId }
}

/** Reads one of the visitor's runs in full: its steps in the graph's order, its whole log and the replay that followed it. */
export async function readRunView(db: Executor, sessionKey: string, runId: string): Promise<RunView | undefined> {
  const [found] = await db.select({ run: runs, workflowName: workflows.name, graph: workflowVersions.graph })
    .from(runs)
    .innerJoin(workflows, eq(workflows.id, runs.workflowId))
    .innerJoin(workflowVersions, and(eq(workflowVersions.workflowId, runs.workflowId), eq(workflowVersions.version, runs.version)))
    .where(and(eq(runs.id, runId), eq(runs.sessionKey, sessionKey)))
    .limit(1)
  if (!found) return undefined
  const stepRows = await db.select().from(runSteps).where(eq(runSteps.runId, runId))
  const byNode = new Map(stepRows.map(row => [row.nodeId, row]))
  const steps = found.graph.nodes.flatMap(node => byNode.get(node.id) ?? []).map(stepViewOf)
  const [replay] = await db.select({ id: runs.id }).from(runs).where(eq(runs.replayOf, runId)).orderBy(desc(runs.createdAt)).limit(1)
  return {
    ...runSummaryOf(found.run, found.workflowName),
    input: found.run.input,
    replayedBy: replay?.id ?? null,
    steps,
    events: await readEvents(db, runId),
  }
}

/** What a poll of a run's log returns: where the run is, and the events after the last one the caller saw. */
export interface RunEvents {
  status: RunStatus
  events: RunEvent[]
}

/** Reads one of the visitor's runs' events after sequence number `after`, with the run's status, for a page that follows a run. */
export async function readRunEvents(db: Executor, sessionKey: string, runId: string, after: number): Promise<RunEvents | undefined> {
  const [run] = await db.select({ status: runs.status }).from(runs).where(and(eq(runs.id, runId), eq(runs.sessionKey, sessionKey))).limit(1)
  if (!run) return undefined
  return { status: run.status as RunStatus, events: await readEvents(db, runId, after) }
}

/** Lists the visitor's runs, newest first. */
export async function listRuns(db: Executor, sessionKey: string): Promise<RunSummary[]> {
  const rows = await db.select({ run: runs, workflowName: workflows.name })
    .from(runs)
    .innerJoin(workflows, eq(workflows.id, runs.workflowId))
    .where(eq(runs.sessionKey, sessionKey))
    .orderBy(desc(runs.createdAt))
    .limit(LIST_LENGTH)
  return rows.map(row => runSummaryOf(row.run, row.workflowName))
}

/** Reads one of the visitor's workflows in full: its latest graph, what it was first described as, and every version. */
export async function readWorkflowView(db: Executor, sessionKey: string, workflowId: string): Promise<WorkflowView | undefined> {
  const [workflow] = await db.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.sessionKey, sessionKey))).limit(1)
  if (!workflow) return undefined
  const versions = await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId)).orderBy(desc(workflowVersions.version))
  const latest = versions.find(version => version.version === workflow.latestVersion)
  const first = versions.find(version => version.version === 1)
  if (!latest) return undefined
  return { ...workflowSummaryOf(workflow), description: first?.description ?? null, graph: latest.graph, versions: versions.map(versionOf) }
}

/** Lists the visitor's workflows, newest first. */
export async function listWorkflows(db: Executor, sessionKey: string): Promise<WorkflowSummary[]> {
  const rows = await db.select().from(workflows).where(eq(workflows.sessionKey, sessionKey)).orderBy(desc(workflows.createdAt)).limit(LIST_LENGTH)
  return rows.map(workflowSummaryOf)
}

/** Lists what the sandbox's connectors "sent" for the visitor, newest first; for one run's chain when `rootRunId` is given. */
export async function listSent(db: Executor, sessionKey: string, rootRunId?: string): Promise<SentView[]> {
  const mine = eq(sandboxDeliveries.sessionKey, sessionKey)
  const rows = await db.select().from(sandboxDeliveries)
    .where(rootRunId === undefined ? mine : and(mine, eq(sandboxDeliveries.rootRunId, rootRunId)))
    .orderBy(desc(sandboxDeliveries.createdAt))
    .limit(LIST_LENGTH)
  return rows.map(row => ({ id: row.id, connector: row.connector as ConnectorId, nodeId: row.nodeId, rootRunId: row.rootRunId, payload: row.payload, sentAt: iso(row.createdAt) }))
}

/** Lists the visitor's dead letters, newest first. */
export async function listDeadLetters(db: Executor, sessionKey: string): Promise<DeadLetterView[]> {
  const rows = await db.select().from(deadLetters).where(eq(deadLetters.sessionKey, sessionKey)).orderBy(desc(deadLetters.createdAt)).limit(LIST_LENGTH)
  return rows.map(row => ({
    id: row.id,
    runId: row.runId,
    workflowId: row.workflowId,
    nodeId: row.nodeId,
    attempts: row.attempts,
    error: { code: row.errorCode, message: row.errorMessage },
    createdAt: iso(row.createdAt),
    replayedRunId: row.replayedRunId,
  }))
}
