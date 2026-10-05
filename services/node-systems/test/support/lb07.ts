// What LB-07's tests share: the bug catalogue and the golden set, read once each from the repository's
// files, and a finding made to order for the grader's tests.
import type { Lb07Finding } from '@lb/contracts'

import { evalsDirectory, seedDirectory } from '../../src/core/data-files.ts'
import { readBugCatalogue } from '../../src/modules/lb07/data/bugs.ts'
import type { BugCatalogue } from '../../src/modules/lb07/data/bugs.ts'
import { readGoldenSet } from '../../src/modules/lb07/golden/cases.ts'
import type { GoldenCase } from '../../src/modules/lb07/golden/cases.ts'

let catalogueCache: BugCatalogue | undefined
let goldenCache: GoldenCase[] | undefined

/** The bug catalogue in data/seed/lb07, read once. */
export function loadCatalogue(): BugCatalogue {
  catalogueCache ??= readBugCatalogue(seedDirectory())
  return catalogueCache
}

/** The golden set in evals/lb07, read once and checked against the catalogue. */
export function loadGolden(): GoldenCase[] {
  goldenCache ??= readGoldenSet(`${evalsDirectory()}/lb07/golden.yaml`, loadCatalogue())
  return goldenCache
}

/** A finding with sensible defaults, for tests of the grader and the report. */
export function finding(overrides: Partial<Lb07Finding> & Pick<Lb07Finding, 'kind'>): Lb07Finding {
  return { id: 'f1', engine: 'chromium', stepIndex: 0, title: 'A finding', detail: '', rule: null, path: '/', evidenceIds: [], ...overrides }
}
