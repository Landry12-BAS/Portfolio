import { readFileSync } from 'node:fs'

import { parse, stringify } from 'yaml'
import { describe, expect, it } from 'vitest'

import { loadRouting, RoutingError } from '../../src/routing/load.ts'
import type { Routing } from '../../src/routing/load.ts'
import { planChain } from '../../src/routing/plan.ts'
import type { Capability } from '../../src/routing/schema.ts'

const committed = readFileSync(new URL('../../routing.yaml', import.meta.url), 'utf8')
const allKeys = {
  GROQ_API_KEY: 'k', CLOUDFLARE_API_TOKEN: 'k', CLOUDFLARE_ACCOUNT_ID: 'acc123', OPENROUTER_API_KEY: 'k', NVIDIA_API_KEY: 'k',
}
const chat: ReadonlySet<Capability> = new Set(['chat'])

// The edits break the file on purpose, in ways its schema type would forbid, so the
// parsed document is deliberately untyped here.
/* eslint-disable @typescript-eslint/no-explicit-any */
function edited(change: (doc: Record<string, any>) => void): string {
  const doc = parse(committed) as Record<string, any>
  change(doc)
  return stringify(doc)
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function issuesOf(text: string, env: Record<string, string> = allKeys): readonly string[] {
  try {
    loadRouting(text, env)
  }
  catch (error) {
    if (error instanceof RoutingError) return error.issues
    throw error
  }
  return []
}

describe('the committed routing table', () => {
  const routing: Routing = loadRouting(committed, allKeys)

  it('loads and fills the account ID into the Workers AI URL', () => {
    expect(routing.providers.get('workers-ai')?.baseUrl).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1')
    expect([...routing.aliases.keys()]).toEqual(['lb-fast', 'lb-tools', 'lb-reason', 'lb-long', 'lb-vision', 'lb-judge', 'lb-embed'])
  })

  it('reaches every provider over HTTPS', () => {
    for (const provider of routing.providers.values()) expect(provider.baseUrl).toMatch(/^https:\/\//)
  })

  it('keeps NVIDIA off every chain in production, whatever the data', () => {
    for (const alias of routing.aliases.values()) {
      const plan = planChain(alias, 'synthetic', 'production', new Set([alias.kind]))
      expect(plan.candidates.map(model => model.provider.key)).not.toContain('nvidia')
    }
  })

  it('gives visitor content a production route that never trains on it, on every alias', () => {
    for (const alias of routing.aliases.values()) {
      const plan = planChain(alias, 'visitor', 'production', new Set([alias.kind]))
      expect(plan.candidates.length).toBeGreaterThan(0)
      for (const model of plan.candidates) {
        expect(model.provider.trainsOnInputs).toBe(false)
        expect(model.provider.terms).toBe('production')
      }
    }
  })

  it('keeps interactive aliases inside Groq\'s tokens-per-minute limit', () => {
    for (const name of ['lb-fast', 'lb-tools', 'lb-reason']) {
      const alias = routing.aliases.get(name)!
      expect(alias.maxInputTokens + alias.maxOutputTokens).toBeLessThanOrEqual(8000 * routing.budgets.minuteCeiling)
    }
  })

  it('pins embeddings to one model', () => {
    expect(routing.aliases.get('lb-embed')?.chain.map(model => model.ref)).toEqual(['workers-ai/bge-m3'])
  })

  it('leaves a provider off the chains until its key is set', () => {
    const partial = loadRouting(committed, { GROQ_API_KEY: 'k' })
    const plan = planChain(partial.aliases.get('lb-fast')!, 'visitor', 'production', chat)
    expect(plan.candidates.map(model => model.ref)).toEqual(['groq/gpt-oss-20b'])
    expect(plan.excluded.map(entry => entry.reason)).toEqual(['not-configured', 'not-configured'])
  })
})

describe('mistakes the loader catches', () => {
  it('names every broken reference at once', () => {
    const issues = issuesOf(edited((doc) => {
      doc.aliases['lb-fast'].chain.push('groq/llama-5')
      doc.systems['lb-01'].aliases.push('lb-teleport')
    }))
    expect(issues).toEqual(['aliases.lb-fast: unknown model groq/llama-5', 'systems.lb-01: unknown alias lb-teleport'])
  })

  it('refuses a typo in a limit instead of ignoring it', () => {
    const issues = issuesOf(edited((doc) => {
      doc.providers.groq.models['gpt-oss-120b'].limits.day.tokenz = 5
    }))
    expect(issues.join()).toContain('providers.groq.models.gpt-oss-120b.limits.day')
  })

  it('refuses an embedding alias with a fallback', () => {
    const issues = issuesOf(edited((doc) => {
      doc.providers['workers-ai'].models['bge-m3-copy'] = { ...doc.providers['workers-ai'].models['bge-m3'] }
      doc.aliases['lb-embed'].chain.push('workers-ai/bge-m3-copy')
    }))
    expect(issues).toContain('aliases.lb-embed: embedding aliases are pinned to one model, since vectors from different models don\'t mix')
  })

  it('refuses a model that can\'t do what its alias is for', () => {
    const issues = issuesOf(edited((doc) => {
      doc.aliases['lb-fast'].chain.push('workers-ai/bge-m3')
    }))
    expect(issues).toContain('aliases.lb-fast: workers-ai/bge-m3 can\'t serve chat')
  })

  it('refuses an alias whose largest call would not fit a model\'s minute budget', () => {
    const issues = issuesOf(edited((doc) => {
      doc.aliases['lb-tools'].maxOutputTokens = 4000
    }))
    expect(issues).toContain('aliases.lb-tools: groq/gpt-oss-120b allows 7200 tokens a minute, less than the alias maximum of 8000')
  })

  it('refuses a model metered in Neurons without its rates', () => {
    const issues = issuesOf(edited((doc) => {
      delete doc.providers['workers-ai'].models['gpt-oss-20b'].neurons
    }))
    expect(issues).toContain('workers-ai/gpt-oss-20b is metered in Neurons but has no neurons rates')
  })

  it('refuses an alias that visitors could never use', () => {
    const issues = issuesOf(edited((doc) => {
      doc.aliases['lb-long'].chain = ['openrouter/nemotron-3-ultra']
    }))
    expect(issues).toContain('aliases.lb-long: no model can take visitor content in production')
  })

  it('refuses plain HTTP to a provider, except on loopback', () => {
    expect(issuesOf(edited((doc) => {
      doc.providers.groq.baseUrl = 'http://api.groq.com/openai/v1'
    }))).toContain('providers.groq.baseUrl must use https')
    expect(issuesOf(edited((doc) => {
      doc.providers.groq.baseUrl = 'http://127.0.0.1:8081/v1'
    }))).toEqual([])
  })

  it('refuses a visitor quota above the system\'s daily quota', () => {
    const issues = issuesOf(edited((doc) => {
      doc.systems['lb-01'].sessionDailyCalls = 1000
    }))
    expect(issues).toContain('systems.lb-01: sessionDailyCalls is above dailyCalls')
  })
})

describe('planning a chain', () => {
  const routing = loadRouting(committed, allKeys)
  const tools = routing.aliases.get('lb-tools')!

  it('keeps chain order and says why each model was left out', () => {
    const plan = planChain(tools, 'visitor', 'production', chat)
    expect(plan.candidates.map(model => model.ref)).toEqual(['groq/gpt-oss-120b', 'groq/qwen3.8-27b', 'workers-ai/gpt-oss-120b'])
    expect(plan.excluded.map(({ model, reason }) => [model.ref, reason])).toEqual([
      ['openrouter/qwen3.8-27b', 'visitor-data'],
      ['nvidia/nemotron-3-super', 'terms'],
    ])
  })

  it('offers synthetic samples the rest of the production chain', () => {
    const plan = planChain(tools, 'synthetic', 'production', chat)
    expect(plan.candidates.map(model => model.ref)).toContain('openrouter/qwen3.8-27b')
  })

  it('drops models without a capability the call needs', () => {
    const plan = planChain(tools, 'synthetic', 'dev', new Set<Capability>(['chat', 'json_schema']))
    expect(plan.candidates.map(model => model.ref)).toEqual(['groq/gpt-oss-120b', 'openrouter/qwen3.8-27b'])
  })
})
