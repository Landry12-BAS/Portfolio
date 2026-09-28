// Validates routing.yaml for CI (`pnpm check`) and prints what it holds. Every
// environment variable resolves to a stand-in value, so base URLs are checked for shape
// without any real secret in CI.
import { readFileSync } from 'node:fs'

import { loadRouting, RoutingError } from '../routing/load.ts'

const path = process.argv[2] ?? new URL('../../routing.yaml', import.meta.url).pathname
const standIns = new Proxy<Record<string, string>>({}, { get: () => 'check' })

try {
  const routing = loadRouting(readFileSync(path, 'utf8'), standIns)
  console.log(`routing.yaml is valid: ${routing.providers.size} providers, ${routing.models.size} models, ${routing.aliases.size} aliases, ${routing.systems.size} systems`)
}
catch (error) {
  if (!(error instanceof RoutingError)) throw error
  console.error(error.message)
  process.exitCode = 1
}
