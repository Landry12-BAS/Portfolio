import { parse } from 'yaml'

import { routingSchema } from './schema.ts'
import type { Capability, Limits, ProviderConfig, RoutingFile, SystemConfig, Timeouts } from './schema.ts'

export interface Provider {
  key: string
  name: string
  // Undefined when the URL needs an environment variable that isn't set.
  baseUrl: string | undefined
  apiKey: string | undefined
  configured: boolean
  trainsOnInputs: boolean
  terms: ProviderConfig['terms']
  maxTokensParam: ProviderConfig['maxTokensParam']
  streamUsage: boolean
  limits: Limits | undefined
  headers: Readonly<Record<string, string>>
}

export interface Model {
  // provider/model, as written in alias chains.
  ref: string
  provider: Provider
  // The provider's own model ID.
  id: string
  context: number
  capabilities: ReadonlySet<Capability>
  limits: Limits | undefined
  neurons: { input: number, output: number } | undefined
}

export interface Alias {
  name: string
  description: string
  kind: 'chat' | 'embedding'
  maxInputTokens: number
  maxOutputTokens: number
  timeouts: Timeouts
  chain: readonly Model[]
}

export interface System extends SystemConfig {
  key: string
}

export interface Routing {
  budgets: RoutingFile['budgets']
  providers: ReadonlyMap<string, Provider>
  models: ReadonlyMap<string, Model>
  aliases: ReadonlyMap<string, Alias>
  systems: ReadonlyMap<string, System>
}

export class RoutingError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`routing.yaml is invalid:\n- ${issues.join('\n- ')}`)
    this.name = 'RoutingError'
    this.issues = issues
  }
}

type Env = Readonly<Record<string, string | undefined>>

const placeholder = /\$\{([A-Z][A-Z0-9_]*)\}/g

// Provider traffic carries API keys, so it must use TLS. Plain HTTP is accepted only for
// loopback addresses, where the tests run their fake providers.
function isAllowedUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
}

function resolveBaseUrl(key: string, template: string, env: Env, issues: string[]): string | undefined {
  let missing = false
  // Values come from deploy configuration, as trusted as this file, so they are
  // inserted as written: an account ID in a path, or a whole URL in the tests.
  const value = template.replace(placeholder, (_, name: string) => {
    const found = env[name]?.trim()
    if (!found) missing = true
    return found ?? ''
  })
  if (missing) return undefined
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    issues.push(`providers.${key}.baseUrl is not a URL`)
    return undefined
  }
  if (!isAllowedUrl(url)) {
    issues.push(`providers.${key}.baseUrl must use https`)
    return undefined
  }
  return value.replace(/\/+$/, '')
}

function hasNeuronLimit(limits: Limits | undefined): boolean {
  return Boolean(limits?.minute?.neurons ?? limits?.day?.neurons)
}

function minuteTokens(limits: Limits | undefined): number | undefined {
  return limits?.minute?.tokens
}

/**
 * Parses and checks routing.yaml. Schema errors and broken cross-references are all
 * collected and thrown together, so one run of the check lists every problem.
 */
export function loadRouting(text: string, env: Env): Routing {
  const parsed = routingSchema.safeParse(parse(text))
  if (!parsed.success) {
    throw new RoutingError(parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`))
  }
  const file = parsed.data
  const issues: string[] = []

  const providers = new Map<string, Provider>()
  const models = new Map<string, Model>()
  for (const [key, config] of Object.entries(file.providers)) {
    const baseUrl = resolveBaseUrl(key, config.baseUrl, env, issues)
    const apiKey = env[config.keyEnv]?.trim() || undefined
    const provider: Provider = {
      key,
      name: config.name,
      baseUrl,
      apiKey,
      configured: Boolean(baseUrl && apiKey),
      trainsOnInputs: config.trainsOnInputs,
      terms: config.terms,
      maxTokensParam: config.maxTokensParam,
      streamUsage: config.streamUsage,
      limits: config.limits,
      headers: config.headers ?? {},
    }
    providers.set(key, provider)

    for (const [modelKey, modelConfig] of Object.entries(config.models)) {
      const ref = `${key}/${modelKey}`
      const meteredInNeurons = hasNeuronLimit(config.limits) || hasNeuronLimit(modelConfig.limits)
      if (meteredInNeurons && !modelConfig.neurons) {
        issues.push(`${ref} is metered in Neurons but has no neurons rates`)
      }
      models.set(ref, {
        ref,
        provider,
        id: modelConfig.id,
        context: modelConfig.context,
        capabilities: new Set(modelConfig.capabilities),
        limits: modelConfig.limits,
        neurons: modelConfig.neurons,
      })
    }
  }

  const aliases = new Map<string, Alias>()
  for (const [name, config] of Object.entries(file.aliases)) {
    const chain: Model[] = []
    for (const ref of config.chain) {
      const model = models.get(ref)
      if (!model) {
        issues.push(`aliases.${name}: unknown model ${ref}`)
        continue
      }
      if (chain.includes(model)) issues.push(`aliases.${name}: ${ref} is listed twice`)
      if (!model.capabilities.has(config.kind)) issues.push(`aliases.${name}: ${ref} can't serve ${config.kind}`)
      chain.push(model)
    }

    if (config.kind === 'chat' && config.maxOutputTokens === undefined) {
      issues.push(`aliases.${name}: chat aliases need maxOutputTokens`)
    }
    if (config.kind === 'embedding' && config.chain.length !== 1) {
      issues.push(`aliases.${name}: embedding aliases are pinned to one model, since vectors from different models don't mix`)
    }

    const maxOutputTokens = config.maxOutputTokens ?? 0
    const largestCall = config.maxInputTokens + maxOutputTokens
    for (const model of chain) {
      if (model.context < largestCall) {
        issues.push(`aliases.${name}: ${model.ref} holds ${model.context} tokens, less than the alias maximum of ${largestCall}`)
      }
      for (const tokens of [minuteTokens(model.limits), minuteTokens(model.provider.limits)]) {
        if (tokens !== undefined && tokens * file.budgets.minuteCeiling < largestCall) {
          issues.push(`aliases.${name}: ${model.ref} allows ${Math.floor(tokens * file.budgets.minuteCeiling)} tokens a minute, less than the alias maximum of ${largestCall}`)
        }
      }
    }

    // Visitor content may only reach production providers that don't train on inputs.
    // Every alias needs at least one, so no route can fail for visitors by design.
    if (chain.length > 0 && !chain.some(model => !model.provider.trainsOnInputs && model.provider.terms === 'production')) {
      issues.push(`aliases.${name}: no model can take visitor content in production`)
    }

    aliases.set(name, {
      name,
      description: config.description,
      kind: config.kind,
      maxInputTokens: config.maxInputTokens,
      maxOutputTokens,
      timeouts: { ...file.timeouts, ...config.timeouts },
      chain,
    })
  }

  const systems = new Map<string, System>()
  for (const [key, config] of Object.entries(file.systems)) {
    for (const aliasName of config.aliases) {
      if (!aliases.has(aliasName)) issues.push(`systems.${key}: unknown alias ${aliasName}`)
    }
    if (config.sessionDailyCalls > config.dailyCalls) {
      issues.push(`systems.${key}: sessionDailyCalls is above dailyCalls`)
    }
    systems.set(key, { ...config, key })
  }

  if (issues.length > 0) throw new RoutingError(issues)
  return { budgets: file.budgets, providers, models, aliases, systems }
}
