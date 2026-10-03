// Tests of what LB-03's board says about the validation checks, the stages of a reading and the steps of
// the pipeline: the sentence for each failed check with the numbers the service worked out (in English and
// in Czech, never a key and never a leftover placeholder), the order and the tally of the checks, which
// stage a document is in and where a failed one stopped, and how the recorded steps line up with the
// datasheet's chain of nine.
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'

import { inCheckOrder, sentenceFor, stopsExport, tally } from '~/boards/lb-03/checks'
import { isServiceFailure } from '~/boards/lb-03/failures'
import type { Translate } from '~/boards/lb-03/fields'
import { STAGES, isFinal, isReady, secondsSince, stageStatus, stoppedAt } from '~/boards/lb-03/progress'
import type { Check, InvoiceDocument } from '~/boards/lb-03/schemas'
import { chainRows, factsOf, queueStep } from '~/boards/lb-03/steps'

import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'
import { makeCorrected, makeDocument } from '../support/lb03'

/** Makes the translation function of a language, as a component gets it. */
function translator(locale: 'en' | 'cs'): Translate {
  return createI18n({ legacy: false, locale, messages: { en, cs } }).global.t as unknown as Translate
}

/** Finds the check with an id in a document. */
function checkOf(document: InvoiceDocument, id: Check['id']): Check {
  const found = document.checks?.find(check => check.id === id)
  if (found === undefined) throw new Error(`The document has no ${id} check.`)
  return found
}

/** Writes a failed check's sentence in a language. */
function said(check: Check, locale: 'en' | 'cs'): string {
  const told = sentenceFor(check)
  return translator(locale)(told.key, { ...told.values, fields: 'A, B' })
}

