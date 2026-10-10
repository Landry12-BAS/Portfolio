// A contract between LB-06 and the gateway's routing table, and between the code's limits and the
// datasheet: the step cap the orchestrator enforces is the cap the gateway holds, the daily calls
// are one incident at the cap, the aliases are the ones the agents ask for, the site's server may
// read LB-06's traces, and the datasheet promises the numbers the code enforces.
import { readFileSync } from 'node:fs'

import { LB06_LIMITS } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { loadRouting } from '../../../gateway/src/routing/load.ts'
import { estimateChatInput } from '../../../gateway/src/budget/estimate.ts'
import type { ChatRequest } from '../../../gateway/src/schemas/chat.ts'
import { ALIASES, MAX_OUTPUT_TOKENS } from '../../src/modules/lb06/agents/model.ts'
import { rankingPrompt } from '../../src/modules/lb06/agents/prompts.ts'
import { summarise } from '../../src/modules/lb06/detect/summary.ts'
import { ReferenceAgents } from '../../src/modules/lb06/golden/reference.ts'
import { buildWorld } from '../../src/modules/lb06/sim/world.ts'
import { goldenCases } from '../support/lb06.ts'

const routing = loadRouting(readFileSync(new URL('../../../gateway/routing.yaml', import.meta.url), 'utf8'), {
  GROQ_API_KEY: 'k',
  CLOUDFLARE_API_TOKEN: 'k',
  CLOUDFLARE_ACCOUNT_ID: 'acc123',
  OPENROUTER_API_KEY: 'k',
  NVIDIA_API_KEY: 'k',
})
const system = routing.systems.get('lb-06')

describe('LB-06\'s entry in routing.yaml', () => {
  it('exists, for the Node service, with the agents\' aliases and the guard', () => {
    expect(system?.service).toBe('node-systems')
    expect([...(system?.aliases ?? [])].sort()).toEqual([ALIASES.reason, ALIASES.tools, 'lb-guard'].sort())
  })

  it('caps a run at the step cap and a visitor\'s day at one incident', () => {
    expect(system?.maxCallsPerRun).toBe(LB06_LIMITS.stepCap)
    expect(system?.sessionDailyCalls).toBe(LB06_LIMITS.stepCap * LB06_LIMITS.incidentsPerVisitorPerDay)
    expect(system?.dailyCalls).toBeGreaterThanOrEqual(LB06_LIMITS.stepCap * 10)
  })

  it('lets the site\'s server read LB-06\'s traces', () => {
    expect(routing.traceReaders.get('web')?.systems).toContain('lb-06')
  })

  it('gives the models the output each alias allows, and the largest ranking prompt fits the reasoning alias', () => {
    expect(routing.aliases.get(ALIASES.reason)?.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS.reason)
    expect(routing.aliases.get(ALIASES.tools)?.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS.tools)
    // The ranking reads the summary and three full reports: the biggest request the commander makes.
    const entry = goldenCases().find(candidate => candidate.fault === 'cache_stampede')
    if (!entry) throw new Error('no case')
    const world = buildWorld({ seed: entry.seed, fault: entry.fault, params: { version: 'x'.repeat(40), flag: 'y'.repeat(40) }, baselineMinutes: LB06_LIMITS.baselineMinutes }, [], 40)
    const summary = summarise(world)
    const report = { agent: 'logs' as const, findings: Array.from({ length: 5 }, (_, index) => ({ text: `finding ${index} `.padEnd(240, 'x'), evidence: ['log:a', 'log:b', 'log:c', 'log:d', 'log:e', 'log:f'] })), toolCalls: Array.from({ length: 4 }, () => ({ tool: 'query_logs' as const, args: { lastMinutes: 60, onlyNew: true }, rows: 12 })) }
    const messages = rankingPrompt(summary, [report, { ...report, agent: 'metrics' }, { ...report, agent: 'deploys' }], [])
    const request: ChatRequest = { model: ALIASES.reason, messages: messages.map(message => ({ role: message.role, content: message.content })) }
    const alias = routing.aliases.get(ALIASES.reason)
    expect(alias).toBeDefined()
    expect(estimateChatInput(request)).toBeLessThanOrEqual(alias?.maxInputTokens ?? 0)
    void ReferenceAgents
  })
})

describe('the datasheet', () => {
  it('promises the limits the code enforces', () => {
    const datasheet = readFileSync(new URL('../../../../apps/web/shared/data/systems.ts', import.meta.url), 'utf8')
    const czech = readFileSync(new URL('../../../../apps/web/shared/data/systems.cs.ts', import.meta.url), 'utf8')
    for (const text of [datasheet, czech]) {
      expect(text).toContain(`value: '${LB06_LIMITS.incidentsPerVisitorPerDay}'`)
      expect(text).toContain(`value: '${LB06_LIMITS.stepCap}'`)
    }
  })
})
