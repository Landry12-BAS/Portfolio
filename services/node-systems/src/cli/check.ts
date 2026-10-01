// The Node systems' drift check (`pnpm check`, part of `just check` and CI): fails when a
// generated file is stale or a data file breaks its schema. It needs no database and no
// network.
//
//   - The synthetic data files and the golden set are read strictly (a bad field, an
//     invalid workflow or a golden case that can't be met stops here).
import { evalsDirectory, seedDirectory } from '../core/data-files.ts'
import { readSamples } from '../modules/lb08/data/samples.ts'
import { readStockFile } from '../modules/lb08/data/stock.ts'
import { readGoldenSet } from '../modules/lb08/golden/cases.ts'

/** Runs every check, and returns one line for each that failed. */
function failures(): string[] {
  const problems: string[] = []
  try {
    const samples = readSamples(seedDirectory())
    const stock = readStockFile(seedDirectory())
    const golden = readGoldenSet(`${evalsDirectory()}/lb08/golden.yaml`, samples)
    console.log(`LB-08 data is valid: ${samples.length} samples, ${stock.length} products, ${golden.length} golden cases`)
  }
  catch (error) {
    problems.push(error instanceof Error ? error.message : 'LB-08 data could not be read')
  }
  return problems
}

const problems = failures()
if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exitCode = 1
}