describe('the sentence for a failed check', () => {
  it('says what disagreed, with the service\'s numbers, for the planted total', () => {
    const check = checkOf(makeDocument({ sample: 'planted-total' }), 'total_reconciles')
    expect(check.status).toBe('failed')
    expect(said(check, 'en')).toBe('The subtotal plus the VAT comes to 1193.85, but the total says 1293.85.')
    expect(said(check, 'cs')).toBe('Mezisoučet plus DPH dá 1193.85, ale celkem říká 1293.85.')
  })

  it('names the line a line whose arithmetic does not hold, and says the lines no longer add up', () => {
    const document = makeCorrected('clean-pdf', [['line_items.1.total', '1500.00']])
    const math = checkOf(document, 'line_math')
    expect(said(math, 'en')).toBe('Line 2: quantity times unit price comes to 1200.00, but the line total says 1500.00.')
    expect(said(checkOf(document, 'line_items_sum'), 'en')).toBe('The line totals add up to 8900.00, but the subtotal says 8600.00.')
  })

  it('names the VAT line that does not hold, and says which total the VAT bases were compared with', () => {
    const document = makeCorrected('clean-pdf', [['vat.0.amount', '1900.00']])
    expect(said(checkOf(document, 'vat_math'), 'en')).toBe('VAT line 1: the rate applied to its base comes to 1806.00, but the VAT says 1900.00.')
    expect(said(checkOf(document, 'vat_math'), 'cs')).toBe('Řádek DPH 1: sazba použitá na základ dá 1806.00, ale DPH říká 1900.00.')
  })

  it('tells a date in the future, a due date before the issue date and a currency nobody trades in, in words of its own', () => {
    const future = checkOf(makeCorrected('clean-pdf', [['issue_date', '2027-01-01']]), 'dates_valid')
    expect(said(future, 'en')).toBe('The issue date 2027-01-01 is later than 2026-10-01, the day it was checked on.')
    const due = checkOf(makeCorrected('clean-pdf', [['due_date', '2026-01-01']]), 'dates_valid')
    expect(said(due, 'en')).toBe('The due date 2026-01-01 is before the issue date.')
    const currency = checkOf(makeCorrected('clean-pdf', [['currency', 'XYZ']]), 'currency_known')
    expect(said(currency, 'en')).toBe('The currency XYZ is not one Basalt & Bean trades in (CZK, EUR, USD, GBP, PLN, CHF, HUF).')
  })

  it('lists what is missing in the visitor\'s words, and says the count of values not found on the page without a plural to get wrong', () => {
    const missing = checkOf(makeCorrected('clean-pdf', [['vendor', '']]), 'required_fields')
    expect(said(missing, 'en')).toBe('Missing from the document: A, B.')
    const stray = checkOf(makeDocument({ sample: 'handwritten-receipt' }), 'fields_on_page')
    expect(stray.status).toBe('failed')
    expect(said(stray, 'en')).toBe(`Values not found among the words read from the page: ${stray.fields.length}. A misreading, a value that is not there, or one the model made up. Worth a look; it does not stop the export.`)
    expect(said(stray, 'cs')).toContain('Hodnoty, které se nenašly mezi slovy přečtenými ze stránky')
  })

  it('has a sentence in both languages that leaves no placeholder behind, for every check there is', () => {
    const base: Omit<Check, 'id' | 'fields'> = { status: 'failed', severity: 'error', message: '', expected: '1.00', actual: '2.00' }
    const dated = { ...base, expected: 'on or before 2026-10-01', actual: '2027-01-01' }
    const ids: Check['id'][] = ['required_fields', 'dates_valid', 'currency_known', 'signs_agree', 'line_math', 'line_items_sum', 'vat_math', 'vat_bases', 'total_reconciles', 'fields_on_page', 'not_duplicate']
    for (const id of ids) {
      for (const fields of [['total'], ['subtotal', 'line_items.0.total'], ['vat.0.amount'], ['due_date']]) {
        for (const locale of ['en', 'cs'] as const) {
          const text = said({ ...(id === 'dates_valid' ? dated : base), id, fields }, locale)
          expect(text, `${id} in ${locale}`).not.toMatch(/[{}]|lb03\./)
          expect(text.length).toBeGreaterThan(10)
        }
      }
    }
  })

  it('reads the two ways the service says a date is wrong, and falls back to a plain sentence for any other', () => {
    const date = { id: 'dates_valid' as const, status: 'failed' as const, severity: 'error' as const, message: '', fields: ['issue_date'], actual: '1999-05-01' }
    expect(sentenceFor({ ...date, expected: '2000-01-01 or later' })).toEqual({ key: 'lb03.checks.failed.dates_valid.early', values: { actual: '1999-05-01', limit: '2000-01-01' } })
    expect(sentenceFor({ ...date, expected: 'on or before 2026-10-01' }).key).toBe('lb03.checks.failed.dates_valid.future')
    expect(sentenceFor({ ...date, expected: 'something else' }).key).toBe('lb03.checks.failed.dates_valid.other')
    expect(sentenceFor({ ...date, expected: null, actual: null }).key).toBe('lb03.checks.failed.dates_valid.other')
  })

  it('picks the sentence about the total when the prices include VAT, as the handwritten receipt\'s do', () => {
    const check = { id: 'line_items_sum' as const, status: 'failed' as const, severity: 'error' as const, message: '', fields: ['total', 'line_items.0.total'], expected: '116.00', actual: '130.00' }
    expect(sentenceFor(check).key).toBe('lb03.checks.failed.line_items_sum.total')
    expect(sentenceFor({ ...check, fields: ['subtotal'] }).key).toBe('lb03.checks.failed.line_items_sum.subtotal')
  })
})

describe('the list of checks', () => {
  it('puts the checks in the order the service runs them, whatever order they arrive in', () => {
    const document = makeDocument({ sample: 'clean-pdf' })
    const ordered = inCheckOrder([...(document.checks ?? [])].reverse())
    expect(ordered.map(check => check.id)).toEqual(['required_fields', 'dates_valid', 'currency_known', 'signs_agree', 'line_math', 'line_items_sum', 'vat_math', 'vat_bases', 'total_reconciles', 'fields_on_page', 'not_duplicate'])
  })

  it('counts what became of the checks: passed, failed and stops the export, a warning, not run', () => {
    expect(tally(makeDocument({ sample: 'clean-pdf' }).checks ?? [])).toEqual({ passed: 11, errors: 0, warnings: 0, skipped: 0 })
    const planted = makeDocument({ sample: 'planted-total' })
    expect(tally(planted.checks ?? []).errors).toBe(1)
    expect(planted.checks?.filter(stopsExport).map(check => check.id)).toEqual(['total_reconciles'])
  })

  it('counts a value not found on the page as a warning, which does not stop the export', () => {
    const handwritten = makeDocument({ sample: 'handwritten-receipt' })
    const count = tally(handwritten.checks ?? [])
    expect(count.warnings).toBe(1)
    expect(count.errors).toBe(0)
    expect(handwritten.can_export).toBe(true)
  })
})

