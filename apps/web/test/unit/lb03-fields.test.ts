// Tests of how LB-03's board lays out an invoice: the groups of fields in the order a person reads them,
// the words each field takes in both languages, the field lit first when a reading opens, and the
// arithmetic of drawing a box on its page (corners as shares of the page, bands as lines and segments).
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'

import { BAND_LINES, BAND_SEGMENTS, clampPage, confidencePercent, pageCount, placedOnPage, polygonPoints } from '~/boards/lb-03/boxes'
import { addressOf, fieldAt, fieldLabel, firstFieldToShow, groupFields, labelKey, rowNumber } from '~/boards/lb-03/fields'
import type { Translate } from '~/boards/lb-03/fields'
import type { Field } from '~/boards/lb-03/schemas'

import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'
import { makeDocument } from '../support/lb03'

/** Makes the translation function of a language, as a component gets it. */
function translator(locale: 'en' | 'cs'): Translate {
  return createI18n({ legacy: false, locale, messages: { en, cs } }).global.t as unknown as Translate
}

/** Makes a field with no box, for the cases that only need a path. */
function field(path: string, box: Field['box'] = null): Field {
  return { path, kind: 'amount', value: '1.00', box, edited: false, checks: [] }
}

describe('a field\'s path', () => {
  it('is read into its group, its row and its name', () => {
    expect(addressOf('vendor')).toEqual({ group: 'document', row: undefined, name: 'vendor' })
    expect(addressOf('line_items.1.total')).toEqual({ group: 'line', row: 1, name: 'total' })
    expect(addressOf('vat.0.rate')).toEqual({ group: 'vat', row: 0, name: 'rate' })
    expect(addressOf('subtotal').group).toBe('subtotal')
    expect(addressOf('total').group).toBe('total')
  })

  it('counts its row from one for a person, and has none for a field that is not in a list', () => {
    expect(rowNumber('line_items.0.description')).toBe(1)
    expect(rowNumber('vat.2.amount')).toBe(3)
    expect(rowNumber('total')).toBeUndefined()
  })

  it('takes its words from the locale file by what it is, so a line total and the total are named apart', () => {
    expect(labelKey('total')).toBe('lb03.fields.total')
    expect(labelKey('line_items.3.total')).toBe('lb03.fields.line.total')
    expect(labelKey('vat.1.amount')).toBe('lb03.fields.vat.amount')
    expect(labelKey('invoice_number')).toBe('lb03.fields.invoice_number')
  })

  it('has a name in both languages for every field of every sample, and the row for one in a list', () => {
    const english = translator('en')
    const czech = translator('cs')
    for (const sample of ['clean-pdf', 'euro-vat', 'handwritten-receipt']) {
      for (const item of makeDocument({ sample }).fields ?? []) {
        expect(labelKey(item.path), item.path).toBeDefined()
        expect(fieldLabel(item.path, english)).not.toBe(item.path)
        expect(fieldLabel(item.path, czech)).not.toMatch(/^lb03\./)
      }
    }
    expect(fieldLabel('line_items.1.total', english)).toBe('Line 2: Line total')
    expect(fieldLabel('vat.0.rate', czech)).toBe('Řádek DPH 1: Sazba, %')
    expect(fieldLabel('total', english)).toBe('Total')
    expect(fieldLabel('line_items', english)).toBe('Line items')
  })

  it('is shown as it is when the board has no word for it, and never as a key', () => {
    expect(labelKey('line_items.0.colour')).toBeUndefined()
    expect(fieldLabel('mystery', translator('en'))).toBe('mystery')
  })
})

describe('the groups of fields', () => {
  it('follow the order a person reads an invoice: the details, each line, the subtotal, each VAT line, the total', () => {
    const groups = groupFields(makeDocument({ sample: 'euro-vat' }).fields ?? [])
    expect(groups.map(group => group.key)).toEqual(['document', 'line-1', 'line-2', 'line-3', 'line-4', 'line-5', 'subtotal', 'vat-1', 'vat-2', 'vat-3', 'total'])
    expect(groups[0]?.fields.map(item => item.path)).toEqual(['document_type', 'vendor', 'invoice_number', 'issue_date', 'due_date', 'currency'])
    expect(groups[1]?.fields.map(item => item.path)).toEqual(['line_items.0.description', 'line_items.0.quantity', 'line_items.0.unit_price', 'line_items.0.total'])
    expect(groups.at(-1)?.fields.map(item => item.path)).toEqual(['total'])
  })

  it('give each row\'s heading its number, and the others none', () => {
    const groups = groupFields(makeDocument({ sample: 'clean-pdf' }).fields ?? [])
    expect(groups.find(group => group.key === 'line-2')?.heading).toEqual({ key: 'lb03.fields.groups.line', number: 2 })
    expect(groups.find(group => group.key === 'total')?.heading).toEqual({ key: 'lb03.fields.groups.total', number: undefined })
  })

  it('find a field by its path', () => {
    const fields = [field('total'), field('vendor')]
    expect(fieldAt(fields, 'vendor')?.path).toBe('vendor')
    expect(fieldAt(fields, 'nothing')).toBeUndefined()
    expect(fieldAt(null, 'total')).toBeUndefined()
    expect(fieldAt(fields, undefined)).toBeUndefined()
  })
})

