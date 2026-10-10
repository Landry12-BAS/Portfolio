// The synthetic contracts LB-04 offers as samples: the list in data/seed/lb04/samples.yaml and the
// PDFs it names. The list is made by scripts/lb04-contracts.ts together with the files, and says
// what each file must be (its size and a hash of its bytes), so the service serves exactly the
// contracts that were made and refuses a file that was changed or swapped. A sample is picked by
// its id from this list and never by a path, so nothing a visitor sends can name another file.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { z } from 'zod'

import { readDataFile } from '../../../core/data-files.ts'

const sampleId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60)

/** What the list says about one contract. */
const entrySchema = z.strictObject({
  id: sampleId,
  title: z.string().min(3).max(80),
  // The page count is the file's own, and may be over the limit: a sample shows what the system refuses, too.
  pages: z.int().min(1).max(200),
  bytes: z.int().min(1).max(4 * 1_024 * 1_024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})

/** The whole samples.yaml. */
const listSchema = z.strictObject({ contracts: z.array(entrySchema).min(1).max(20) })

/** One sample contract, as the list describes it. */
export type SampleContract = z.infer<typeof entrySchema>

/** A sample contract with its bytes, once checked. */
export interface SampleFile {
  entry: SampleContract
  bytes: Uint8Array
}

/** Reads the list of sample contracts, and refuses a list that names one twice. */
export function readSampleList(seedDirectory: string): SampleContract[] {
  const { contracts } = readDataFile(`${seedDirectory}/lb04/samples.yaml`, listSchema)
  if (new Set(contracts.map(entry => entry.id)).size !== contracts.length) throw new Error(`${seedDirectory}/lb04/samples.yaml names a contract twice.`)
  return contracts
}

/** Reads a sample's PDF and checks it is the file the list describes: its size, and the hash of its bytes. */
export function readSampleFile(seedDirectory: string, entry: SampleContract): SampleFile {
  const bytes = new Uint8Array(readFileSync(`${seedDirectory}/lb04/contracts/${entry.id}.pdf`))
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (bytes.length !== entry.bytes || hash !== entry.sha256) throw new Error(`The sample contract ${entry.id} is not the file the list describes.`)
  return { entry, bytes }
}
