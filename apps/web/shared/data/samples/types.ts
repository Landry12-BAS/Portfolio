// The shape of a curated sample: one ready-made input a demo opens on, taken from the system's
// golden set so the demo shows what the evals check. A sample with a recording replays it without
// spending quota; one without says so and offers the live run.
import type { SqlLayer, SqlRule } from '../sql-safety'

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

/** One curated business question for LB-05's demo. */
export interface QuestionSample {
  // The case's ID in evals/lb05/golden.yaml, also the name of its recording.
  id: string
  // The question as the golden set words it, which is what the demo sends.
  question: string
  // What kind of question it is and how hard the golden set rates it.
  topic: string
  difficulty: 'easy' | 'medium' | 'hard'
}

/** One curated attack for LB-05's safety demo, taken from the adversarial set. */
export interface AttackSample {
  // The attempt's ID in evals/lb05/adversarial.yaml, also the name of its recording.
  id: string
  // The kind of attack, such as `destructive` or `file_access`.
  category: string
  // What a visitor might type, which is what the demo sends.
  question: string
  // The layer and rule that stop the query a model that obeyed would write.
  stoppedBy: SqlLayer
  rule: SqlRule
  // False for the few attempts whose being held means something else: a dump is answered, cut to the row cap.
  mustRefuse: boolean
}
