// Tests for folding (LB-04): how a quote and a page's text are made comparable, and how a match
// in the folded text is turned back into the exact range of the original. The citation is that
// range, so the property that matters is that the original's characters at the range are the
// ones that matched.
import { describe, expect, it } from 'vitest'

import { findQuoteRanges, foldQuote, foldText } from '../src/index.ts'

const PAGE = [
  '9.1 The Supplier’s liability under this Agreement shall be unlimited and shall',
  'include indemni-',
  'fication of loss of profit, including “consequential” loss.',
  'The Customer shall pay each invoice within ninety (90) days – no later.',
].join('\n')

/** Returns the original text at each range a quote is found in. */
function found(quote: string, text = PAGE): string[] {
  return findQuoteRanges(foldText(text), quote).map(range => text.slice(range.start, range.end))
}

describe('folding', () => {
  it('ignores line breaks, spacing, capitals, hyphens and accents', () => {
    expect(foldQuote('Café -  AU\nLait')).toBe('cafeaulait')
    expect(foldQuote('café au lait')).toBe('cafeaulait')
  })

  it('makes every kind of quotation mark one of two, and every dash nothing', () => {
    expect(foldQuote('“it’s”')).toBe('"it\'s"')
    expect(foldQuote('a–b—c−d­e-f')).toBe('abcdef')
  })

  it('writes a ligature and a fraction out in letters and digits', () => {
    expect(foldQuote('oﬃce')).toBe('office')
    expect(foldQuote('²')).toBe('2')
  })

  it('keeps digits, currency and symbols, so a different amount never matches', () => {
    expect(foldQuote('EUR 5,000')).not.toBe(foldQuote('EUR 50,000'))
    expect(foldQuote('€5')).toBe('€5')
  })

  it('folds nothing at all for text with no letters, digits or symbols', () => {
    expect(foldQuote(' \n\t - ­ ')).toBe('')
  })
})

describe('finding a quote in a page', () => {
  it('returns the original characters the quote matched', () => {
    expect(found('shall be unlimited and shall')).toEqual(['shall be unlimited and shall'])
  })

  it('finds a word that the page splits with a hyphen at the end of a line, and covers the hyphen and the break', () => {
    expect(found('loss of profit and indemnification')).toEqual([])
    expect(found('include indemnification of loss')).toEqual(['include indemni-\nfication of loss'])
  })

  it('finds a quote the model copied with straight quotes, other spacing and other capitals', () => {
    expect(found('including "Consequential" loss')).toEqual(['including “consequential” loss'])
    expect(found('PAY  EACH INVOICE within ninety (90) DAYS')).toEqual(['pay each invoice within ninety (90) days'])
  })

  it('does not find a quote that says something else, or is not there at all', () => {
    expect(found('the Supplier’s liability shall be capped')).toEqual([])
    expect(found('this contract has no risks')).toEqual([])
  })

  it('finds nothing for a quote that folds to nothing', () => {
    expect(found(' - \n ')).toEqual([])
    expect(found('')).toEqual([])
  })

  it('reports each time a repeated phrase is written, in order, without overlaps', () => {
    const text = 'Time is of the essence. Time is of the essence. aaaa'

    const ranges = findQuoteRanges(foldText(text), 'time is of the essence')
    const aaa = findQuoteRanges(foldText(text), 'aa')

    expect(ranges.map(range => range.start)).toEqual([0, 24])
    expect(aaa).toHaveLength(2)
  })

  it('counts positions in the original in UTF-16 units, so text.slice gives the characters', () => {
    const text = 'Café 😀 smile; liability is unlimited.'

    const [range] = findQuoteRanges(foldText(text), 'smile; liability')

    expect(text.slice(range?.start, range?.end)).toBe('smile; liability')
    expect(range?.start).toBe(8)
  })

  it('maps a match inside a ligature to the whole ligature character', () => {
    const text = 'the oﬃce lease'

    const [range] = findQuoteRanges(foldText(text), 'fice')

    expect(text.slice(range?.start, range?.end)).toBe('ﬃce')
  })

  it('keeps, for any stretch of a text, a range of the original that folds to what the stretch folds to', () => {
    // A small fixed pseudo-random walk over the page: every substring of at least 12 folded characters is found, and at each range
    // the original folds to the same key as the substring.
    let seed = 20_261_002
    const next = (limit: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % limit
    }
    const folded = foldText(PAGE)
    for (let round = 0; round < 200; round += 1) {
      const start = next(PAGE.length - 30)
      const length = 12 + next(Math.min(60, PAGE.length - start - 12))
      const stretch = PAGE.slice(start, start + length)
      if (foldQuote(stretch).length < 12) continue

      const ranges = findQuoteRanges(folded, stretch)

      expect(ranges.length).toBeGreaterThan(0)
      for (const range of ranges) expect(foldQuote(PAGE.slice(range.start, range.end))).toBe(foldQuote(stretch))
    }
  })

  it('is fast on a long text: a page of 160,000 characters folds and searches in well under a second', () => {
    const text = 'The Supplier shall deliver the Products. '.repeat(4_000)
    const started = performance.now()

    const folded = foldText(text)
    const ranges = findQuoteRanges(folded, 'shall deliver the products. the supplier')

    expect(ranges.length).toBeGreaterThan(1_000)
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
