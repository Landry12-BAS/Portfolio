// The data the mock back end's LB-04 draws on, read by the real service's own readers from the files
// it is seeded and graded from: the playbook, the six synthetic sample contracts with the list that
// says what each file must be, and the golden set that says what a correct review of each finds. So
// the mock's playbook, samples and refusals are the real ones, and nothing about them is written out
// a second time. The golden set is read with the same strict reader the service's eval uses, which
// also checks it against the playbook and the seed contracts.
import { evalsDirectory, seedDirectory } from '../../../../services/node-systems/src/core/data-files.ts'
import { readSampleFile, readSampleList } from '../../../../services/node-systems/src/modules/lb04/data/samples.ts'
import type { SampleContract } from '../../../../services/node-systems/src/modules/lb04/data/samples.ts'
import { readGoldenSet } from '../../../../services/node-systems/src/modules/lb04/golden/cases.ts'
import type { GoldenCase } from '../../../../services/node-systems/src/modules/lb04/golden/cases.ts'
import { readPlaybook } from '../../../../services/node-systems/src/modules/lb04/playbook/playbook.ts'
import type { Playbook } from '../../../../services/node-systems/src/modules/lb04/playbook/playbook.ts'

/** One sample contract the mock offers: what the list says of it, the file's bytes and the golden case that says what a review finds. */
export interface Lb04SampleSeed {
  entry: SampleContract
  bytes: Uint8Array
  golden: GoldenCase
}

/** What the mock's LB-04 is built from. */
export interface Lb04Seed {
  playbook: Playbook
  samples: Lb04SampleSeed[]
}

/** Reads the playbook, the samples and the golden set, and pairs each sample with its case. Throws when a sample has none, as the service's own reader does. */
export function readLb04Seed(): Lb04Seed {
  const seed = seedDirectory()
  const playbook = readPlaybook(seed)
  const list = readSampleList(seed)
  const golden = readGoldenSet(`${evalsDirectory()}/lb04/golden.yaml`, { playbook, contracts: list.map(entry => entry.id) })
  const samples = list.map((entry): Lb04SampleSeed => {
    const found = golden.cases.find(candidate => candidate.contract === entry.id)
    if (!found) throw new Error(`The sample contract ${entry.id} has no golden case.`)
    return { entry, bytes: readSampleFile(seed, entry).bytes, golden: found }
  })
  return { playbook, samples }
}
