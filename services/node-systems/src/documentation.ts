// Generating the Node systems' OpenAPI document without running anything: the app is built
// with every module's routes and nothing behind them, so no database, queue or model is
// needed. `just node-openapi` writes the result to openapi.json, and `pnpm check` (and a
// test) fails when the committed file is stale.
import { fileURLToPath } from 'node:url'

import { buildApp } from './core/app.ts'
import type { RunningModule, SystemModule } from './core/module.ts'
import { openApiDocument } from './core/openapi.ts'
import type { SchemaNames } from './core/openapi.ts'

/** Where the committed document lives: services/node-systems/openapi.json. */
export const OPENAPI_FILE = fileURLToPath(new URL('../openapi.json', import.meta.url))

/** Makes a module that only registers its routes, for documentation. */
function documentationModule(module: SystemModule): RunningModule {
  return {
    part: module.part,
    apiPrefix: module.apiPrefix,
    registerRoutes: scope => module.documentRoutes(scope),
    startWorkers: async () => [],
    isReady: async () => true,
    close: async () => {},
  }
}

/** Collects the schema names every module wants in the document. */
export function schemaNamesOf(modules: readonly SystemModule[]): SchemaNames {
  return Object.assign({}, ...modules.map(module => module.schemaNames)) as SchemaNames
}

/** Renders the OpenAPI document of the given modules, as the committed file stores it. */
export async function renderOpenApi(modules: readonly SystemModule[]): Promise<string> {
  const app = await buildApp({ modules: modules.map(documentationModule), schemaNames: schemaNamesOf(modules) })
  try {
    await app.ready()
    return openApiDocument(app)
  }
  finally {
    await app.close()
  }
}
