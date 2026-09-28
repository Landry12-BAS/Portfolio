import { z } from 'zod'

// The gateway's environment. Provider API keys are not listed here: routing.yaml names
// the variable each provider reads (`keyEnv`), and a provider without its key is
// simply left off every chain.

const serviceName = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'a lowercase service name')
// An Ed25519 public key: 32 bytes, base64url without padding (a JWK's `x`).
const publicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'a base64url Ed25519 public key')

const serviceKeys = z.string().transform((raw, context) => {
  try {
    return JSON.parse(raw) as unknown
  }
  catch {
    context.addIssue({ code: 'custom', message: 'must be a JSON object' })
    return z.NEVER
  }
}).pipe(z.record(serviceName, publicKey).refine(keys => Object.keys(keys).length > 0, 'needs at least one service'))

export const envSchema = z.object({
  LB_GATEWAY_HOST: z.string().min(1).default('0.0.0.0'),
  LB_GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  // `production` keeps providers whose terms forbid production use off every chain.
  LB_GATEWAY_PROFILE: z.enum(['production', 'dev']).default('production'),
  LB_GATEWAY_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LB_REDIS_URL: z.string().regex(/^rediss?:\/\/.+/, 'a redis:// or rediss:// URL'),
  // Every key the gateway writes starts with this. Run spans go to <prefix>run:<id>:spans,
  // a stream the systems' own tracers share.
  LB_REDIS_PREFIX: z.string().regex(/^[a-z0-9-]{1,24}:$/, 'lowercase letters, digits and hyphens, ending in a colon').default('lb:'),
  LB_ROUTING_FILE: z.string().min(1).optional(),
  // JSON object: service name to its Ed25519 public key. Services keep the private keys.
  LB_SERVICE_KEYS: serviceKeys,
})

export type Env = z.infer<typeof envSchema>

export function loadEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const problems = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`Invalid gateway environment:\n- ${problems.join('\n- ')}`)
  }
  return parsed.data
}
