// The orchestrator's rules with scripted models: one repair and no more, the step cap enforced by
// code, a proposal checked against the deploy history and the flags, tool calls checked and bounded,
// and a postmortem whose references are not in the log left out rather than shown.
import { LB06_LIMITS } from '@lb/contracts'
import type { Lb06Event, Lb06EventInput } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { contextOf, investigate, ModelOutputInvalid, StepCapReached, writePostmortem } from '../../src/modules/lb06/agents/orchestrator.ts'
import { timelineOf } from '../../src/modules/lb06/agents/postmortem.ts'
import { runTool, toolCallSchema } from '../../src/modules/lb06/agents/tools.ts'
import { evidenceIndex } from '../../src/modules/lb06/detect/summary.ts'
import { ReferenceAgents } from '../../src/modules/lb06/golden/reference.ts'
import { scenarioOf } from '../../src/modules/lb06/golden/cases.ts'
import { MemoryLog } from '../../src/modules/lb06/golden/run.ts'
import { buildWorld } from '../../src/modules/lb06/sim/world.ts'
import { goldenCase, inRun, recordingTracer, replies } from '../support/lb06.ts'
import type { ScriptedModel } from '../support/lb06.ts'

/** The world of a case a few minutes after its fault, with its context. */
function contextFor(id: string) {
  const scenario = scenarioOf(goldenCase(id))
  const world = buildWorld(scenario, [], scenario.baselineMinutes + 4)
  return { world, context: contextOf(world, evidenceIndex(world, ['incident.started', 'fault.injected'])) }
}

/** Orchestrator dependencies over a memory log. */
function deps(models: { reason: ScriptedModel | ReferenceAgents, tools: ScriptedModel | ReferenceAgents }) {
  const log = new MemoryLog()
  const { tracer } = recordingTracer()
  return { deps: { models, tracer, emit: async (event: Lb06EventInput) => void log.append(event) }, log }
}

const GOOD_PLAN = { kind: 'json' as const, value: { questions: [{ agent: 'logs', question: 'What is new?' }] } }
const GOOD_FINDINGS = { kind: 'json' as const, value: { findings: [{ text: 'cart throws', evidence: ['log:cart.npe'] }] } }
const GOOD_RANKING = { kind: 'json' as const, value: { hypotheses: [{ id: 'h1', service: 'cart', cause: 'bad_deploy', confidence: 0.9, summary: 'bad deploy', evidence: ['deploy:d6'] }], proposal: { hypothesisId: 'h1', action: { kind: 'rollback', service: 'cart', toVersion: '2.13.4' }, rationale: 'undo it' } } }

