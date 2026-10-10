// A contract between LB-08 and the gateway's routing table. The service decides how many
// model calls a description may take, how many prompts a visitor may send a day and how
// big a request can get; the gateway enforces its own numbers for the same things. If the
// two disagree, a visitor would meet a gateway refusal in the middle of a repair, or a
// quota the datasheet doesn't promise. These tests load the real services/gateway/routing.yaml
// with the gateway's own loader and compare, so a change on either side fails here.
import { readFileSync } from 'node:fs'

import { GRAPH_LIMITS, RUN_LIMITS } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { loadRouting } from '../../../gateway/src/routing/load.ts'
import { estimateChatInput } from '../../../gateway/src/budget/estimate.ts'
import type { ChatRequest } from '../../../gateway/src/schemas/chat.ts'
import { DESCRIBE_ALIAS } from '../../src/modules/lb08/generate/model.ts'
import { MAX_MODEL_CALLS } from '../../src/modules/lb08/generate/pipeline.ts'
import { DESCRIBE_MAX_OUTPUT_TOKENS, describeSystemPrompt, describeUserMessage, repairMessages } from '../../src/modules/lb08/generate/prompts.ts'
import { loadGolden } from '../support/data.ts'

const routing = loadRouting(readFileSync(new URL('../../../gateway/routing.yaml', import.meta.url), 'utf8'), {
  GROQ_API_KEY: 'k',
  CLOUDFLARE_API_TOKEN: 'k',
  CLOUDFLARE_ACCOUNT_ID: 'acc123',
  OPENROUTER_API_KEY: 'k',
  NVIDIA_API_KEY: 'k',
})
const system = routing.systems.get('lb-08')
const alias = routing.aliases.get(DESCRIBE_ALIAS)

describe('LB-08\'s entry in routing.yaml', () => {
  it('exists, for the Node service, and lets it use only the alias it describes workflows with', () => {
    expect(system).toBeDefined()
    expect(system?.service).toBe('node-systems')
    expect(system?.aliases).toEqual([DESCRIBE_ALIAS])
    expect(alias?.kind).toBe('chat')
  })

  it('allows a description its first call and its repair, and one call to spare', () => {
    expect(MAX_MODEL_CALLS).toBe(2)
    expect(system?.maxCallsPerRun).toBeGreaterThanOrEqual(MAX_MODEL_CALLS)
    expect(system?.maxCallsPerRun).toBeLessThanOrEqual(MAX_MODEL_CALLS + 1)
  })

  it('lets a visitor describe as many workflows a day as the service allows, at the cap of calls each', () => {
    expect(system?.sessionDailyCalls).toBeGreaterThanOrEqual(RUN_LIMITS.generationsPerVisitorPerDay * (system?.maxCallsPerRun ?? 0))
  })

  it('leaves the day\'s budget room for a full pass of the golden set at its worst, and for a visitor besides', () => {
    const worstEvalCalls = loadGolden().length * MAX_MODEL_CALLS

    expect(system?.dailyCalls).toBeGreaterThanOrEqual(worstEvalCalls + (system?.sessionDailyCalls ?? 0))
  })
})

describe('who may read LB-08\'s traces', () => {
  // The routing table the service's gateway tests, and a harness that follows the web README, start the gateway on.
  const miniature = loadRouting(readFileSync(new URL('../support/routing.lb08.yaml', import.meta.url), 'utf8'), { ALPHA_URL: 'http://127.0.0.1:1', ALPHA_KEY: 'k' })

  it('lists the site\'s server as a reader of lb-08 in the real table, which is how the Scope shows a run', () => {
    expect(routing.traceReaders.get('web')?.systems.has('lb-08')).toBe(true)
  })

  it('lists it in the test table too, so a gateway started on that table does not refuse the Scope with a 403', () => {
    expect(miniature.traceReaders.get('web')?.systems.has('lb-08')).toBe(true)
  })

  it('keeps the test table\'s readers to the ones the real table has, so the test table does not grant more', () => {
    for (const [service, reader] of miniature.traceReaders) {
      const granted = routing.traceReaders.get(service)?.systems
      expect([...reader.systems].every(key => granted?.has(key))).toBe(true)
    }
  })
})

describe('the lb-tools alias', () => {
  it('takes the longest request the pipeline can make: the repair of the longest description', () => {
    const first = [{ role: 'system' as const, content: describeSystemPrompt() }, { role: 'user' as const, content: describeUserMessage('x'.repeat(GRAPH_LIMITS.maxDescriptionLength)) }]
    const issues = Array.from({ length: 30 }, () => ({ code: 'invalid_param' as const, path: 'nodes.15.params.fields.orderId', message: 'q'.repeat(400) }))
    const worst = repairMessages(first, { kind: 'text', text: 'y'.repeat(50_000) }, issues)

    const tokens = estimateChatInput({ model: DESCRIBE_ALIAS, messages: worst } as unknown as ChatRequest)

    expect(tokens).toBeLessThanOrEqual(alias?.maxInputTokens ?? 0)
  })

  it('lets the model write the longest workflow the service accepts', () => {
    expect(alias?.maxOutputTokens).toBeGreaterThanOrEqual(DESCRIBE_MAX_OUTPUT_TOKENS)
  })

  it('is served by a model that may be given a visitor\'s own words', () => {
    expect(alias?.chain.some(model => !model.provider.trainsOnInputs)).toBe(true)
  })
})

describe('the datasheet', () => {
  const sheet = readFileSync(new URL('../../../../apps/web/shared/data/systems.ts', import.meta.url), 'utf8')
  const entry = sheet.slice(sheet.indexOf('slug: \'lb-08\''), sheet.indexOf('slug: \'lb-09\''))

  it('promises the runs a visitor may start in a day that the service enforces', () => {
    expect(entry).toContain(`{ label: 'Workflow runs per visitor per day', value: '${RUN_LIMITS.runsPerVisitorPerDay}' }`)
  })

  it('promises the retries the engine makes', () => {
    expect(entry).toContain(`{ label: 'Retries', value: '${RUN_LIMITS.maxAttempts}, exponential backoff' }`)
  })

  it('estimates the model calls for a workflow in a range the pipeline stays inside', () => {
    const range = /Model calls per workflow \(est\.\)', value: '(\d)–(\d)'/.exec(entry)

    expect(Number(range?.[1])).toBe(1)
    expect(Number(range?.[2])).toBeGreaterThanOrEqual(MAX_MODEL_CALLS)
  })
})
