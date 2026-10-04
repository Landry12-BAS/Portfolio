// Tests for the engine of the mock's LB-03 (src/testing/lb03-engine.ts): money as whole millionths, the nine
// checks, the duplicate rule, the journal entry and the two CSV files. The engine is a second implementation of
// what services/flask-systems/lb03 does, so it is held to the golden set, which is the real service's own
// ground truth: every planted error fails exactly the check the set names, every valid document passes all
// nine and makes a balanced entry, and the amounts the real code makes of the samples (printed once from
// Python: lb03/accounts.py, lb03/export.py) are the amounts written here.
import { describe, expect, it } from 'vitest'

import {
  amountText, blocksExport, cents, checkFieldsOnPage, duplicateResult, expectedPaths, fieldPaths, findDuplicate, getField, identityOf, journalCsv, journalTotals,
  linesCsv, parseAmount, post, quantityText, runChecks, safeCell, sameAmount, setField, times, vatAmount,
} from '../src/testing/lb03-engine.ts'
import type { Invoice } from '../src/testing/lb03-engine.ts'
import { readLb03Seed } from '../src/testing/lb03-seed.ts'

const seed = readLb03Seed()

/** Finds a golden document by its sample name or ID and returns its invoice. */
function invoiceOf(name: string): Invoice {
  const found = seed.cases.find(item => item.sample === name || item.id === name)
  if (found?.invoice === undefined) throw new Error(`No printed invoice for ${name}.`)
  return found.invoice
}

/** Reads an amount that must be one. */
function amount(text: string): bigint {
  const value = parseAmount(text)
  if (value === undefined) throw new Error(`${text} is not an amount.`)
  return value
}

describe('money', () => {
  it('reads and writes amounts as text, never through a float', () => {
    expect(amountText(amount('1850.00'))).toBe('1850.00')
    expect(amountText(amount('1850,5'))).toBe('1850.50')
    expect(amountText(amount('-250'))).toBe('-250.00')
    expect(amountText(amount('0.1') + amount('0.2'))).toBe('0.30')
    expect(quantityText(amount('4.000'))).toBe('4')
    expect(quantityText(amount('0.750'))).toBe('0.75')
    for (const text of ['lots', '1,2,3', '12.1234567', '', '1e3', '1 2x']) expect(parseAmount(text), text).toBeUndefined()
  })

  it('rounds half away from zero to the cent, as the service does', () => {
    expect(amountText(cents(amount('1.005')))).toBe('1.01')
    expect(amountText(cents(amount('-1.005')))).toBe('-1.01')
    expect(amountText(cents(amount('1.004999')))).toBe('1.00')
    expect(amountText(times(amount('0.75'), amount('19.90')))).toBe('14.93')
    expect(amountText(vatAmount(amount('8600.00'), amount('21')))).toBe('1806.00')
    expect(amountText(vatAmount(amount('910.00'), amount('7')))).toBe('63.70')
  })

  it('counts two amounts as the same when they differ by no more than a cent', () => {
    expect(sameAmount(amount('10.00'), amount('10.01'))).toBe(true)
    expect(sameAmount(amount('10.00'), amount('9.99'))).toBe(true)
    expect(sameAmount(amount('10.00'), amount('10.02'))).toBe(false)
  })
})

describe('the checks, held to the golden set', () => {
  it('pass every one of the nine on every document the golden set calls valid', () => {
    const valid = seed.cases.filter(item => item.expect.outcome === 'valid' && item.invoice !== undefined)
    expect(valid.length).toBeGreaterThan(25)

    for (const item of valid) {
      const failed = runChecks(item.invoice as Invoice, seed.today).filter(check => check.status === 'failed').map(check => check.id)
      expect(failed, item.id).toEqual([])
    }
  })

  it('fail exactly the check the golden set names on every planted error, and no other', () => {
    const planted = seed.cases.filter(item => item.expect.outcome === 'needs_review')
    expect(planted.map(item => item.expect.failingChecks[0]).toSorted()).toEqual(['dates_valid', 'line_items_sum', 'line_math', 'total_reconciles', 'vat_bases', 'vat_math'])

    for (const item of planted) {
      const failed = runChecks(item.invoice as Invoice, seed.today).filter(check => check.status === 'failed').map(check => check.id)
      expect(failed, item.id).toEqual(item.expect.failingChecks)
    }
  })

  it('say what disagrees, with the numbers, in the words the service uses', () => {
    const checks = runChecks(invoiceOf('planted-total'), seed.today)
    const total = checks.find(check => check.id === 'total_reconciles')

    expect(total).toMatchObject({ status: 'failed', severity: 'error', fields: ['total'], expected: '1193.85', actual: '1293.85' })
    expect(total?.message).toBe('The subtotal and the VAT come to 1193.85, but the total is 1293.85.')
    expect(blocksExport(checks)).toBe(true)
  })

  it('skip a check that has no numbers to work with, and say which', () => {
    const empty: Invoice = { documentType: 'invoice', vendor: null, invoiceNumber: null, issueDate: null, dueDate: null, currency: null, pricesIncludeVat: null, lineItems: [], subtotal: null, vat: [], total: null }
    const checks = runChecks(empty, seed.today)

    expect(checks.find(check => check.id === 'required_fields')).toMatchObject({ status: 'failed', fields: ['vendor', 'invoice_number', 'issue_date', 'currency', 'total', 'line_items'] })
    expect(checks.filter(check => check.status === 'skipped').map(check => check.id)).toEqual(['dates_valid', 'currency_known', 'signs_agree', 'line_math', 'line_items_sum', 'vat_math', 'vat_bases', 'total_reconciles'])
  })

  it('warn, and never block, for a value no word of the page was found for, unless the visitor typed it', () => {
    const invoice = invoiceOf('clean-pdf')
    const expected = expectedPaths(invoice)

    const none = checkFieldsOnPage(invoice, new Set(), new Set())
    const typed = checkFieldsOnPage(invoice, new Set(expected.slice(1)), new Set(expected.slice(0, 1)))

    expect(none).toMatchObject({ status: 'failed', severity: 'warning' })
    expect(none.fields).toEqual(expected)
    expect(typed.status).toBe('passed')
    expect(blocksExport([none])).toBe(false)
  })
})