describe('the stages of a reading', () => {
  it('mark the stages before the one a document is in done, that one current, and the rest waiting', () => {
    const document = makeDocument({ sample: 'clean-pdf', until: 'extract' })
    expect(document.state).toBe('extract')
    expect(STAGES.map(stage => stageStatus(document, stage))).toEqual(['done', 'done', 'current', 'waiting', 'waiting', 'waiting'])
  })

  it('say a document that is read and needed no repair skipped the repair', () => {
    const document = makeDocument({ sample: 'clean-pdf' })
    expect(STAGES.map(stage => stageStatus(document, stage))).toEqual(['done', 'done', 'done', 'done', 'skipped', 'done'])
  })

  it('say a document that was repaired went through the repair', () => {
    const document = makeDocument({ sample: 'planted-total' })
    expect(document.steps.some(step => step.name === 'repair')).toBe(true)
    expect(STAGES.map(stage => stageStatus(document, stage))).toEqual(['done', 'done', 'done', 'done', 'done', 'done'])
  })

  it('say where a document that failed stopped: the stage of the step that failed', () => {
    const hostile = makeDocument({ sample: 'prompt-injection' })
    expect(hostile.state).toBe('failed')
    expect(stoppedAt(hostile.steps)).toBe('extract')
    expect(STAGES.map(stage => stageStatus(hostile, stage))).toEqual(['done', 'done', 'failed', 'waiting', 'waiting', 'waiting'])
    expect(stoppedAt([{ name: 'ocr', status: 'error', ms: 0, detail: {} }])).toBe('ocr')
    expect(stoppedAt([{ name: 'repair', status: 'error', ms: 0, detail: {} }])).toBe('repair')
    expect(stoppedAt([{ name: 'validate', status: 'error', ms: 0, detail: {} }])).toBe('validate')
    expect(stoppedAt([])).toBe('extract')
  })

  it('know a pipeline is over when a document is ready or failed, and that only a ready one has a reading to look at', () => {
    expect(isFinal('ready')).toBe(true)
    expect(isFinal('failed')).toBe(true)
    expect(isFinal('repair')).toBe(false)
    expect(isReady(makeDocument())).toBe(true)
    expect(isReady(makeDocument({ sample: 'prompt-injection' }))).toBe(false)
    expect(isReady(undefined)).toBe(false)
  })

  it('count whole seconds and never a negative number', () => {
    expect(secondsSince(1_000, 4_999)).toBe(3)
    expect(secondsSince(5_000, 1_000)).toBe(0)
  })

  it('say which failures are the service\'s own, so only those are said to be given back', () => {
    expect(isServiceFailure('model_budget')).toBe(true)
    expect(isServiceFailure('interrupted')).toBe(true)
    expect(isServiceFailure('injection_suspected')).toBe(false)
    expect(isServiceFailure('unsupported_file')).toBe(false)
  })
})

describe('the steps of the pipeline against the datasheet\'s chain', () => {
  it('give each of the nine links its recorded step, and say the repair a clean document did not need was skipped', () => {
    const rows = chainRows(makeDocument({ sample: 'clean-pdf' }))
    expect(rows.map(row => row.name)).toEqual(['ocr', 'injection check', 'extract', 'validate', 'repair', 'place fields', 'check duplicates', 'journal entry', undefined])
    expect(rows.map(row => row.state)).toEqual(['done', 'done', 'done', 'done', 'skipped', 'done', 'done', 'done', 'ready'])
    expect(rows[0]?.step?.detail.pages).toBe(1)
  })

  it('say a journal entry held back by a failed check was skipped and the export is held back', () => {
    const rows = chainRows(makeDocument({ sample: 'planted-total' }))
    expect(rows.find(row => row.name === 'journal entry')?.state).toBe('skipped')
    expect(rows.at(-1)?.state).toBe('blocked')
  })

  it('say a failed document got as far as the step that failed and no further', () => {
    const rows = chainRows(makeDocument({ sample: 'prompt-injection' }))
    expect(rows.map(row => row.state)).toEqual(['done', 'failed', 'notReached', 'notReached', 'notReached', 'notReached', 'notReached', 'notReached', 'notReached'])
  })

  it('list the facts a step recorded and the time the document waited for a reader', () => {
    const document = makeDocument({ sample: 'clean-pdf' })
    expect(factsOf({ name: 'x', status: 'ok', ms: 1, detail: { pages: 1, flagged: false } })).toEqual([['pages', 1], ['flagged', false]])
    expect(queueStep(document)?.detail.waited_ms).toBe(40)
  })
})
