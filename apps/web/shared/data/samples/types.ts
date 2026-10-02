// The shape of a curated sample: one ready-made input a demo opens on, taken from the system's
// golden set so the demo shows what the evals check. A sample with a recording replays it without
// spending quota; one without says so and offers the live run.

/** The languages a sample may be written in. */
export type SampleLanguage = 'en' | 'cs'

/** One curated support ticket for LB-01's demo. */
export interface TicketSample {
  // The case's ID in evals/lb01/golden.yaml, also the name of its recording.
  id: string
  // The synthetic customer who writes it, by key (data/seed/lb01).
  customer: string
  language: SampleLanguage
  // What the customer wrote.
  body: string
  // What the golden set expects the pipeline to do with it, and why when it hands it to a person.
  route: 'awaiting_approval' | 'escalated'
  reason: string | undefined
}
