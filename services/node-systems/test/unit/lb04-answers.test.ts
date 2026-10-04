// Tests for the schemas the models' answers are read with (analysis/answers.ts). A model's answer is
// untrusted: it is checked here before the verifier or anything else reads it. The schemas let a model
// add fields it likes, and hold the fields that matter to strict, bounded forms, so an answer far longer
// than any honest one is refused and not held, and text with control characters never reaches storage.
import { describe, expect, it } from 'vitest'

import { analysisAnswerSchema, MAX_NOTES, redlineAnswerSchema, reportAnswerSchema } from '../../src/modules/lb04/analysis/answers.ts'

const note = { rule: 'payment-slow', topic: 'payment', clause: '5.3', quote: 'within ninety (90) days of the date of the invoice' }

describe('the first model\'s answer', () => {
  it('reads notes and missing clauses, and lets a model add fields it likes', () => {
    const parsed = analysisAnswerSchema.safeParse({ notes: [{ ...note, confidence: 0.9 }], missing: ['indemnity-present'], thoughts: 'None of this is read.' })

    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({ notes: [note], missing: ['indemnity-present'] })
  })

  it('does not need the topic or the clause of a note, and treats a clause of null as none', () => {
    const parsed = analysisAnswerSchema.safeParse({ notes: [{ rule: 'payment-slow', clause: null, quote: note.quote }, { rule: 'payment-slow', quote: note.quote }] })

    expect(parsed.data?.notes.map(entry => entry.clause)).toEqual([undefined, undefined])
    expect(parsed.data?.missing).toEqual([])
  })

  it('refuses an answer that is not an object with a list of notes', () => {
    expect(analysisAnswerSchema.safeParse(null).success).toBe(false)
    expect(analysisAnswerSchema.safeParse([note]).success).toBe(false)
    expect(analysisAnswerSchema.safeParse({ missing: [] }).success).toBe(false)
    expect(analysisAnswerSchema.safeParse({ notes: 'none' }).success).toBe(false)
    expect(analysisAnswerSchema.safeParse({ notes: [{ quote: 'no rule named for this note at all' }] }).success).toBe(false)
  })

  it('refuses a quote with a control character or a half of an emoji, and one longer than any honest answer', () => {
    expect(analysisAnswerSchema.safeParse({ notes: [{ ...note, quote: `${note.quote}\u0000` }] }).success).toBe(false)
    expect(analysisAnswerSchema.safeParse({ notes: [{ ...note, quote: `${note.quote}\uD83D` }] }).success).toBe(false)
    expect(analysisAnswerSchema.safeParse({ notes: [{ ...note, quote: 'x'.repeat(4_001) }] }).success).toBe(false)
  })

  it('refuses more notes than any honest review has, and cuts a long but possible list to the first forty and the missing clauses to twelve', () => {
    const many = (count: number) => Array.from({ length: count }, () => note)

    expect(analysisAnswerSchema.safeParse({ notes: many(201) }).success).toBe(false)
    expect(analysisAnswerSchema.safeParse({ notes: many(100) }).data?.notes).toHaveLength(MAX_NOTES)
    expect(analysisAnswerSchema.safeParse({ notes: [], missing: Array.from({ length: 30 }, (_, index) => `rule-${index}`) }).data?.missing).toHaveLength(12)
    expect(analysisAnswerSchema.safeParse({ notes: [], missing: Array.from({ length: 61 }, (_, index) => `rule-${index}`) }).success).toBe(false)
  })
})

describe('the second model\'s answer', () => {
  it('reads a severity and a sentence for each note and each missing clause', () => {
    const parsed = reportAnswerSchema.safeParse({ findings: [{ note: 'n1', severity: 'high', summary: 'Ninety days strains the cash.' }], missing: [{ rule: 'indemnity-present', severity: 'medium', summary: 'No indemnity.' }] })

    expect(parsed.success).toBe(true)
  })

  it('refuses a severity that is not one of the four, and a sentence with a control character', () => {
    expect(reportAnswerSchema.safeParse({ findings: [{ note: 'n1', severity: 'catastrophic', summary: 'x' }] }).success).toBe(false)
    expect(reportAnswerSchema.safeParse({ findings: [{ note: 'n1', severity: 'high', summary: 'x\u0007' }] }).success).toBe(false)
  })

  it('refuses a sentence longer than a summary can be, and more entries than there can be notes', () => {
    expect(reportAnswerSchema.safeParse({ findings: [{ note: 'n1', severity: 'high', summary: 'x'.repeat(601) }] }).success).toBe(false)
    expect(reportAnswerSchema.safeParse({ findings: Array.from({ length: 61 }, (_, index) => ({ note: `n${index}`, severity: 'low', summary: 'x' })) }).success).toBe(false)
  })

  it('does not need the missing clauses of a review with none', () => {
    expect(reportAnswerSchema.safeParse({ findings: [] }).data?.missing).toEqual([])
  })
})

describe('the third model\'s answer', () => {
  it('reads the replacement wording, trimmed', () => {
    expect(redlineAnswerSchema.safeParse({ replacement: '  The Customer shall pay within thirty (30) days.  ' }).data).toEqual({ replacement: 'The Customer shall pay within thirty (30) days.' })
  })

  it('refuses empty wording, wording of white space, wording longer than a redline may be, and wording with a control character', () => {
    expect(redlineAnswerSchema.safeParse({ replacement: '' }).success).toBe(false)
    expect(redlineAnswerSchema.safeParse({ replacement: '   ' }).success).toBe(false)
    expect(redlineAnswerSchema.safeParse({ replacement: 'x'.repeat(1_501) }).success).toBe(false)
    expect(redlineAnswerSchema.safeParse({ replacement: 'pay\u0000now' }).success).toBe(false)
    expect(redlineAnswerSchema.safeParse({}).success).toBe(false)
  })
})
