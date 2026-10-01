// The repository's LB-08 data, loaded once for the tests that need it.
import { evalsDirectory, seedDirectory } from '../../src/core/data-files.ts'
import { readSamples } from '../../src/modules/lb08/data/samples.ts'
import type { Sample } from '../../src/modules/lb08/data/samples.ts'
import { readStockFile } from '../../src/modules/lb08/data/stock.ts'
import type { StockProduct } from '../../src/modules/lb08/data/stock.ts'
import { readGoldenSet } from '../../src/modules/lb08/golden/cases.ts'
import type { GoldenCase } from '../../src/modules/lb08/golden/cases.ts'

/** The curated samples in data/seed/lb08. */
export function loadSamples(): Sample[] {
  return readSamples(seedDirectory())
}

/** The stock list in data/seed/lb08. */
export function loadStock(): StockProduct[] {
  return readStockFile(seedDirectory())
}

/** The golden set in evals/lb08, with its samples resolved. */
export function loadGolden(): GoldenCase[] {
  return readGoldenSet(`${evalsDirectory()}/lb08/golden.yaml`, loadSamples())
}
