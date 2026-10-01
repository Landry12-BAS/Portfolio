// The Node systems' drift check (`pnpm check`, part of `just check` and CI): fails when a
// generated file is stale or a data file breaks its schema. It needs no database, no queue
// and no network.
//
//   - The synthetic data files and the golden set are read strictly (a bad field, an
//     invalid workflow or a golden case that can't be met stops here).
//   - The committed OpenAPI document matches what the routes' schemas generate.
//   - LB-08's committed migrations match its schema file.
import { readFileSync } from 'node:fs'

import { evalsDirectory, seedDirectory } from '../core/data-files.ts'
import { OPENAPI_FILE, renderOpenApi } from '../documentation.ts'
import { readSamples } from '../modules/lb08/data/samples.ts'
import { readStockFile } from '../modules/lb08/data/stock.ts'
import { pendingSchemaChanges } from '../modules/lb08/db/drift.ts'
import { readGoldenSet } from '../modules/lb08/golden/cases.ts'
import { MODULES } from '../modules/registry.ts'

/** Reads the data files and the golden set strictly, and says what was found. */
function dataFailures(): string[] {
  try {
    const samples = readSamples(seedDirectory())
    const stock = readStockFile(seedDirectory())
    const golden = readGoldenSet(`${evalsDirectory()}/lb08/golden.yaml`, samples)
    console.log(`LB-08 data is valid: ${samples.length} samples, ${stock.length} products, ${golden.length} golden cases`)
    return []
  }
  catch (error) {
    return [error instanceof Error ? error.message : 'LB-08 data could not be read']
  }
}

/** Compares the committed OpenAPI document with the one the routes generate. */
async function openApiFailures(): Promise<string[]> {
  const committed = readFileSync(OPENAPI_FILE, 'utf8')
  if (committed === await renderOpenApi(MODULES)) {
    console.log('openapi.json is up to date')
    return []
  }
  return ['services/node-systems/openapi.json is stale: run `just node-openapi` and commit the result.']
}

/** Asks drizzle-kit whether the schema file has changes no migration holds. */
async function migrationFailures(): Promise<string[]> {
  const pending = await pendingSchemaChanges()
  if (pending.length === 0) {
    console.log('LB-08 migrations match its schema')
    return []
  }
  return [`LB-08's schema has changes no migration holds: run \`pnpm --filter @lb/node-systems exec drizzle-kit generate\` and commit the migration. It would run:\n${pending.join('\n')}`]
}

const problems = [...dataFailures(), ...await openApiFailures(), ...await migrationFailures()]
if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exitCode = 1
}