describe('the duplicate rule', () => {
  it('names a sample for another file of its invoice, and not for the sample\'s own file', () => {
    const samples = seed.cases.filter(item => item.sample !== undefined && item.invoice !== undefined).map(item => ({ source: 'sample' as const, reference: String(item.sample), identity: identityOf(item.invoice as Invoice)!, fileSha256: item.sha256 }))
    const clean = identityOf(invoiceOf('clean-pdf'))!

    const match = findDuplicate(clean, samples)
    const own = findDuplicate(clean, samples, seed.cases.find(item => item.sample === 'clean-pdf')!.sha256)

    expect(match).toMatchObject({ known: { source: 'sample', reference: 'clean-pdf' }, sameContent: true })
    expect(own).toBeUndefined()
    expect(duplicateResult(clean, match)).toMatchObject({ status: 'failed', severity: 'error', expected: 'a document not seen before', actual: 'sample clean-pdf' })
    expect(duplicateResult(clean, undefined).status).toBe('passed')
    expect(duplicateResult(undefined, undefined).status).toBe('skipped')
  })

  it('keeps one vendor under its spellings and one number under its separators, and tells changed content from the same', () => {
    const base = invoiceOf('clean-pdf')
    const respelled = { ...base, vendor: 'BOHÉMIA packaging S.R.O', invoiceNumber: '2026 0412' }
    const changed = { ...base, total: (base.total ?? 0n) + amount('1.00') }

    expect(identityOf(respelled)).toMatchObject({ vendor: identityOf(base)?.vendor, number: identityOf(base)?.number, content: identityOf(base)?.content })
    expect(identityOf(changed)?.content).not.toBe(identityOf(base)?.content)
    expect(identityOf({ ...base, invoiceNumber: null })).toBeUndefined()
  })
})

describe('editing a field', () => {
  it('replaces one field of a copy, checked as a model\'s reply is, and leaves the invoice it was made from alone', () => {
    const invoice = invoiceOf('clean-pdf')

    const edited = setField(invoice, 'total', '999999.99')

    expect(getField(edited as Invoice, 'total')).toBe('999999.99')
    expect(getField(invoice, 'total')).toBe('10406.00')
    expect(runChecks(edited as Invoice, seed.today).find(check => check.id === 'total_reconciles')?.status).toBe('failed')
  })

  it('refuses a value that does not fit its field, a field the invoice has not, and a path of the wrong shape', () => {
    const invoice = invoiceOf('clean-pdf')
    const refused: [string, string][] = [['total', 'lots'], ['issue_date', '31.02.2026'], ['issue_date', '2026-13-01'], ['line_items.99.total', '1.00'], ['line_items.0.nope', '1'], ['vat.5.rate', '21'], ['__class__', 'x'], ['line_items.0', '1'], ['vendor', 'x'.repeat(121)], ['currency', 'euros'], ['document_type', 'poem']]

    for (const [path, value] of refused) expect(setField(invoice, path, value), `${path} = ${value}`).toBeUndefined()
  })

  it('empties a field for empty text, reads a symbol as its currency, and writes quantities without trailing zeros', () => {
    const invoice = invoiceOf('clean-pdf')

    expect(getField(setField(invoice, 'due_date', '') as Invoice, 'due_date')).toBeNull()
    expect(getField(setField(invoice, 'currency', '€') as Invoice, 'currency')).toBe('EUR')
    expect(getField(setField(invoice, 'line_items.0.quantity', '4,500') as Invoice, 'line_items.0.quantity')).toBe('4.5')
  })

  it('lists every field in reading order, so a table can be drawn from it', () => {
    const paths = fieldPaths(invoiceOf('clean-pdf'))

    expect(paths.slice(0, 7)).toEqual(['document_type', 'vendor', 'invoice_number', 'issue_date', 'due_date', 'currency', 'line_items.0.description'])
    expect(paths.at(-1)).toBe('total')
    expect(paths).toContain('vat.0.amount')
  })
})

