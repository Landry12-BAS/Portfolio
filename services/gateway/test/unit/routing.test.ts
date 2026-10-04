// Unit tests for the routing table: the committed routing.yaml, the mistakes the loader
// catches, and how a chain is planned.
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
/** Returns the committed routing.yaml with one deliberate change applied. */
function edited(change: (doc: Record<string, any>) => void): string {
  const doc = parse(committed) as Record<string, any>
  change(doc)
  return stringify(doc)
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Loads a routing document and returns the problems found (none when it is valid). */
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

  it('loads and fills the account ID into both Workers AI URLs', () => {
    const workers = routing.providers.get('workers-ai')
    expect(workers?.baseUrl).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1')
    expect(workers?.runUrl).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/ai/run')
    expect([...routing.aliases.keys()]).toEqual([
      'lb-fast', 'lb-tools', 'lb-reason', 'lb-long', 'lb-vision', 'lb-judge', 'lb-embed', 'lb-rerank', 'lb-guard', 'lb-stt',
    ])
  })

  it('reaches every provider over HTTPS', () => {
    for (const provider of routing.providers.values()) {
      expect(provider.baseUrl).toMatch(/^https:\/\//)
      if (provider.runUrl !== undefined) expect(provider.runUrl).toMatch(/^https:\/\//)
    }
  })

  it('guards visitor text with Prompt Guard only, flagging at 0.9', () => {
    const guard = routing.aliases.get('lb-guard')!
    expect(guard.threshold).toBe(0.9)
    expect(guard.chain.map(model => model.ref)).toEqual(['groq/llama-prompt-guard-2-86m', 'groq/llama-prompt-guard-2-22m'])
  })

  it('reranks with Workers AI\'s reranker, whose logits the gateway maps to 0 to 1', () => {
    const [reranker] = routing.aliases.get('lb-rerank')!.chain
    expect(reranker?.ref).toBe('workers-ai/bge-reranker-base')
    expect(reranker?.scores).toBe('logits')
  })

  it('transcribes with Groq\'s Whisper, then Workers AI\'s, limited in seconds of audio', () => {
    const stt = routing.aliases.get('lb-stt')!
    expect(stt.kind).toBe('transcription')
    expect(stt.chain.map(model => model.ref)).toEqual(['groq/whisper-large-v3-turbo', 'workers-ai/whisper-large-v3-turbo'])
    expect(stt.maxAudioSeconds).toBe(60)
    expect(stt.maxInputTokens).toBe(0)

    const [groq, workers] = stt.chain
    expect(groq?.api).toBe('openai')
    expect(groq?.limits?.hour?.audioSeconds).toBe(7200)
    expect(groq?.limits?.day).toEqual({ requests: 2000, audioSeconds: 28_800 })
    expect(workers?.api).toBe('run')
    expect(workers?.neuronsPerAudioMinute).toBe(46.63)
  })

  it('gives LB-01 every alias its ticket pipeline needs', () => {
    expect(routing.systems.get('lb-01')?.aliases).toEqual(['lb-fast', 'lb-tools', 'lb-embed', 'lb-rerank', 'lb-guard'])
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

  it('refuses a reranker without its provider\'s own endpoint or a score format', () => {
    const issues = issuesOf(edited((doc) => {
      delete doc.providers['workers-ai'].runUrl
      delete doc.providers['workers-ai'].models['bge-reranker-base'].scores
    }))
    expect(issues).toEqual([
      'workers-ai/bge-reranker-base reranks, so providers.workers-ai needs a runUrl',
      'workers-ai/bge-reranker-base reranks, so it needs scores: logits or probabilities',
      'workers-ai/whisper-large-v3-turbo is served by the provider\'s own API, so providers.workers-ai needs a runUrl',
    ])
  })

  it('refuses a score format on a model that doesn\'t rerank', () => {
    const issues = issuesOf(edited((doc) => {
      doc.providers['workers-ai'].models['bge-m3'].scores = 'logits'
    }))
    expect(issues).toEqual(['workers-ai/bge-m3: scores only applies to rerankers'])
  })

  it('refuses a guard without a threshold, and a threshold anywhere else', () => {
    const issues = issuesOf(edited((doc) => {
      delete doc.aliases['lb-guard'].threshold
      doc.aliases['lb-fast'].threshold = 0.5
    }))
    expect(issues).toEqual(['aliases.lb-fast: only guard aliases have a threshold', 'aliases.lb-guard: guard aliases need a threshold'])
  })

  it('refuses a speech-to-text alias with no length limit, or with one in tokens', () => {
    const issues = issuesOf(edited((doc) => {
      delete doc.aliases['lb-stt'].maxAudioSeconds
      doc.aliases['lb-stt'].maxInputTokens = 3000
    }))
    expect(issues).toEqual([
      'aliases.lb-stt: speech-to-text aliases need maxAudioSeconds',
      'aliases.lb-stt: speech-to-text aliases are limited in seconds, not tokens',
    ])
  })

  it('refuses a length limit on any other kind of alias, and a chat alias without a token limit', () => {
    const issues = issuesOf(edited((doc) => {
      doc.aliases['lb-fast'].maxAudioSeconds = 60
      delete doc.aliases['lb-tools'].maxInputTokens
    }))
    expect(issues).toEqual([
      'aliases.lb-fast: only speech-to-text aliases have maxAudioSeconds',
      'aliases.lb-tools: aliases need maxInputTokens',
    ])
  })

  it('refuses a speech-to-text model that could never take the longest recording its alias allows', () => {
    const issues = issuesOf(edited((doc) => {
      doc.providers.groq.models['whisper-large-v3-turbo'].limits.hour.audioSeconds = 50
      doc.providers.groq.models['whisper-large-v3-turbo'].limits.day.audioSeconds = 59
    }))
    expect(issues).toEqual([
      'aliases.lb-stt: groq/whisper-large-v3-turbo allows 45 audio seconds a hour, less than the alias maximum of 60',
      'aliases.lb-stt: groq/whisper-large-v3-turbo allows 56 audio seconds a day, less than the alias maximum of 60',
    ])
  })

  it('refuses audio rates on the wrong kind of model, and a speech-to-text model with no rate', () => {
    const issues = issuesOf(edited((doc) => {
      doc.providers['workers-ai'].models['gpt-oss-20b'].neuronsPerAudioMinute = 46.63
      doc.providers['workers-ai'].models['whisper-large-v3-turbo'].neurons = { input: 1, output: 1 }
      delete doc.providers['workers-ai'].models['whisper-large-v3-turbo'].neuronsPerAudioMinute
    }))
    expect(issues).toEqual([
      'workers-ai/gpt-oss-20b: neuronsPerAudioMinute only applies to speech-to-text models',
      'workers-ai/whisper-large-v3-turbo is metered in Neurons but has no neurons rates',
      'workers-ai/whisper-large-v3-turbo: a speech-to-text model is priced by neuronsPerAudioMinute, not by token',
    ])
  })

  it('refuses plain HTTP to a provider\'s own endpoint too', () => {
    const issues = issuesOf(edited((doc) => {
      doc.providers['workers-ai'].runUrl = 'http://api.cloudflare.com/ai/run'
    }))
    expect(issues).toContain('providers.workers-ai.runUrl must use https')
  })

  it('refuses a visitor quota above the system\'s daily quota', () => {
    const issues = issuesOf(edited((doc) => {
      doc.systems['lb-01'].sessionDailyCalls = 1000
    }))
    expect(issues).toContain('systems.lb-01: sessionDailyCalls is above dailyCalls')
  })
})

describe('trace readers', () => {
  it('lets the site\'s server read the traces of the five systems that have a board, and no other service', () => {
    const routing = loadRouting(committed, allKeys)

    expect([...routing.traceReaders.keys()]).toEqual(['web'])
    expect([...(routing.traceReaders.get('web')?.systems ?? [])]).toEqual(['lb-01', 'lb-02', 'lb-05', 'lb-08', 'lb-03', 'lb-04'])
  })

  it('never lets a reader own a system, so no reader can make a model call', () => {
    const routing = loadRouting(committed, allKeys)
    const owners = new Set([...routing.systems.values()].map(system => system.service))

    for (const reader of routing.traceReaders.keys()) expect(owners.has(reader)).toBe(false)
  })

  it('reads no traces when the file lists no readers', () => {
    const routing = loadRouting(edited((doc) => {
      delete doc.traceReaders
    }), allKeys)

    expect(routing.traceReaders.size).toBe(0)
  })

  it('refuses a service that owns a system and reads traces', () => {
    const issues = issuesOf(edited((doc) => {
      doc.traceReaders['django-systems'] = { name: 'Django', systems: ['lb-01'] }
    }))

    expect(issues).toEqual(['traceReaders.django-systems: owns lb-01, lb-02, so it makes model calls and may not read traces'])
  })

  it('refuses a reader that names a system that does not exist, or names one twice', () => {
    const issues = issuesOf(edited((doc) => {
      doc.traceReaders.web.systems = ['lb-01', 'lb-01', 'lb-77']
    }))

    expect(issues).toEqual(['traceReaders.web: unknown system lb-77', 'traceReaders.web: a system is listed twice'])
  })

  it('refuses a reader without systems, and a field nobody planned for', () => {
    expect(issuesOf(edited((doc) => {
      doc.traceReaders.web.systems = []
    }))).toEqual(['traceReaders.web.systems: Too small: expected array to have >=1 items'])
    expect(issuesOf(edited((doc) => {
      doc.traceReaders.web.canCallModels = true
    }))).toEqual([expect.stringContaining('traceReaders.web')])
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
