// `just node-migrate`: creates or updates each system's Postgres schema, in its own role
// where one is configured, and prints how many migrations each applied. Safe to run again:
// it applies only what is pending, and two runs at once take turns.
import { loadEnv } from '../core/env.ts'
import { MODULES } from '../modules/registry.ts'

const env = loadEnv(process.env, 'tool')
for (const module of MODULES) {
  const applied = await module.migrate(env)
  console.log(`${module.schema}: ${applied} migration${applied === 1 ? '' : 's'} applied`)
}