describe('the journal entry', () => {
  /** Writes an entry as account, debit and credit, the way the service's own code was asked to print the samples. */
  function lines(name: string): string[][] {
    const entry = post(invoiceOf(name), seed.chart)
    return (entry?.lines ?? []).map(line => [line.account, amountText(line.debit), amountText(line.credit)])
  }

  it('is the entry the service makes of each sample, to the cent', () => {
    expect(lines('clean-pdf')).toEqual([['5020', '8600.00', '0.00'], ['1400', '1806.00', '0.00'], ['2100', '0.00', '10406.00']])
    expect(lines('euro-vat')).toEqual([['5010', '2933.00', '0.00'], ['5020', '185.00', '0.00'], ['5040', '240.00', '0.00'], ['5090', '45.00', '0.00'], ['1400', '286.06', '0.00'], ['2100', '0.00', '3689.06']])
    expect(lines('crumpled-photo')).toEqual([['5020', '12280.00', '0.00'], ['1400', '2578.80', '0.00'], ['2100', '0.00', '14858.80']])
    expect(lines('prompt-injection')).toEqual([['5010', '2700.00', '0.00'], ['5040', '180.00', '0.00'], ['1400', '576.00', '0.00'], ['2100', '0.00', '3456.00']])
  })

  it('takes the VAT out of a receipt whose prices hold it, and credits the till and not the supplier', () => {
    expect(lines('handwritten-receipt')).toEqual([['5070', '116.07', '0.00'], ['1400', '13.93', '0.00'], ['1010', '0.00', '130.00']])
  })

  it('balances for every document the golden set calls valid', () => {
    for (const item of seed.cases.filter(candidate => candidate.expect.outcome === 'valid' && candidate.invoice !== undefined)) {
      const entry = post(item.invoice as Invoice, seed.chart)
      expect(entry, item.id).toBeDefined()
      const totals = journalTotals(entry!)
      expect(totals.debit, item.id).toBe(totals.credit)
    }
  })

  it('is refused for a document whose numbers cannot balance', () => {
    expect(post(invoiceOf('planted-total'), seed.chart)).toBeUndefined()
  })
})

describe('the two CSV files', () => {
  it('are, for the handwritten receipt, the very text the service writes: a byte order mark, CRLF lines, an empty cell for none', () => {
    const invoice = invoiceOf('handwritten-receipt')

    expect(linesCsv(invoice)).toBe('﻿vendor,invoice_number,document_type,issue_date,due_date,currency,line,description,quantity,unit_price,line_total,subtotal,vat_total,total\r\nCafe Luna,0187,receipt,2026-09-12,,CZK,1,Flat white,2,49.00,98.00,,13.93,130.00\r\nCafe Luna,0187,receipt,2026-09-12,,CZK,2,Croissant,1,32.00,32.00,,13.93,130.00\r\n')
    expect(journalCsv(post(invoice, seed.chart)!)).toBe('﻿date,reference,account,account_name,debit,credit,currency,memo\r\n2026-09-12,Cafe Luna 0187,5070,Food and drink,116.07,,CZK,Cafe Luna 0187\r\n2026-09-12,Cafe Luna 0187,1400,Input VAT receivable,13.93,,CZK,Cafe Luna 0187\r\n2026-09-12,Cafe Luna 0187,1010,Cash and card payments,,130.00,CZK,Cafe Luna 0187\r\n')
  })

  it('turn a cell that a spreadsheet would run as a formula into text', () => {
    expect(safeCell('=HYPERLINK("http://evil.example/x","Click")')).toBe('\'=HYPERLINK("http://evil.example/x","Click")')
    for (const text of ['+1 free coffee', '-2 discount', '@SUM(A1:A9)', '\tTab', '＝full width']) expect(safeCell(text).startsWith('\''), text).toBe(true)
    expect(safeCell('Kraft coffee bag')).toBe('Kraft coffee bag')
    expect(safeCell(null)).toBe('')
    expect(safeCell('line\nbreak')).toBe('line break')
  })

  it('quote a cell that holds a comma or a quote, so a description cannot add a column', () => {
    const invoice = { ...invoiceOf('handwritten-receipt'), vendor: 'Luna, "the cafe"' }

    expect(linesCsv(invoice)).toContain('"Luna, ""the cafe"""')
  })
})
