// What LB-04's tests share: the playbook, the golden set and the seed contracts loaded once, the
// extraction of each seed PDF done once, and a recorder of spans. The reference models, which answer
// each golden case the way a correct reviewer would, are in lb04-reference.ts.
import { readFileSync } from 'node:fs'

import { createRun, newRunId, runScope } from '@lb/common'
import type { Span, SpanWriter } from '@lb/common'

import { evalsDirectory, seedDirectory } from '../../src/core/data-files.ts'
import { readSampleList } from '../../src/modules/lb04/data/samples.ts'
import { readGoldenSet } from '../../src/modules/lb04/golden/cases.ts'
import type { GoldenSet } from '../../src/modules/lb04/golden/cases.ts'
import { extractPdf } from '../../src/modules/lb04/pdf/extract.ts'
import type { ExtractedPage, ExtractionLimits } from '../../src/modules/lb04/pdf/extract.ts'
import { readPlaybook } from '../../src/modules/lb04/playbook/playbook.ts'
import type { Playbook } from '../../src/modules/lb04/playbook/playbook.ts'

/** Limits for extraction in tests: generous in time, because a test run on a busy machine is slow, and the production limits in memory. */
export const TEST_LIMITS: ExtractionLimits = { timeoutMs: 60_000, maxOldGenerationMb: 192, maxYoungGenerationMb: 32, stackMb: 4 }

let playbookCache: Playbook | undefined
let goldenCache: GoldenSet | undefined
const extractions = new Map<string, Promise<ExtractedPage[]>>()

/** The playbook in data/seed/lb04, read once. */
export function loadPlaybook(): Playbook {
  playbookCache ??= readPlaybook(seedDirectory())
  return playbookCache
}

/** The ids of the seed contracts, from their list. */
export function seedContractIds(): string[] {
  return readSampleList(seedDirectory()).map(entry => entry.id)
}

/** The golden set in evals/lb04, read once, checked against the playbook and the seed contracts. */
export function loadGoldenSet(): GoldenSet {
  goldenCache ??= readGoldenSet(`${evalsDirectory()}/lb04/golden.yaml`, { playbook: loadPlaybook(), contracts: seedContractIds() })
  return goldenCache
}

/** The bytes of a seed contract. */
export function seedBytes(id: string): Uint8Array {
  return new Uint8Array(readFileSync(`${seedDirectory()}/lb04/contracts/${id}.pdf`))
}

/** The pages of a seed contract, extracted by the real worker thread, once per test file. */
export function extractedPages(id: string): Promise<ExtractedPage[]> {
  let pages = extractions.get(id)
  if (!pages) {
    pages = extractPdf(seedBytes(id), TEST_LIMITS)
    extractions.set(id, pages)
  }
  return pages
}

/** Runs work inside a run of its own over synthetic data, which is what every span and every gateway call of a review needs. */
export function inTestRun<Result>(work: () => Promise<Result>): Promise<Result> {
  return runScope(createRun({ system: 'lb-04', runId: newRunId(), dataClass: 'synthetic' }), work)
}

/** Keeps the spans a pipeline writes. */
export class Recorder implements SpanWriter {
  readonly spans: Span[] = []

  /** Stores finished spans. */
  async write(spans: readonly Span[]): Promise<void> {
    this.spans.push(...spans)
  }
}
