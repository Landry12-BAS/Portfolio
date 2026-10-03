// The read-only tools the specialists may call over the simulator: a window of one metric of one
// service, the log signatures of a window, and the deploys of a window. Every result is bounded (at
// most LB06_LIMITS.maxToolRows rows), every row carries the evidence id a finding may cite, and
// nothing here can change the shop. The arguments come from a model, so each is checked by a strict
// schema with closed lists and bounded numbers before the tool runs.
import { LB06_LIMITS, LB06_METRICS, LB06_SERVICES } from '@lb/contracts'
import type { Lb06Metric, Lb06Service, Lb06Tool } from '@lb/contracts'
import { z } from 'zod'

import { divergenceId, signatureId } from '../detect/correlate.ts'
import type { World } from '../sim/world.ts'

const MAX_ROWS = LB06_LIMITS.maxToolRows

/** The arguments of each tool. A window is the last `lastMinutes` minutes of the world the agents see. */
export const toolArgsSchemas = {
  query_metrics: z.strictObject({
    service: z.enum(LB06_SERVICES),
    metric: z.enum(LB06_METRICS),
    lastMinutes: z.int().min(2).max(60).default(20),
  }),
  query_logs: z.strictObject({
    service: z.enum(LB06_SERVICES).optional(),
    lastMinutes: z.int().min(1).max(60).default(15),
    // Only the signatures the baseline never showed.
    onlyNew: z.boolean().default(false),
  }),
  list_deploys: z.strictObject({
    service: z.enum(LB06_SERVICES).optional(),
    lastMinutes: z.int().min(5).max(240).default(120),
  }),
} as const

/** A tool call as a model asks for it: the tool and its arguments, checked. */
export const toolCallSchema = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('query_metrics'), args: toolArgsSchemas.query_metrics }),
  z.strictObject({ tool: z.literal('query_logs'), args: toolArgsSchemas.query_logs }),
  z.strictObject({ tool: z.literal('list_deploys'), args: toolArgsSchemas.list_deploys }),
])
/** A checked tool call. */
export type ToolCall = z.infer<typeof toolCallSchema>

/** One row of a metric window. */
export interface MetricRow {
  evidence: string
  minute: number
  value: number
}

/** One row of a log window. */
export interface LogSignatureRow {
  evidence: string
  service: Lb06Service
  signature: string
  count: number
  firstSeen: number
  lastSeen: number
  new: boolean
  sample: string
}

/** One row of a deploy window. */
export interface DeployRow {
  evidence: string
  id: string
  service: Lb06Service
  version: string
  previousVersion: string
  minute: number
  by: string
  note: string
}

/** What a tool answered: its rows, and the baseline for a metric. */
export type ToolResult
  = | { tool: 'query_metrics', service: Lb06Service, metric: Lb06Metric, baselineMean: number, rows: MetricRow[] }
    | { tool: 'query_logs', rows: LogSignatureRow[] }
    | { tool: 'list_deploys', rows: DeployRow[] }

/** Rounds a value for a tool's answer. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Picks at most MAX_ROWS minutes of a window, evenly, always keeping the last one. */
function sampleMinutes(from: number, to: number): number[] {
  const count = to - from + 1
  if (count <= MAX_ROWS) return Array.from({ length: count }, (_, index) => from + index)
  const step = (count - 1) / (MAX_ROWS - 1)
  return Array.from({ length: MAX_ROWS }, (_, index) => Math.round(from + index * step))
}

/** A window of one metric of one service, sampled to at most MAX_ROWS minutes, with the baseline mean beside it. */
function queryMetrics(world: World, args: z.infer<typeof toolArgsSchemas.query_metrics>): ToolResult {
  const values = world.series[args.service][args.metric]
  const to = world.minutes - 1
  const from = Math.max(0, to - args.lastMinutes + 1)
  const baseline = values.slice(0, world.scenario.baselineMinutes)
  const baselineMean = baseline.reduce((sum, value) => sum + value, 0) / Math.max(1, baseline.length)
  return {
    tool: 'query_metrics',
    service: args.service,
    metric: args.metric,
    baselineMean: round(baselineMean),
    rows: sampleMinutes(from, to).map(minute => ({ evidence: divergenceId(args.service, args.metric, minute), minute, value: values[minute] ?? 0 })),
  }
}

/** The signatures of a window, biggest counts first, new ones marked, at most MAX_ROWS. */
function queryLogs(world: World, args: z.infer<typeof toolArgsSchemas.query_logs>): ToolResult {
  const to = world.minutes - 1
  const from = Math.max(0, to - args.lastMinutes + 1)
  const baselineSignatures = new Set(world.logs.filter(row => row.minute < world.scenario.baselineMinutes).map(row => row.signature))
  const rows = new Map<string, LogSignatureRow>()
  for (const row of world.logs) {
    if (row.minute < from || row.minute > to) continue
    if (args.service !== undefined && row.service !== args.service) continue
    const isNew = !baselineSignatures.has(row.signature)
    if (args.onlyNew && !isNew) continue
    const existing = rows.get(row.signature)
    if (existing) {
      existing.count += row.count
      existing.lastSeen = Math.max(existing.lastSeen, row.minute)
      existing.firstSeen = Math.min(existing.firstSeen, row.minute)
    }
    else {
      rows.set(row.signature, { evidence: signatureId(row.signature), service: row.service, signature: row.signature, count: row.count, firstSeen: row.minute, lastSeen: row.minute, new: isNew, sample: row.sample })
    }
  }
  // New signatures first, then by count: the ordinary request lines never crowd out what changed.
  const sorted = [...rows.values()].sort((a, b) => Number(b.new) - Number(a.new) || b.count - a.count)
  return { tool: 'query_logs', rows: sorted.slice(0, MAX_ROWS) }
}

/** The deploys of a window, latest first, at most MAX_ROWS. */
function listDeploys(world: World, args: z.infer<typeof toolArgsSchemas.list_deploys>): ToolResult {
  const to = world.minutes - 1
  const from = to - args.lastMinutes + 1
  const rows = world.deploys
    .filter(deploy => deploy.minute >= from && deploy.minute <= to && (args.service === undefined || deploy.service === args.service))
    .sort((a, b) => b.minute - a.minute)
    .slice(0, MAX_ROWS)
    .map(deploy => ({ evidence: `deploy:${deploy.id}`, id: deploy.id, service: deploy.service, version: deploy.version, previousVersion: deploy.previousVersion, minute: deploy.minute, by: deploy.by, note: deploy.note }))
  return { tool: 'list_deploys', rows }
}

/** Runs one checked tool call over the world. */
export function runTool(world: World, call: ToolCall): ToolResult {
  switch (call.tool) {
    case 'query_metrics': return queryMetrics(world, call.args)
    case 'query_logs': return queryLogs(world, call.args)
    case 'list_deploys': return listDeploys(world, call.args)
  }
}

/** The arguments of a call as a flat record, for the step event. */
export function flatArgs(call: ToolCall): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(call.args).filter(([, value]) => value !== undefined)) as Record<string, string | number | boolean>
}

/** The tools, for the prompts. */
export const TOOLS: readonly Lb06Tool[] = ['query_logs', 'query_metrics', 'list_deploys']
