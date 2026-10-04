// What the model may answer, as schemas. A model's answer is untrusted: it is checked here before
// the verifier or anything else reads it, and an answer that fails is sent back once with what was
// wrong (never a third time). The schemas are lenient about extra fields (models add them) and
// strict about the fields that matter, and they bound what they read, so an answer that is far
// longer than any honest one is refused rather than held.
import { LB04_SEVERITIES } from '@lb/contracts'
import { z } from 'zod'

import { isSafeText } from '../../../core/text-guard.ts'

/** Text a model writes: bounded, and with nothing in it that doesn't belong in a stored, shown text. */
const safeText = (max: number) => z.string().max(max).refine(isSafeText, 'text with control characters')

// The most notes and missing clauses read from one answer. More than this is cut, not refused.
export const MAX_NOTES = 40
const MAX_MISSING = 12

/** One passage the first model found: the rule it goes against, the topic and clause it names, and the words it quotes. */
const noteSchema = z.object({
  rule: z.string().max(60),
  topic: z.string().max(40).optional(),
  clause: z.string().max(30).nullish().transform(value => value ?? undefined),
  // Longer than the limit on a finding's quote, so a quote that is too long is counted as dropped, and not refused as a whole.
  quote: safeText(4_000),
})

/** The first model's answer: the passages it found, and the required clauses it says are missing. */
export const analysisAnswerSchema = z.object({
  notes: z.array(noteSchema).max(200),
  missing: z.array(z.string().max(60)).max(60).default([]),
}).transform(answer => ({ notes: answer.notes.slice(0, MAX_NOTES), missing: answer.missing.slice(0, MAX_MISSING) }))

/** The first model's answer, once checked. */
export type AnalysisAnswer = z.infer<typeof analysisAnswerSchema>

const severity = z.enum(LB04_SEVERITIES)
// A short plain-language sentence or two. Longer is cut by the report, but one this long is not a summary.
const summary = safeText(600)

/** The second model's answer: a severity and a summary for each verified note, and for each missing clause. */
export const reportAnswerSchema = z.object({
  findings: z.array(z.object({ note: z.string().max(12), severity, summary })).max(60),
  missing: z.array(z.object({ rule: z.string().max(60), severity, summary })).max(30).default([]),
})

/** The second model's answer, once checked. */
export type ReportAnswer = z.infer<typeof reportAnswerSchema>

/** The third model's answer: the replacement wording for one passage, which the API's schema bounds at 1,500 characters. */
export const redlineAnswerSchema = z.object({
  replacement: safeText(1_500).transform(text => text.trim()).pipe(z.string().min(1)),
})

/** The third model's answer, once checked. */
export type RedlineAnswer = z.infer<typeof redlineAnswerSchema>