describe('the field lit when a reading opens', () => {
  const box = { page: 1, quad: [0, 0, 1, 0, 1, 1, 0, 1], confidence: 0.9, match: 1, band: 'high' as const }

  it('is the one a failed check that stops the export names: the planted total', () => {
    const document = makeDocument({ sample: 'planted-total' })
    expect(firstFieldToShow(document.fields, document.checks)).toBe('total')
  })

  it('is the total of a document that passed every check, and the first found field when the total was not found', () => {
    const clean = makeDocument({ sample: 'clean-pdf' })
    expect(firstFieldToShow(clean.fields, clean.checks)).toBe('total')
    expect(firstFieldToShow([field('vendor'), field('currency', box)], [])).toBe('currency')
    expect(firstFieldToShow([field('vendor')], [])).toBe('vendor')
  })

  it('prefers a failed check that stops the export to a warning, and a field that was found to one that was not', () => {
    const error = { id: 'total_reconciles' as const, status: 'failed' as const, severity: 'error' as const, message: '', fields: ['total'], expected: null, actual: null }
    const warning = { id: 'fields_on_page' as const, status: 'failed' as const, severity: 'warning' as const, message: '', fields: ['vendor'], expected: null, actual: null }
    const fields = [field('vendor', box), field('total', box)]
    expect(firstFieldToShow(fields, [warning, error])).toBe('total')
    expect(firstFieldToShow([field('vendor', box), field('total')], [error])).toBe('vendor')
  })

  it('is nothing for a document with no fields', () => {
    expect(firstFieldToShow(null, null)).toBeUndefined()
    expect(firstFieldToShow([], [])).toBeUndefined()
  })
})

describe('a box on its page', () => {
  it('is written as the points of a polygon on a page that is one wide and one high', () => {
    expect(polygonPoints([0.1, 0.2, 0.5, 0.2, 0.5, 0.3, 0.1, 0.3])).toBe('0.10000,0.20000 0.50000,0.20000 0.50000,0.30000 0.10000,0.30000')
  })

  it('is clipped to the page when a corner strays outside it', () => {
    expect(polygonPoints([-0.2, 0.2, 1.4, 0.2, 1.4, 0.3, -0.2, 0.3])).toBe('0.00000,0.20000 1.00000,0.20000 1.00000,0.30000 0.00000,0.30000')
  })

  it('lists the fields found on a page, in the service\'s order, and none for a document with no fields', () => {
    const fields = [field('vendor', { page: 2, quad: [0, 0, 1, 0, 1, 1, 0, 1], confidence: 1, match: 1, band: 'high' }), field('total'), field('currency', { page: 1, quad: [0, 0, 1, 0, 1, 1, 0, 1], confidence: 1, match: 1, band: 'high' })]
    expect(placedOnPage(fields, 1).map(item => item.path)).toEqual(['currency'])
    expect(placedOnPage(fields, 2).map(item => item.path)).toEqual(['vendor'])
    expect(placedOnPage(null, 1)).toEqual([])
  })

  it('says how sure the reader is in a number, a kind of line and a count of segments, so colour is never the only way', () => {
    expect(confidencePercent({ page: 1, quad: [], confidence: 0.9712, match: 1, band: 'high' })).toBe(97)
    expect(BAND_LINES).toEqual({ high: 'solid', medium: 'dashed', low: 'dotted' })
    expect(BAND_SEGMENTS).toEqual({ high: 3, medium: 2, low: 1 })
    expect(new Set(Object.values(BAND_LINES)).size).toBe(3)
  })

  it('keeps the page number between the first page and the last', () => {
    expect(clampPage(0, 3)).toBe(1)
    expect(clampPage(2, 3)).toBe(2)
    expect(clampPage(9, 3)).toBe(3)
    expect(clampPage(1.9, 3)).toBe(1)
    expect(pageCount(null)).toBe(1)
    expect(pageCount(4)).toBe(4)
  })
})
