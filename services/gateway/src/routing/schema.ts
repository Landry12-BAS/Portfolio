import { z } from 'zod'

// The shape of routing.yaml. Unknown keys are errors, so a typo in a limit can't
// silently switch that limit off.

const slug = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,39}$/, 'lowercase letters, digits, dots and hyphens')
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'an environment variable name')
const positive = z.number().positive()
const milliseconds = z.int().min(100).max(600_000)

export const capabilities = ['chat', 'tools', 'json_schema', 'reasoning', 'vision', 'embedding'] as const
export type Capability = (typeof capabilities)[number]

export const units = ['requests', 'tokens', 'neurons'] as const
export type Unit = (typeof units)[number]

const windowLimits = z.strictObject({
  requests: positive.optional(),
  tokens: positive.optional(),
  neurons: positive.optional(),
})

const limits = z.strictObject({
  minute: windowLimits.optional(),
  day: windowLimits.optional(),
})

const model = z.strictObject({
  id: z.string().min(1).max(200),
  context: z.int().min(512),
  capabilities: z.array(z.enum(capabilities)).min(1),
  limits: limits.optional(),
  // Workers AI bills in Neurons: how many each 1,000 input and output tokens cost.
  neurons: z.strictObject({ input: z.number().min(0), output: z.number().min(0) }).optional(),
})

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
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(200)).optional(),
  models: z.record(slug, model),
})

const timeouts = z.strictObject({
  firstTokenMs: milliseconds,
  responseMs: milliseconds,
  idleMs: milliseconds,
  deadlineMs: milliseconds,
})

const alias = z.strictObject({
  description: z.string().min(1),
  kind: z.enum(['chat', 'embedding']),
  maxInputTokens: z.int().min(1),
  maxOutputTokens: z.int().min(1).optional(),
  timeouts: timeouts.partial().optional(),
  chain: z.array(z.string().regex(/^[a-z0-9-]+\/[a-z0-9.-]+$/, 'provider/model')).min(1),
})

const system = z.strictObject({
  name: z.string().min(1),
  service: slug,
  aliases: z.array(z.string()).min(1),
  maxCallsPerRun: z.int().min(1),
  sessionDailyCalls: z.int().min(1),
  dailyCalls: z.int().min(1),
})

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

export type RoutingFile = z.infer<typeof routingSchema>
export type ProviderConfig = RoutingFile['providers'][string]
export type ModelConfig = ProviderConfig['models'][string]
export type AliasConfig = RoutingFile['aliases'][string]
export type SystemConfig = RoutingFile['systems'][string]
export type Timeouts = z.infer<typeof timeouts>
export type Limits = z.infer<typeof limits>
