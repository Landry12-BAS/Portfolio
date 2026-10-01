// What the API tells the site about runs, workflows and the sandbox: the shapes the
// run page, the editor and the dead-letter list read. The service builds its responses
// from these schemas, so the OpenAPI file and the site's types come from one place.
import { z } from 'zod'

import { CONNECTORS, connectorIds, TRIGGER_EVENTS, triggerEventIds } from '../workflow/catalogue.ts'
import type { FieldSpec } from '../workflow/catalogue.ts'
import { workflowGraphSchema } from '../workflow/graph.ts'
import { GRAPH_LIMITS, RUN_LIMITS } from '../workflow/limits.ts'
import { runEventSchema, valuesSchema } from './events.ts'

const nodeId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)
const timestamp = z.iso.datetime()

/** Where a run is. A run waits for approval only while nothing else can move. */
export const runStatuses = ['queued', 'running', 'awaiting_approval', 'succeeded', 'failed'] as const
/** One status of a run. */
export type RunStatus = (typeof runStatuses)[number]

/** Where a step is. `ready` steps have their inputs and wait to be queued; `queued` ones wait for a worker. */
export const stepStatuses = ['pending', 'ready', 'queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'skipped'] as const
/** One status of a step. */
export type StepStatus = (typeof stepStatuses)[number]

/** A step of a run: its state, how many attempts it has used and what it produced. */
export const stepViewSchema = z.strictObject({
  nodeId,
  status: z.enum(stepStatuses),
  attempts: z.int().min(0),
  output: valuesSchema.nullable(),
  error: z.strictObject({ code: z.string().max(40), message: z.string().max(200) }).nullable(),
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
})

/** A run as the run list shows it. */
export const runSummarySchema = z.strictObject({
  id: z.uuid(),
  workflowId: z.uuid(),
  workflowName: z.string(),
  version: z.int().min(1),
  // The first run of the chain of replays this run belongs to. Its side effects are
  // keyed by it, so a replay recognises what the earlier runs already sent.
  rootRunId: z.uuid(),
  replayOf: z.uuid().nullable(),
  status: z.enum(runStatuses),
  createdAt: timestamp,
  finishedAt: timestamp.nullable(),
})

/** A run in full: its payload, every step and the whole event log. */
export const runViewSchema = runSummarySchema.extend({
  input: valuesSchema,
  // The latest replay of this run, if there is one.
  replayedBy: z.uuid().nullable(),
  steps: z.array(stepViewSchema),
  events: z.array(runEventSchema),
})

/** How a workflow version came to be. */
export const versionOrigins = ['generated', 'sample', 'edited'] as const

/** One saved version of a workflow. */
export const workflowVersionSchema = z.strictObject({
  version: z.int().min(1),
  origin: z.enum(versionOrigins),
  createdAt: timestamp,
  // Model calls it took: 1 or 2 for a generated version, 0 otherwise.
  modelCalls: z.int().min(0),
})

/** A workflow as the workflow list shows it. */
export const workflowSummarySchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  // The latest version's number.
  version: z.int().min(1),
  createdAt: timestamp,
  updatedAt: timestamp,
  // When the visitor's data, this workflow included, is deleted.
  expiresAt: timestamp,
})

/** A workflow in full: its latest graph and every version. */
export const workflowViewSchema = workflowSummarySchema.extend({
  // What the visitor wrote, when the workflow was described rather than picked from the samples.
  description: z.string().nullable(),
  graph: workflowGraphSchema,
  versions: z.array(workflowVersionSchema),
})

/** One thing a sandboxed connector "sent", as recorded in its table. */
export const sentViewSchema = z.strictObject({
  id: z.uuid(),
  connector: z.enum(connectorIds),
  nodeId,
  rootRunId: z.uuid(),
  payload: valuesSchema,
  sentAt: timestamp,
})

/** A step that used all its attempts, waiting in the dead-letter queue for a replay. */
export const deadLetterViewSchema = z.strictObject({
  id: z.uuid(),
  runId: z.uuid(),
  workflowId: z.uuid(),
  nodeId,
  attempts: z.int().min(1),
  error: z.strictObject({ code: z.string().max(40), message: z.string().max(200) }),
  createdAt: timestamp,
  // The run that replayed it, once someone has.
  replayedRunId: z.uuid().nullable(),
})

