// The data the mock back end's LB-07 draws on, read by the real service's own readers from the files it
// is seeded and graded from: the bug catalogue (data/seed/lb07/bugs.yaml) and the golden set
// (evals/lb07/golden.yaml), whose cases marked `sample: true` are the curated samples and whose
// reference plans are what the mock's planner writes. Nothing about a bug or a sample is written out a
// second time, so the mock offers exactly what the service offers and grades against.
import { evalsDirectory, seedDirectory } from '../../../../services/node-systems/src/core/data-files.ts'
import { readBugCatalogue } from '../../../../services/node-systems/src/modules/lb07/data/bugs.ts'
import type { BugCatalogue } from '../../../../services/node-systems/src/modules/lb07/data/bugs.ts'
import { readGoldenSet, sampleCases } from '../../../../services/node-systems/src/modules/lb07/golden/cases.ts'
import type { GoldenCase } from '../../../../services/node-systems/src/modules/lb07/golden/cases.ts'

/** What the mock's LB-07 is built from. */
export interface Lb07Seed {
  catalogue: BugCatalogue
  // Every golden case, in the file's order: a visitor's own goal that is word for word a case's goal is planned as that case is.
  golden: GoldenCase[]
  // The cases the board offers as samples, in the file's order.
  samples: GoldenCase[]
}

/** Reads the bug catalogue and the golden set with the service's strict readers. */
export function readLb07Seed(): Lb07Seed {
  const catalogue = readBugCatalogue(seedDirectory())
  const golden = readGoldenSet(`${evalsDirectory()}/lb07/golden.yaml`, catalogue)
  return { catalogue, golden, samples: sampleCases(golden) }
}
