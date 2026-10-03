// The shape of a curated sample of LB-04 Contract Radar: one of the six synthetic contracts the
// demo opens on, with what a correct review of it finds. It comes from the golden set's cases
// (evals/lb04/golden.yaml) and the list of sample files (data/seed/lb04/samples.yaml), so the demo
// shows what the evals check. The contract itself is not copied here: the back end holds the file,
// and reviewing a sample asks the back end for its own copy by the sample's ID.
import type { Lb04FailureCode } from '@lb/contracts'

/** A sample the system reads: how many risky clauses and missing clauses a correct review finds, and whether the contract talks to its reviewer. */
export interface ReportSample {
  // The sample's ID in the sample list: what the API takes to review it, and the name of its recording.
  id: string
  // The title the sample list gives it.
  title: string
  // How many pages the file has, which may be over the system's limit.
  pages: number
  outcome: 'report'
  // How many problems are planted in it, and how many clauses the playbook requires that it lacks.
  planted: number
  absent: number
  // Whether it carries instructions aimed at an AI reviewer.
  screen: 'clean' | 'flagged'
}

/** A sample the system must refuse, and why. */
export interface RefusedSample {
  id: string
  title: string
  pages: number
  outcome: 'refused'
  refusal: Lb04FailureCode
}

/** One curated contract for LB-04's demo. */
export type ContractSample = ReportSample | RefusedSample
