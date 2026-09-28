// Loads routing.yaml into the structures the gateway routes with. Beyond the schema, it
// checks the rules that span entries: every chain names real models, every alias fits
// its models' context and minute budgets, and every alias has a model that may take
// visitor content. Anything wrong stops the gateway (and CI) with a full list.
import { parse } from 'yaml'

import { routingSchema } from './schema.ts'
import type { Capability, Limits, ProviderConfig, RoutingFile, SystemConfig, Timeouts } from './schema.ts'

/** A model provider as the gateway uses it, with its URL and key resolved from the environment. */
export interface Provider {
  key: string
  name: string
  // Undefined when the URL needs an environment variable that isn't set.
  baseUrl: string | undefined
  apiKey: string | undefined
  // True when both the URL and the key are present, so calls can go out.
  configured: boolean
  trainsOnInputs: boolean
  terms: ProviderConfig['terms']
  maxTokensParam: ProviderConfig['maxTokensParam']
  streamUsage: boolean
  limits: Limits | undefined
  headers: Readonly<Record<string, string>>
}

/** One model at one provider, with everything routing and budgeting need to know about it. */
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

/** A virtual model such as `lb-tools`: its limits, timeouts and chain of real models. */
export interface Alias {
  name: string
  description: string
  kind: 'chat' | 'embedding'
  maxInputTokens: number
  maxOutputTokens: number
  timeouts: Timeouts
  chain: readonly Model[]
}

/** A system allowed to spend model calls, keyed by its part number such as `lb-01`. */
export interface System extends SystemConfig {
  key: string
}

/** The whole routing table, ready to route with. */
export interface Routing {
  budgets: RoutingFile['budgets']
  providers: ReadonlyMap<string, Provider>
  models: ReadonlyMap<string, Model>
  aliases: ReadonlyMap<string, Alias>
  systems: ReadonlyMap<string, System>
}

/** Thrown when routing.yaml breaks a rule; `issues` lists every problem found. */
export class RoutingError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`routing.yaml is invalid:\n- ${issues.join('\n- ')}`)
    this.name = 'RoutingError'
    this.issues = issues
  }
}

/** Environment variables, as the loader reads them. */
type Env = Readonly<Record<string, string | undefined>>

// ${NAME} in a base URL, filled in from the environment.
const placeholder = /\$\{([A-Z][A-Z0-9_]*)\}/g

/**
 * Tells whether a provider URL is safe to send an API key to. Provider traffic carries
 * keys, so it must use TLS; plain HTTP is accepted only for loopback addresses, where
 * the tests run their fake providers.
 */
function isAllowedUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
}

/**
 * Fills ${NAME} placeholders in a provider's base URL from the environment and checks
 * the result. Returns undefined when a variable is missing (the provider stays off),
 * and records an issue when the URL is malformed or not HTTPS.
 */
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

/** Tells whether a set of limits counts Neurons in either window. */
function hasNeuronLimit(limits: Limits | undefined): boolean {
  return Boolean(limits?.minute?.neurons ?? limits?.day?.neurons)
}

/** Returns the tokens-per-minute limit in a set of limits, if there is one. */
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

  // Providers and their models, with URLs and keys resolved from the environment.
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

  // Aliases: their chains must name real models that can do the alias's job and fit it.
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

    // The biggest call the alias allows must fit every model's context window and
    // tokens-per-minute budget, or that model could never serve it.
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

  // Systems: every alias they use must exist, and a visitor's share can't exceed the system's.
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
