// Tests for the one function that makes a PDF page's text and its offset table (LB-04). The items
// are written by hand in the shape pdf.js gives them (the numbers come from a real extraction of a
// small contract), so the function is tested on its own, with no pdf.js: the server's real
// extraction and the browser's are compared in services/node-systems and in the board's journeys.
import { describe, expect, it } from 'vitest'

import { boxesForRange, buildPageText, extractPageText, isPageItem, PDF_TEXT_OPTIONS } from '../src/index.ts'
import type { PageItem } from '../src/index.ts'

/** Makes an upright item at (x, y) in a font of height 10, whose width is `width`. */
function item(str: string, x: number, y: number, width: number, hasEOL = false, height = 10): PageItem {
  return { str, transform: [height, 0, 0, height, x, y], width, height, hasEOL }
}

// What pdf.js gave for a heading, a sentence broken over two lines with a hyphen, and a numbered
// line made of two runs: including its empty items that mark the end of a line.
const CONTRACT_ITEMS: PageItem[] = [
  item('WHOLESALE SUPPLY AGREEMENT', 72, 760, 242.69, false, 14),
  item('', 72, 720, 0, true),
  item('9.1 The Supplier’s liability under this Agreement shall be unlimited and shall', 72, 720, 334.58, true),
  item('include indemni-', 72, 706, 72.8, true),
  item('fication of loss of profit.', 72, 692, 102.27, false),
  item('', 72, 670, 0, true),
  item('9.2', 72, 670, 13.9),
  item(' ', 85.9, 670, 4.1),
  item('Payment within ninety (90) days.', 90, 670, 144.5),
]

describe('the text of a page', () => {
  it('puts a line break where pdf.js marks one and keeps the words of a line together', () => {
    const page = buildPageText(CONTRACT_ITEMS)

    expect(page.text).toBe([
      'WHOLESALE SUPPLY AGREEMENT',
      '9.1 The Supplier’s liability under this Agreement shall be unlimited and shall',
      'include indemni-',
      'fication of loss of profit.',
      '9.2 Payment within ninety (90) days.',
    ].join('\n'))
    expect(page.truncated).toBe(false)
  })

  it('does not double a space pdf.js has already put in', () => {
    const page = buildPageText(CONTRACT_ITEMS)

    expect(page.text).toContain('9.2 Payment')
    expect(page.text).not.toContain('9.2  Payment')
  })

  it('breaks a line when the baseline moves, even if pdf.js did not say so', () => {
    const page = buildPageText([item('first line', 72, 700, 40), item('second line', 72, 686, 50)])

    expect(page.text).toBe('first line\nsecond line')
  })

  it('keeps a superscript on its line, and adds a space for a gap as wide as a word', () => {
    const page = buildPageText([item('clause', 72, 700, 30), item('2', 102, 704, 5), item('applies', 130, 700, 35)])

    expect(page.text).toBe('clause2 applies')
  })

  it('joins items that touch with nothing between them', () => {
    const page = buildPageText([item('indemni', 72, 700, 30), item('fication', 102, 700, 36)])

    expect(page.text).toBe('indemnification')
  })

  it('records, for each item that has text, where its characters lie, in order', () => {
    const page = buildPageText(CONTRACT_ITEMS)

    expect(page.runs.map(run => run.item)).toEqual([0, 2, 3, 4, 6, 7, 8])
    for (const run of page.runs) {
      expect(page.text.slice(run.start, run.end)).toBe(CONTRACT_ITEMS[run.item]?.str)
    }
    const ordered = page.runs.every((run, index) => index === 0 || run.start >= (page.runs[index - 1]?.end ?? 0))
    expect(ordered).toBe(true)
  })

  it('is the same every time it is run on the same items', () => {
    expect(buildPageText(CONTRACT_ITEMS)).toEqual(buildPageText(CONTRACT_ITEMS))
  })

  it('has no text at all for a page with only empty items, or none', () => {
    expect(buildPageText([]).text).toBe('')
    expect(buildPageText([item('', 72, 700, 0, true)]).runs).toEqual([])
  })

  it('replaces control characters and bidirectional controls with a space, and a lone surrogate with U+FFFD, one for one', () => {
    // Built at run time: a bidirectional override written into the source would be what the security lint exists to refuse.
    const override = String.fromCodePoint(0x202E)
    const raw = `a\u0000b\nc${override}d\uD800e`

    const page = buildPageText([item(raw, 72, 700, 60)])

    expect(page.text).toBe('a b c d�e')
    expect(page.text).toHaveLength(raw.length)
    expect(page.text.isWellFormed()).toBe(true)
  })

  it('stops at the character limit, so a page of millions of items costs a bounded amount', () => {
    const items = Array.from({ length: 1_000 }, (_, index) => item('word', 72, 700 - index * 12, 20))

    const page = buildPageText(items, { maxChars: 100 })

    expect(page.truncated).toBe(true)
    expect(page.text.length).toBeLessThanOrEqual(100)
    expect(page.runs.length).toBeLessThan(25)
  })

  it('treats a number that is not finite as zero instead of letting it spread', () => {
    const page = buildPageText([{ str: 'odd', transform: [Number.NaN, Number.POSITIVE_INFINITY, 0, 0, Number.NaN, 5], width: Number.POSITIVE_INFINITY, height: Number.NaN, hasEOL: false }])

    expect(page.text).toBe('odd')
    expect(Object.values(page.runs[0] ?? {}).every(value => Number.isFinite(value))).toBe(true)
  })

  it('does not break lines by geometry for turned text, which has no usable baseline', () => {
    const turned = (str: string, y: number): PageItem => ({ str, transform: [0, 10, -10, 0, 300, y], width: 40, height: 10, hasEOL: false })

    const page = buildPageText([turned('CONFIDENTIAL', 100), turned('DRAFT', 200)])

    expect(page.text).toBe('CONFIDENTIALDRAFT')
  })
})

