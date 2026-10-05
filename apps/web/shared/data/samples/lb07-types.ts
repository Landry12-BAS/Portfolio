// The shape of LB-07's curated samples, which `scripts/samples-lb07.ts` writes into `lb07.ts`. It is a
// file of its own so the generated file holds data and nothing else.
import type { Lb07BugId, Lb07Verdict } from '@lb/contracts'

/** One curated test run as the demo holds it: the golden case's ID, the goal the agent is given, the bugs it switches on, and the verdict a correct run comes to. */
export interface QaSample {
  id: string
  goal: string
  bugs: readonly Lb07BugId[]
  verdict: Lb07Verdict
}
