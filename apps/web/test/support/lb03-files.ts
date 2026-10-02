// The files the LB-03 tests upload: the seed's own documents, read from the repository, so a test sends
// what a visitor would (a real PDF, a real photograph) and the mock back end recognises each by its hash.
import { readLb03Seed } from '@lb/api-clients/testing'

import type { UploadFile } from './browser.ts'

const seed = readLb03Seed()

/** Finds a document of the seed by its id in the golden set, or by the name of the sample it is. */
function caseOf(name: string): ReturnType<typeof readLb03Seed>['cases'][number] {
  const found = seed.cases.find(candidate => candidate.id === name || candidate.sample === name)
  if (found === undefined) throw new Error(`The seed has no document or sample called ${name}.`)
  return found
}

/** A seed document as a form in a browser sends it: under its own file name, with the type its extension gives. */
export function seedUpload(name: string): UploadFile {
  const found = caseOf(name)
  return { filename: found.file.split('/').at(-1) ?? found.file, bytes: seed.file(found.file), type: found.mime }
}

/** The JPEG the mock draws for a sample's first page, which a page route of the proxy must hand back unchanged. */
export function samplePicture(sample: string): Uint8Array {
  const picture = seed.picture(sample, 1)
  if (picture === undefined) throw new Error(`The seed has no picture for the sample ${sample}.`)
  return new Uint8Array(picture)
}
