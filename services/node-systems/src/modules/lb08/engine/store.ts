// Writing workflows and their versions.
//
// A workflow is a visitor's, identified by their session, and it holds immutable versions:
// saving an edit adds a version, it never changes one, so every run stays tied to the exact
// graph it ran. Everything here checks the visitor's limits (twenty workflows, thirty
// versions each) inside the transaction that writes, behind a lock, so two requests
// arriving together can't both take the last place.
import { randomUUID } from 'node:crypto'

import { RUN_LIMITS } from '@lb/contracts'
import type { WorkflowGraph } from '@lb/contracts'
import { and, count, eq, sql } from 'drizzle-orm'

import { AppError } from '../../../core/errors.ts'
import type { Executor } from '../db/connection.ts'
import { workflows, workflowVersions } from '../db/schema.ts'
import type { EngineDeps } from './deps.ts'

/** A workflow to create: a first version and where it came from. */
export interface NewWorkflow {
  sessionKey: string
  graph: WorkflowGraph
  origin: 'generated' | 'sample'
  // What the visitor wrote, for a described workflow.
  description: string | null
  // Gateway calls it took, and the id they were traced under.
  modelCalls: number
  traceRunId: string | null
}

/** A version of a workflow, loaded to run: which workflow, which version, and its graph. */
export interface LoadedVersion {
  workflowId: string
  workflowName: string
  version: number
  graph: WorkflowGraph
}

/** The error for a workflow that doesn't exist or isn't the visitor's: the same either way, so ids can't be probed. */
export function workflowNotFound(): AppError {
  return new AppError(404, 'not_found', 'There is no such workflow.')
}

/** Creates a workflow with its first version, and returns the workflow's id. Refuses when the visitor already keeps as many as they may. */
export async function createWorkflow(deps: EngineDeps, input: NewWorkflow): Promise<string> {
  const now = deps.now()
  return deps.db.transaction(async (tx) => {
    // One visitor's creations take turns, so the count below can't be raced past the limit.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lb08.workflows:${input.sessionKey}`}, 0))`)
    const [kept] = await tx.select({ total: count() }).from(workflows).where(eq(workflows.sessionKey, input.sessionKey))
    if ((kept?.total ?? 0) >= RUN_LIMITS.maxWorkflowsPerVisitor) {
      throw new AppError(409, 'workflow_limit', `A visitor may keep ${RUN_LIMITS.maxWorkflowsPerVisitor} workflows at once. Delete one to make another.`)
    }
    const id = randomUUID()
    await tx.insert(workflows).values({
      id,
      sessionKey: input.sessionKey,
      name: input.graph.name,
      latestVersion: 1,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + deps.config.retentionMs),
    })
    await tx.insert(workflowVersions).values({
      workflowId: id,
      version: 1,
      origin: input.origin,
      description: input.description,
      graph: input.graph,
      modelCalls: input.modelCalls,
      traceRunId: input.traceRunId,
      createdAt: now,
    })
    return id
  })
}

/**
 * Saves an edited graph as the next version, and returns its number. `baseVersion` is the
 * version the editor started from: if someone saved since, the edit is refused instead of
 * silently overwriting their work.
 */
export async function saveVersion(deps: EngineDeps, sessionKey: string, workflowId: string, baseVersion: number, graph: WorkflowGraph): Promise<number> {
  const now = deps.now()
  return deps.db.transaction(async (tx) => {
    const [workflow] = await tx.select().from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.sessionKey, sessionKey)))
      .for('update')
    if (!workflow) throw workflowNotFound()
    if (workflow.latestVersion !== baseVersion) {
      throw new AppError(409, 'version_conflict', `The workflow is at version ${workflow.latestVersion}, not ${baseVersion}. Load the latest version and edit that.`)
    }
    if (workflow.latestVersion >= RUN_LIMITS.maxVersionsPerWorkflow) {
      throw new AppError(409, 'version_limit', `A workflow may have ${RUN_LIMITS.maxVersionsPerWorkflow} versions.`)
    }
    const next = workflow.latestVersion + 1
    await tx.insert(workflowVersions).values({ workflowId, version: next, origin: 'edited', description: null, graph, modelCalls: 0, traceRunId: null, createdAt: now })
    await tx.update(workflows).set({ name: graph.name, latestVersion: next, updatedAt: now }).where(eq(workflows.id, workflowId))
    return next
  })
}

/** Deletes one of the visitor's workflows, with every version, run, step, log and delivery that belongs to it. Returns whether there was one. */
export async function deleteWorkflow(db: Executor, sessionKey: string, workflowId: string): Promise<boolean> {
  const removed = await db.delete(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.sessionKey, sessionKey)))
    .returning({ id: workflows.id })
  return removed.length > 0
}

/** Loads a version of one of the visitor's workflows (the latest when no number is given), or returns undefined. */
export async function loadVersion(db: Executor, sessionKey: string, workflowId: string, version?: number): Promise<LoadedVersion | undefined> {
  const [workflow] = await db.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.sessionKey, sessionKey))).limit(1)
  if (!workflow) return undefined
  const wanted = version ?? workflow.latestVersion
  const [saved] = await db.select({ graph: workflowVersions.graph })
    .from(workflowVersions)
    .where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.version, wanted)))
    .limit(1)
  return saved ? { workflowId, workflowName: workflow.name, version: wanted, graph: saved.graph } : undefined
}
