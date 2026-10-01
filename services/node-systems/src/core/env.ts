// The environment variables the Node systems read, checked once at startup so a
// misconfigured deploy fails fast with one message naming every problem, instead of
// misbehaving later. Messages name variables, never their values, so a secret can't reach
// a log this way.
import { z } from 'zod'

// An Ed25519 public key: 32 bytes, base64url without padding (a JWK's `x`).
const publicKey = z.string().regex(/^[\w-]{43}$/, 'a base64url Ed25519 public key')
const postgresUrl = z.string().regex(/^postgres(?:ql)?:\/\/.+/, 'a postgres:// URL')
const serviceName = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'a lowercase service name')

/** The schema for every variable the Node systems read, with safe defaults where one exists. */
export const envSchema = z.object({
  LB_NODE_HOST: z.string().min(1).default('0.0.0.0'),
  LB_NODE_PORT: z.coerce.number().int().min(1).max(65535).default(8002),
  LB_NODE_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // One Postgres, one schema per system. A system's own URL logs in as a role granted
  // only that schema; without one, the system uses the shared URL.
  LB_DATABASE_URL: postgresUrl,
  LB08_DATABASE_URL: postgresUrl.optional(),
  LB_REDIS_URL: z.string().regex(/^rediss?:\/\/.+/, 'a redis:// or rediss:// URL'),
  // Every key this service writes starts with this, the gateway's own rule.
  LB_REDIS_PREFIX: z.string().regex(/^[a-z0-9-]{1,24}:$/, 'lowercase letters, digits and hyphens, ending in a colon').default('lb:'),
  // The site's Ed25519 public key, which visitor tokens must be signed with. Without it,
  // the API refuses every visitor.
  LB_WEB_TOKEN_KEY: publicKey.optional(),
  // The AI gateway, for the systems that call a model (see @lb/common's Gateway).
  LB_GATEWAY_URL: z.string().min(1).optional(),
  LB_SERVICE_NAME: serviceName.default('node-systems'),
  LB_SERVICE_KEY_FILE: z.string().min(1).optional(),
  // Where the synthetic seed data lives; without it, the repository's data/seed.
  LB_SEED_DIR: z.string().min(1).optional(),
})

/** The Node systems' settings after validation, with defaults filled in. */
export type Env = z.infer<typeof envSchema>

/** Which process is reading the settings: the API needs the gateway, the worker and the tools don't. */
export type Role = 'api' | 'worker' | 'tool'

/**
 * Validates the process environment and returns the settings. Throws one error listing
 * every problem, so a broken deploy can be fixed in a single pass.
 */
export function loadEnv(source: Readonly<Record<string, string | undefined>>, role: Role): Env {
  const parsed = envSchema.safeParse(source)
  const problems = parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
  if (parsed.success && role === 'api') {
    // The API makes model calls, so it can't start without a way to reach the gateway.
    for (const name of ['LB_GATEWAY_URL', 'LB_SERVICE_KEY_FILE'] as const) {
      if (!parsed.data[name]) problems.push(`${name}: required to start the API`)
    }
  }
  if (!parsed.success || problems.length > 0) throw new Error(`Invalid Node systems environment:\n- ${problems.join('\n- ')}`)
  return parsed.data
}
