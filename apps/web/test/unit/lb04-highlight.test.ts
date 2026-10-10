// Tests of what the board does with a citation apart from drawing it: cutting a page's text into cited and
// uncited stretches (ranges that overlap, touch, reach past the text or are empty), and saying whether the
// browser's reading of a page is the server's, which is the condition for drawing a highlight on the PDF.
import type { Lb04Finding } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { agreementOf, citationsOnPage, segmentsOf } from '~/boards/lb-04/highlight'

const TEXT = 'The buyer shall pay within ninety days of the invoice.'

describe('the segments of a page\'s text', () => {
  it('are the whole text when nothing is cited', () => {
    expect(segmentsOf(TEXT, [])).toEqual([{ text: TEXT, marked: false }])
  })

  it('mark exactly the characters a citation names, and join back into the text', () => {
    const start = TEXT.indexOf('within')
    const segments = segmentsOf(TEXT, [{ start, end: start + 'within ninety days'.length }])

    expect(segments).toEqual([
      { text: 'The buyer shall pay ', marked: false },
      { text: 'within ninety days', marked: true },
      { text: ' of the invoice.', marked: false },
    ])
    expect(segments.map(segment => segment.text).join('')).toBe(TEXT)
  })

  it('merge ranges that overlap or touch, whatever order they come in', () => {
    const segments = segmentsOf(TEXT, [{ start: 20, end: 30 }, { start: 4, end: 9 }, { start: 9, end: 12 }, { start: 25, end: 40 }])

    expect(segments.filter(segment => segment.marked).map(segment => segment.text)).toEqual([TEXT.slice(4, 12), TEXT.slice(20, 40)])
    expect(segments.map(segment => segment.text).join('')).toBe(TEXT)
  })

  it('clip a range that reaches past the text and drop one that is empty, backwards or outside it', () => {
    expect(segmentsOf(TEXT, [{ start: 40, end: 9_999 }]).filter(segment => segment.marked).map(segment => segment.text)).toEqual([TEXT.slice(40)])
    expect(segmentsOf(TEXT, [{ start: 5, end: 5 }, { start: 9, end: 3 }, { start: 100, end: 200 }])).toEqual([{ text: TEXT, marked: false }])
  })

  it('are nothing for no text', () => {
    expect(segmentsOf('', [{ start: 0, end: 5 }])).toEqual([])
  })
})

/** Makes a finding with a place, or a missing clause. */
function finding(id: string, page: number | undefined): Lb04Finding {
  if (page === undefined) return { id, kind: 'absent', topic: 'indemnity', rule: 'indemnity-present', title: 'x', severity: 'medium', summary: 'x', source: 'detector', searched: ['indemnify'] }
  return { id, kind: 'risk', topic: 'payment', rule: 'payment-slow', title: 'x', severity: 'medium', summary: 'x', source: 'model', clause: null, citation: { page, start: 1, end: 9 }, quote: 'x'.repeat(12) }
}

describe('the citations on a page', () => {
  it('are the risk findings\' citations for that page, and a missing clause has none', () => {
    const findings = [finding('f1', 3), finding('f2', 4), finding('f3', undefined), finding('f4', 3)]

    expect(citationsOnPage(findings, 3)).toEqual([{ page: 3, start: 1, end: 9 }, { page: 3, start: 1, end: 9 }])
    expect(citationsOnPage(findings, 9)).toEqual([])
  })
})

describe('whether the browser read the server\'s text', () => {
  it('is a match only when the two texts are identical to the character', () => {
    expect(agreementOf('abc', 'abc')).toBe('match')
    expect(agreementOf('abc', 'abd')).toBe('differs')
    expect(agreementOf('abc', 'abc ')).toBe('differs')
    expect(agreementOf('abc', undefined)).toBe('differs')
    expect(agreementOf(undefined, 'abc')).toBe('differs')
  })
})
