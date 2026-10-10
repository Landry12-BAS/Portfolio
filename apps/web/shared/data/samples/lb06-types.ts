// The shape of LB-06's curated samples, which `scripts/samples-lb06.ts` writes into `lb06.ts`. It is
// a file of its own so the generated file holds data and nothing else.
import type { Lb06Fault } from '@lb/contracts'

/** One curated incident as the demo holds it: the ID it carries on the board, the golden case that grades it, the fault it breaks the shop with, and its seed. */
export interface IncidentSample {
  id: string
  goldenCase: string
  fault: Lb06Fault
  seed: number
}