/** How much of one daily allowance a visitor has used. */
const allowanceSchema = z.strictObject({ limit: z.int().min(0), used: z.int().min(0), remaining: z.int().min(0) })

/** The visitor's daily allowances. They reset at 00:00 UTC. */
export const limitsViewSchema = z.strictObject({
  runs: allowanceSchema,
  generations: allowanceSchema,
  resetsAt: timestamp,
})

/** A curated sample the demo opens on: a description with a ready workflow and a test payload. */
export const sampleViewSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,60}$/),
  title: z.string(),
  language: z.enum(['en', 'cs']),
  description: z.string(),
  event: z.enum(triggerEventIds),
  input: valuesSchema,
})

/** A run, as listed. */
export type RunSummary = z.infer<typeof runSummarySchema>
/** A run, in full. */
export type RunView = z.infer<typeof runViewSchema>
/** A step of a run. */
export type StepView = z.infer<typeof stepViewSchema>
/** A workflow, as listed. */
export type WorkflowSummary = z.infer<typeof workflowSummarySchema>
/** A workflow, in full. */
export type WorkflowView = z.infer<typeof workflowViewSchema>
/** One saved version of a workflow. */
export type WorkflowVersion = z.infer<typeof workflowVersionSchema>
/** One delivery recorded by a sandboxed connector. */
export type SentView = z.infer<typeof sentViewSchema>
/** A dead-lettered step. */
export type DeadLetterView = z.infer<typeof deadLetterViewSchema>
/** A visitor's daily allowances. */
export type LimitsView = z.infer<typeof limitsViewSchema>
/** A curated sample. */
export type SampleView = z.infer<typeof sampleViewSchema>

/** One field of a trigger event's payload, as the catalogue lists it. */
const catalogueFieldSchema = z.strictObject({
  name: z.string(),
  kind: z.enum(['text', 'email', 'number', 'boolean']),
  description: z.string(),
  example: z.union([z.string(), z.number(), z.boolean()]),
})

/** What a workflow may be made of, for the editor's palette and the test-payload form. */
export const catalogueViewSchema = z.strictObject({
  triggers: z.array(z.strictObject({ id: z.enum(triggerEventIds), label: z.string(), fields: z.array(catalogueFieldSchema) })),
  connectors: z.array(z.strictObject({
    id: z.enum(connectorIds),
    label: z.string(),
    description: z.string(),
    effect: z.enum(['read', 'write']),
    outputs: z.array(catalogueFieldSchema),
  })),
  limits: z.strictObject({
    runsPerVisitorPerDay: z.int(),
    generationsPerVisitorPerDay: z.int(),
    maxAttempts: z.int(),
    maxInjectedFailures: z.int(),
    maxNodes: z.int(),
    maxEdges: z.int(),
  }),
})

/** What a workflow may be made of. */
export type CatalogueView = z.infer<typeof catalogueViewSchema>

/** Turns a field table into the list the catalogue shows. */
function fieldList(fields: Readonly<Record<string, FieldSpec>>): z.infer<typeof catalogueFieldSchema>[] {
  return Object.entries(fields).map(([name, spec]) => ({ name, kind: spec.kind, description: spec.description, example: spec.example }))
}

/** Builds the catalogue the site shows, from the same lists the validator uses. */
export function buildCatalogue(): CatalogueView {
  return {
    triggers: triggerEventIds.map(id => ({ id, label: TRIGGER_EVENTS[id].label, fields: fieldList(TRIGGER_EVENTS[id].fields) })),
    connectors: connectorIds.map(id => ({
      id,
      label: CONNECTORS[id].label,
      description: CONNECTORS[id].description,
      effect: CONNECTORS[id].effect,
      outputs: fieldList(CONNECTORS[id].outputs),
    })),
    limits: {
      runsPerVisitorPerDay: RUN_LIMITS.runsPerVisitorPerDay,
      generationsPerVisitorPerDay: RUN_LIMITS.generationsPerVisitorPerDay,
      maxAttempts: RUN_LIMITS.maxAttempts,
      maxInjectedFailures: RUN_LIMITS.maxInjectedFailures,
      maxNodes: GRAPH_LIMITS.maxNodes,
      maxEdges: GRAPH_LIMITS.maxEdges,
    },
  }
}
