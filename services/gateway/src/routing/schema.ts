// The shape of routing.yaml, as a Zod schema. Unknown keys are errors (strict objects),
// so a typo in a limit can't silently switch that limit off.
import { z } from 'zod'

// Provider and model keys such as `workers-ai` or `qwen3.8-27b`.
const slug = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,39}$/, 'lowercase letters, digits, dots and hyphens')
// Names of environment variables that hold keys, such as `GROQ_API_KEY`.
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'an environment variable name')
const positive = z.number().positive()
const milliseconds = z.int().min(100).max(600_000)

/** Everything a model can be asked to do; an alias only routes to models that can do it. */
export const capabilities = ['chat', 'tools', 'json_schema', 'reasoning', 'vision', 'embedding'] as const
/** One model capability, such as `tools` or `vision`. */
export type Capability = (typeof capabilities)[number]

/** The units budgets are counted in; Neurons are Workers AI's billing unit. */
export const units = ['requests', 'tokens', 'neurons'] as const
/** One budget unit: requests, tokens or Neurons. */
export type Unit = (typeof units)[number]

// The limits for one window, in any of the units.
const windowLimits = z.strictObject({
  requests: positive.optional(),
  tokens: positive.optional(),
  neurons: positive.optional(),
})

// A provider's or model's limits, per minute and per day.
const limits = z.strictObject({
  minute: windowLimits.optional(),
  day: windowLimits.optional(),
})

// One model at a provider.
const model = z.strictObject({
  id: z.string().min(1).max(200),
  context: z.int().min(512),
  capabilities: z.array(z.enum(capabilities)).min(1),
  limits: limits.optional(),
  // Workers AI bills in Neurons: how many each 1,000 input and output tokens cost.
  neurons: z.strictObject({ input: z.number().min(0), output: z.number().min(0) }).optional(),
})

// One provider: where it lives, how to call it, its terms and its models.
const provider = z.strictObject({
  name: z.string().min(1),
  // May reference environment variables as ${NAME}, for account IDs in the path.
  baseUrl: z.string().min(1),
  keyEnv: envName,
  trainsOnInputs: z.boolean(),
  terms: z.enum(['production', 'dev-only']),
  maxTokensParam: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),
  // Whether streams may ask for a final usage chunk (stream_options.include_usage).
  streamUsage: z.boolean().default(true),
  limits: limits.optional(),
  // Extra request headers, such as OpenRouter's X-Title; they can never replace the key.
  headers: z.record(z.string().regex(/^[a-z0-9-]{1,64}$/i), z.string().max(200)).optional(),
  models: z.record(slug, model),
})

// How long a call may take at each stage.
const timeouts = z.strictObject({
  firstTokenMs: milliseconds,
  responseMs: milliseconds,
  idleMs: milliseconds,
  deadlineMs: milliseconds,
})

// A virtual model such as `lb-tools`.
const alias = z.strictObject({
  description: z.string().min(1),
  kind: z.enum(['chat', 'embedding']),
  maxInputTokens: z.int().min(1),
  maxOutputTokens: z.int().min(1).optional(),
  timeouts: timeouts.partial().optional(),
  chain: z.array(z.string().regex(/^[a-z0-9-]+\/[a-z0-9.-]+$/, 'provider/model')).min(1),
})

// A system allowed to spend model calls, with its quotas.
const system = z.strictObject({
  name: z.string().min(1),
  service: slug,
  aliases: z.array(z.string()).min(1),
  maxCallsPerRun: z.int().min(1),
  sessionDailyCalls: z.int().min(1),
  dailyCalls: z.int().min(1),
})

/** The whole routing.yaml file. */
export const routingSchema = z.strictObject({
  version: z.literal(1),
  budgets: z.strictObject({
    minuteCeiling: z.number().gt(0).max(1),
    dayCeiling: z.number().gt(0).max(1),
    alertAt: z.number().gt(0).max(1),
  }),
  timeouts,
  providers: z.record(slug, provider),
  aliases: z.record(z.string().regex(/^lb-[a-z0-9-]+$/, 'lb-<name>'), alias),
  systems: z.record(z.string().regex(/^lb-\d{2}$/, 'lb-NN'), system),
})

/** routing.yaml after validation, before cross-references are resolved. */
export type RoutingFile = z.infer<typeof routingSchema>
/** One provider entry in routing.yaml. */
export type ProviderConfig = RoutingFile['providers'][string]
/** One system entry in routing.yaml. */
export type SystemConfig = RoutingFile['systems'][string]
/** The four timeouts of an alias, after defaults are applied. */
export type Timeouts = z.infer<typeof timeouts>
/** Per-minute and per-day limits of a provider or model. */
export type Limits = z.infer<typeof limits>
