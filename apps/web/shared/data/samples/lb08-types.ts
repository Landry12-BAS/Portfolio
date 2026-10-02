// The shape of a curated sample of LB-08 Automation Studio: a process described in plain language,
// the event that starts its workflow and the test order the demo runs it with. It comes from the
// golden set's samples (evals/lb08/golden.yaml) and the sample file they point to
// (data/seed/lb08/samples.yaml), so the demo shows what the evals check. The workflow itself is not
// copied here: the back end holds it, and opening a sample asks the back end for its own copy.
import type { TriggerEventId, Values } from '@lb/contracts'

/** The languages a sample may be written in. */
export type WorkflowSampleLanguage = 'en' | 'cs'

/** One curated process for LB-08's demo. */
export interface WorkflowSample {
  // The sample's ID in the sample file: what the API takes to open it and the name of its recording.
  id: string
  // The golden-set case that grades the model on this description.
  goldenCase: string
  language: WorkflowSampleLanguage
  // The title the sample file gives it, in the sample's own language.
  title: string
  // What a person would write to describe the process.
  description: string
  // The event that starts the workflow.
  event: TriggerEventId
  // The test order the demo prefills, which fits the event's payload.
  input: Values
}