describe('the boxes of a range of text', () => {
  const page = buildPageText(CONTRACT_ITEMS)
  const sentence = '9.1 The Supplier’s liability under this Agreement shall be unlimited and shall'

  it('gives one box for a range inside a line, within the line and as wide as the characters it covers', () => {
    const start = page.text.indexOf('unlimited')
    const boxes = boxesForRange(page, start, start + 'unlimited'.length)

    expect(boxes).toHaveLength(1)
    const [box] = boxes
    expect(box?.left).toBeGreaterThan(72)
    expect(box?.right).toBeLessThan(72 + 334.58)
    expect((box?.right ?? 0) - (box?.left ?? 0)).toBeGreaterThan(30)
    expect(box?.bottom).toBeLessThan(720)
    expect(box?.top).toBeGreaterThan(720)
  })

  it('covers a whole item with exactly its width', () => {
    const start = page.text.indexOf(sentence)
    const [box] = boxesForRange(page, start, start + sentence.length)

    expect(box?.left).toBeCloseTo(72, 5)
    expect(box?.right).toBeCloseTo(72 + 334.58, 5)
  })

  it('gives a box for each line a range touches, in reading order', () => {
    const start = page.text.indexOf('include indemni-')
    const end = page.text.indexOf('profit.') + 'profit.'.length

    const boxes = boxesForRange(page, start, end)

    expect(boxes).toHaveLength(2)
    expect(boxes[0]?.bottom).toBeGreaterThan(boxes[1]?.bottom ?? 0)
  })

  it('joins runs of one line that sit side by side into one box', () => {
    const start = page.text.indexOf('9.2')
    const boxes = boxesForRange(page, start, page.text.length)

    expect(boxes).toHaveLength(1)
    expect(boxes[0]?.left).toBeCloseTo(72, 5)
    expect(boxes[0]?.right).toBeCloseTo(90 + 144.5, 5)
  })

  it('places the edge of a range in a line by the letters\' own widths: "iii" is narrower than "WWW"', () => {
    const narrow = buildPageText([item('xx iii yy', 0, 0, 90)])
    const wide = buildPageText([item('xx WWW yy', 0, 0, 90)])

    const [narrowBox] = boxesForRange(narrow, 3, 6)
    const [wideBox] = boxesForRange(wide, 3, 6)

    expect((narrowBox?.right ?? 0) - (narrowBox?.left ?? 0)).toBeLessThan((wideBox?.right ?? 0) - (wideBox?.left ?? 0))
  })

  it('gives nothing for an empty range or one outside the text', () => {
    expect(boxesForRange(page, 5, 5)).toEqual([])
    expect(boxesForRange(page, page.text.length + 10, page.text.length + 20)).toEqual([])
  })

  it('puts the box of turned text along its baseline', () => {
    const turned = buildPageText([{ str: 'DRAFT', transform: [0, 10, -10, 0, 300, 100], width: 50, height: 10, hasEOL: false }])

    const [box] = boxesForRange(turned, 0, 5)

    expect((box?.top ?? 0) - (box?.bottom ?? 0)).toBeCloseTo(50, 5)
    expect((box?.right ?? 0) - (box?.left ?? 0)).toBeCloseTo(10.4, 5)
  })
})

describe('reading a page through pdf.js', () => {
  it('keeps the items that are text and passes over marked-content markers and anything malformed', async () => {
    const source = {
      getTextContent: async (options: { includeMarkedContent: boolean, disableNormalization: boolean }) => {
        expect(options).toEqual(PDF_TEXT_OPTIONS)
        return {
          items: [
            { type: 'beginMarkedContent', id: 'a' },
            { str: 'Hello', dir: 'ltr', transform: [10, 0, 0, 10, 72, 700], width: 25, height: 10, fontName: 'f1', hasEOL: false },
            { str: 'no transform', width: 1, height: 1, hasEOL: false },
            { str: 'bad numbers', transform: [10, 0, 0, 10, '72', 700], width: 25, height: 10, hasEOL: false },
            null,
            'a string',
            { type: 'endMarkedContent' },
          ],
        }
      },
    }

    const page = await extractPageText(source)

    expect(page.text).toBe('Hello')
  })

  it('knows a text item when it sees one', () => {
    expect(isPageItem(item('x', 0, 0, 1))).toBe(true)
    expect(isPageItem({ str: 'x' })).toBe(false)
    expect(isPageItem(undefined)).toBe(false)
  })
})
