// The curated samples: the golden set's cases marked `sample: true`, one a fault. A sample is a
// scenario the board offers under "Break the shop"; its seed is fixed, so its incident replays the
// same way every time and the agents' work can be cached. The catalogue is read from the golden set
// strictly, so a sample cannot exist without being graded.
import { LB06_FAULTS, LB06_LIMITS } from '@lb/contracts'
import type { Lb06CatalogueView, Lb06Fault, Lb06SampleView, Lb06Scenario } from '@lb/contracts'

import { evalsDirectory } from '../../../core/data-files.ts'
import { readGoldenSet } from '../golden/cases.ts'
import { FAULT_SERVICE } from '../sim/faults.ts'

/** The samples, with what the catalogue says of each. */
export interface SampleCatalogue {
  samples: Lb06SampleView[]
  // The scenario of a sample, by its id.
  scenarioOf: (id: string) => Lb06Scenario | undefined
}

/** The id a sample carries on the board: the golden case's own id. */
function sampleIdOf(fault: Lb06Fault): string {
  return fault.replace(/_/g, '-')
}

/** Reads the samples from the golden set. */
export function readSampleCatalogue(evalsDir = evalsDirectory()): SampleCatalogue {
  const cases = readGoldenSet(`${evalsDir}/lb06/golden.yaml`).filter(entry => entry.sample)
  const samples: Lb06SampleView[] = cases.map(entry => ({ id: sampleIdOf(entry.fault), fault: entry.fault, seed: entry.seed, goldenCase: entry.id }))
  return {
    samples,
    scenarioOf(id) {
      const sample = samples.find(candidate => candidate.id === id)
      if (!sample) return undefined
      const entry = cases.find(candidate => candidate.id === sample.goldenCase)
      return entry ? { seed: entry.seed, fault: entry.fault, params: entry.params, baselineMinutes: LB06_LIMITS.baselineMinutes } : undefined
    },
  }
}

/** The catalogue as the API shows it. */
export function catalogueView(samples: SampleCatalogue, tickMs: number): Lb06CatalogueView {
  return {
    faults: LB06_FAULTS.map(fault => ({ fault, service: FAULT_SERVICE[fault], sampleId: samples.samples.find(sample => sample.fault === fault)?.id ?? sampleIdOf(fault) })),
    samples: samples.samples,
    baselineMinutes: LB06_LIMITS.baselineMinutes,
    tickMs,
  }
}
