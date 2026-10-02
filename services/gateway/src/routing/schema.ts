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
export const capabilities = ['chat', 'tools', 'json_schema', 'reasoning', 'vision', 'embedding', 'rerank', 'guard', 'transcription'] as const
/** One model capability, such as `tools` or `vision`. */
export type Capability = (typeof capabilities)[number]

/**
 * The units budgets are counted in: requests, tokens, Workers AI's Neurons, and seconds of
 * audio, which is how speech-to-text is limited (a recording has no tokens to count).
 */
export const units = ['requests', 'tokens', 'neurons', 'audioSeconds'] as const
/** One budget unit: requests, tokens, Neurons or seconds of audio. */
export type Unit = (typeof units)[number]

// The limits for one window, in any of the units.
const windowLimits = z.strictObject({
  requests: positive.optional(),
  tokens: positive.optional(),
  neurons: positive.optional(),
  audioSeconds: positive.optional(),
})

// A provider's or model's limits, per minute, per hour and per day. Only speech-to-text has
// an hourly limit (Groq's audio seconds per hour), and every window past the minute is a
// count of that unit over the window.
const limits = z.strictObject({
  minute: windowLimits.optional(),
  hour: windowLimits.optional(),
  day: windowLimits.optional(),
})

// One model at a provider.
const model = z.strictObject({
  id: z.string().min(1).max(200),
  // Tokens the model holds. A speech-to-text model has the decoder's window (448 for
  // Whisper), which no check uses: its calls are limited in seconds of audio instead.
  context: z.int().min(256),
  capabilities: z.array(z.enum(capabilities)).min(1),
  // Which of the provider's APIs serves the model: its OpenAI-compatible `baseUrl` (the
  // default) or its own `runUrl`, such as Workers AI's /ai/run. It says how a speech-to-text
  // model is called; the other kinds of call have one fixed API each.
  api: z.enum(['openai', 'run']).default('openai'),
  limits: limits.optional(),
  // Workers AI bills in Neurons: how many each 1,000 input and output tokens cost, or,
  // for a speech-to-text model, each minute of audio.
  neurons: z.strictObject({ input: z.number().min(0), output: z.number().min(0) }).optional(),
  neuronsPerAudioMinute: positive.optional(),
  // Rerankers only: whether scores come as raw logits (the gateway maps them to 0 to 1)
  // or already as probabilities.
  scores: z.enum(['logits', 'probabilities']).optional(),
})

// One provider: where it lives, how to call it, its terms and its models.
const provider = z.strictObject({
  name: z.string().min(1),
  // May reference environment variables as ${NAME}, for account IDs in the path.
  baseUrl: z.string().min(1),
  // The provider's own model endpoint, for tasks its OpenAI-compatible API doesn't
  // cover (Workers AI's /ai/run, for reranking). Model IDs are appended to it.
  runUrl: z.string().min(1).optional(),
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

/** The jobs an alias can do, and so the route that serves it. */
export const aliasKinds = ['chat', 'embedding', 'rerank', 'guard', 'transcription'] as const
/** One alias kind, such as `chat` or `guard`. */
export type AliasKind = (typeof aliasKinds)[number]

// A virtual model such as `lb-tools`.
const alias = z.strictObject({
  description: z.string().min(1),
  kind: z.enum(aliasKinds),
  // Chat and embeddings: the whole prompt. Rerank: one query and one document together.
  // Guard: the whole text, which is checked in segments. Speech-to-text has none: it is
  // limited in seconds (`maxAudioSeconds`).
  maxInputTokens: z.int().min(1).optional(),
  maxOutputTokens: z.int().min(1).optional(),
  // Speech-to-text only: the longest recording one call may carry, measured from the audio
  // itself and never from what the caller says about it.
  maxAudioSeconds: z.number().positive().max(600).optional(),
  // Guards only: the injection probability, from 0 to 1, at which a text is flagged.
  threshold: z.number().gt(0).max(1).optional(),
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

// The name of a system, such as `lb-01`.
const systemKey = z.string().regex(/^lb-\d{2}$/, 'lb-NN')

// A service that reads run traces and does nothing else: the systems whose runs it may read.
const traceReader = z.strictObject({
  name: z.string().min(1),
  systems: z.array(systemKey).min(1),
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
  systems: z.record(systemKey, system),
  // Absent means no service may read traces, which is the safe default.
  traceReaders: z.record(slug, traceReader).default({}),
})

/** routing.yaml after validation, before cross-references are resolved. */
export type RoutingFile = z.infer<typeof routingSchema>
/** One provider entry in routing.yaml. */
export type ProviderConfig = RoutingFile['providers'][string]
/** One system entry in routing.yaml. */
export type SystemConfig = RoutingFile['systems'][string]
/** One trace reader entry in routing.yaml. */
export type TraceReaderConfig = RoutingFile['traceReaders'][string]
/** The four timeouts of an alias, after defaults are applied. */
export type Timeouts = z.infer<typeof timeouts>
/** Per-minute and per-day limits of a provider or model. */
export type Limits = z.infer<typeof limits>
