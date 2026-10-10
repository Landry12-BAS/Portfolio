// Unit tests for how a result is written into a table: cells as text in the visitor's language,
// which columns are numbers, and how many rows show at a time. Also the plain-text clean-up that
// text from outside gets before it goes on a chart.
import { describe, expect, it } from 'vitest'

import { formatCell, formatMoment, formatNumber, isNumeric, nextShown, ROWS_PER_PAGE, rowsToShow } from '~/boards/lb-05/table'
import { plainText } from '~/boards/lb-05/text'

const WORDS = { empty: 'no value', yes: 'yes', no: 'no' }

describe('writing a cell', () => {
  it('writes whole numbers with their grouping in the visitor\'s language', () => {
    expect(formatCell(182400, 'integer', 'en', WORDS)).toBe('182,400')
    expect(formatCell(182400, 'integer', 'cs', WORDS)).toBe(`182${String.fromCharCode(0xA0)}400`)
  })

  it('writes a fraction with at most four decimals, and a rate as the fraction it is', () => {
    expect(formatNumber(0.034210987, 'number', 'en')).toBe('0.0342')
    expect(formatNumber(1234.5, 'number', 'cs')).toBe(`1${String.fromCharCode(0xA0)}234,5`)
  })

  it('writes nothing, yes and no in words the visitor can read', () => {
    expect(formatCell(null, 'text', 'en', WORDS)).toBe('no value')
    expect(formatCell(true, 'boolean', 'en', WORDS)).toBe('yes')
    expect(formatCell(false, 'boolean', 'en', WORDS)).toBe('no')
  })

  it('writes text as it is, even text that looks like a date', () => {
    expect(formatCell('Basalt Blend', 'text', 'en', WORDS)).toBe('Basalt Blend')
    expect(formatCell('2026-09-30', 'text', 'en', WORDS)).toBe('2026-09-30')
  })

  it('writes a date as the visitor\'s language writes a day, whether the warehouse gave it as a day or as midnight of that day', () => {
    expect(formatCell('2026-09-30', 'date', 'en', WORDS)).toBe('Sep 30, 2026')
    expect(formatCell('2026-09-30T00:00:00', 'date', 'en', WORDS)).toBe('Sep 30, 2026')
    expect(formatCell('2026-09-30T00:00:00', 'date', 'cs', WORDS).replaceAll(/\s+/g, ' ')).toBe('30. 9. 2026')
  })
})

describe('writing a moment', () => {
  it('adds the time of day when there is one, and never shifts it into another zone', () => {
    const written = formatMoment('2026-09-30T08:30:00', 'en')
    expect(written).toContain('Sep 30, 2026')
    expect(written).toContain('8:30')
    expect(formatMoment('2026-09-30T23:59:00Z', 'en')).toContain('Sep 30, 2026')
  })

  it('leaves text that is not a day or not a real one as it came', () => {
    for (const text of ['soon', '2026-02-31', '2026-13-01', '2026-09-30T25:00:00', '2026-09-30T08:30:00+02:00', '']) expect(formatMoment(text, 'en')).toBe(text)
  })
})

describe('what a column is', () => {
  it('calls integers and numbers numeric, and nothing else', () => {
    expect(['text', 'integer', 'number', 'date', 'boolean', 'other'].filter(kind => isNumeric(kind as never))).toEqual(['integer', 'number'])
  })
})

describe('showing rows a page at a time', () => {
  const rows = Array.from({ length: 120 }, (_, index) => index)

  it('shows the first page, and one more page each time, never more than there are', () => {
    expect(rowsToShow(rows, ROWS_PER_PAGE)).toHaveLength(50)
    expect(nextShown(50, rows.length)).toBe(100)
    expect(nextShown(100, rows.length)).toBe(120)
    expect(nextShown(120, rows.length)).toBe(120)
  })

  it('shows nothing for a count below zero', () => {
    expect(rowsToShow(rows, -3)).toEqual([])
  })
})

describe('plain text for a chart', () => {
  it('turns control characters into spaces and squeezes the spaces', () => {
    expect(plainText(`revenue${String.fromCharCode(10)}in${String.fromCharCode(9)}CZK`)).toBe('revenue in CZK')
    expect(plainText('  a   b  ')).toBe('a b')
  })

  it('removes the marks that reorder text and the zero-width characters', () => {
    expect(plainText(`pay${String.fromCharCode(0x202E)}ment${String.fromCharCode(0x200B)}s`)).toBe('pay ment s')
  })

  it('leaves ordinary text, accents and symbols alone', () => {
    expect(plainText('Káva z Etiopie, 250 g')).toBe('Káva z Etiopie, 250 g')
  })
})