describe('the orchestrator', () => {
  it('repairs an unusable answer once, then gives up', async () => {
    const { context } = contextFor('bad-deploy-cart')
    const reason = replies({ kind: 'text', text: 'not json' }, GOOD_PLAN, GOOD_RANKING)
    const tools = replies(GOOD_FINDINGS)
    const { deps: d, log } = deps({ reason, tools })
    const budget = { cap: LB06_LIMITS.stepCap, used: 0 }
    const result = await inRun(() => investigate(d, context, budget))
    expect(result.proposal.action).toEqual({ kind: 'rollback', service: 'cart', toVersion: '2.13.4' })
    expect(budget.used).toBe(4)
    expect(reason.conversations[1]?.at(-1)?.content).toContain('That answer could not be used')
    expect(log.events.find((event): event is Extract<Lb06Event, { kind: 'agent.step' }> => event.kind === 'agent.step')?.data.kind).toBe('repair')

    const twice = replies({ kind: 'text', text: 'no' }, { kind: 'json', value: { questions: [] } })
    await expect(inRun(() => investigate(deps({ reason: twice, tools }).deps, context, { cap: 15, used: 0 }))).rejects.toBeInstanceOf(ModelOutputInvalid)
  })

  it('never makes a call past the step cap, whatever the model would say', async () => {
    const { context } = contextFor('slow-payment-provider')
    const agents = new ReferenceAgents()
    const { deps: d } = deps({ reason: agents, tools: agents })
    const budget = { cap: 3, used: 0 }
    await expect(inRun(() => investigate(d, context, budget))).rejects.toBeInstanceOf(StepCapReached)
    expect(budget.used).toBe(3)
    expect(agents.conversations).toHaveLength(3)
    // A budget already spent (the guard's call counts) leaves fewer steps.
    const spent = { cap: 15, used: 15 }
    await expect(inRun(() => investigate(d, context, spent))).rejects.toBeInstanceOf(StepCapReached)
    expect(await inRun(() => writePostmortem(d, [], spent, 40))).toBeNull()
  })

  it('refuses a proposal that names a version the history does not show or a flag the shop lacks, and takes the repaired one', async () => {
    const { context } = contextFor('bad-deploy-cart')
    const badVersion = { kind: 'json' as const, value: { ...GOOD_RANKING.value, proposal: { ...GOOD_RANKING.value.proposal, action: { kind: 'rollback', service: 'cart', toVersion: '9.9.9' } } } }
    const badFlag = { kind: 'json' as const, value: { ...GOOD_RANKING.value, proposal: { ...GOOD_RANKING.value.proposal, action: { kind: 'flip_flag', flag: 'no-such-flag', value: true } } } }
    const reason = replies(GOOD_PLAN, badVersion, GOOD_RANKING)
    const { deps: d } = deps({ reason, tools: replies(GOOD_FINDINGS) })
    const result = await inRun(() => investigate(d, context, { cap: 15, used: 0 }))
    expect(result.proposal.action).toEqual(GOOD_RANKING.value.proposal.action)
    expect(reason.conversations[2]?.at(-1)?.content).toContain('no version 9.9.9')
    const reason2 = replies(GOOD_PLAN, badFlag, badFlag)
    await expect(inRun(() => investigate(deps({ reason: reason2, tools: replies(GOOD_FINDINGS) }).deps, context, { cap: 15, used: 0 }))).rejects.toBeInstanceOf(ModelOutputInvalid)
  })

  it('runs a specialist\'s tool calls itself, then asks for findings on a last turn that must answer', async () => {
    const { context } = contextFor('cache-stampede')
    const tools = replies(
      { kind: 'json', value: { toolCalls: [{ tool: 'query_logs', args: { onlyNew: true } }, { tool: 'list_deploys', args: {} }] } },
      { kind: 'json', value: { toolCalls: [{ tool: 'query_logs', args: {} }] } },
    )
    const restart = { kind: 'json' as const, value: { ...GOOD_RANKING.value, proposal: { ...GOOD_RANKING.value.proposal, action: { kind: 'restart', service: 'cache' } } } }
    const { deps: d, log } = deps({ reason: replies(GOOD_PLAN, restart), tools })
    const result = await inRun(() => investigate(d, context, { cap: 15, used: 0 }))
    const report = result.reports[0]
    expect(report?.toolCalls.map(call => call.tool)).toEqual(['query_logs', 'list_deploys'])
    expect(report?.findings).toEqual([])
    expect(tools.conversations).toHaveLength(2)
    expect(tools.conversations[1]?.[0]?.content).toContain('This is your last turn')
    expect(tools.conversations[1]?.at(-1)?.content).toContain('<data name="tool-results">')
    expect(log.events.filter(event => event.kind === 'agent.step' && event.data.kind === 'tool_call')).toHaveLength(2)
  })

  it('bounds every tool\'s rows and refuses arguments outside the closed lists', () => {
    const { world } = contextFor('memory-leak-inventory')
    const metrics = runTool(world, toolCallSchema.parse({ tool: 'query_metrics', args: { service: 'inventory', metric: 'memory_mb', lastMinutes: 60 } }))
    expect(metrics.rows.length).toBeLessThanOrEqual(LB06_LIMITS.maxToolRows)
    if (metrics.tool === 'query_metrics') expect(metrics.rows.at(-1)?.minute).toBe(world.minutes - 1)
    const logs = runTool(world, toolCallSchema.parse({ tool: 'query_logs', args: { lastMinutes: 60 } }))
    expect(logs.rows.length).toBeLessThanOrEqual(LB06_LIMITS.maxToolRows)
    expect(logs.rows.every(row => row.evidence.startsWith('log:'))).toBe(true)
    expect(toolCallSchema.safeParse({ tool: 'query_metrics', args: { service: 'mail', metric: 'memory_mb' } }).success).toBe(false)
    expect(toolCallSchema.safeParse({ tool: 'query_logs', args: { lastMinutes: 999 } }).success).toBe(false)
    expect(toolCallSchema.safeParse({ tool: 'drop_table', args: {} }).success).toBe(false)
  })

  it('drops the evidence an agent cites that the server does not hold, and counts it', async () => {
    const { context } = contextFor('bad-deploy-cart')
    const ranking = { kind: 'json' as const, value: { ...GOOD_RANKING.value, hypotheses: [{ ...GOOD_RANKING.value.hypotheses[0], evidence: ['deploy:d6', 'deploy:d42', 'log:made.up'] }] } }
    const { deps: d, log } = deps({ reason: replies(GOOD_PLAN, ranking), tools: replies({ kind: 'json', value: { findings: [{ text: 'x', evidence: ['metric:cart:error_rate:31', 'metric:cart:error_rate:999'] }] } }) })
    const result = await inRun(() => investigate(d, context, { cap: 15, used: 0 }))
    expect(result.hypotheses[0]?.evidence).toEqual(['deploy:d6'])
    expect(result.reports[0]?.findings[0]?.evidence).toEqual(['metric:cart:error_rate:31'])
    expect(result.discarded).toBe(3)
    expect(log.events.filter(event => event.kind === 'evidence.discarded').map(event => event.data)).toEqual([{ agent: 'logs', count: 1 }, { agent: 'commander', count: 2 }])
  })

  it('leaves the postmortem\'s prose out when its references are not in the log, even after a repair', async () => {
    const timeline = timelineOf(new MemoryLog().events)
    const log = new MemoryLog()
    log.append({ kind: 'fault.injected', minute: 30, data: { fault: 'bad_deploy', service: 'cart' } })
    log.append({ kind: 'slo.recovered', minute: 50, data: { healthyMinutes: 5 } })
    const good = { summary: 's', rootCause: 'r', whatWentWell: 'w', actionItems: ['a'], references: ['fault.injected'] }
    const bad = { ...good, references: ['fault.injected', 'proposal.approved'] }
    const reason = replies({ kind: 'json', value: bad }, { kind: 'json', value: bad })
    const { deps: d } = deps({ reason, tools: replies() })
    expect(await inRun(() => writePostmortem(d, timelineOf(log.events), { cap: 15, used: 0 }, 50))).toBeNull()
    expect(reason.conversations[1]?.at(-1)?.content).toContain('proposal.approved')
    const fixed = replies({ kind: 'json', value: bad }, { kind: 'json', value: good })
    expect(await inRun(() => writePostmortem(deps({ reason: fixed, tools: replies() }).deps, timelineOf(log.events), { cap: 15, used: 0 }, 50))).toEqual(good)
    expect(timeline).toEqual([])
  })
})
