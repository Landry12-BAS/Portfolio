// Tests for splitting a contract into clauses (analysis/clauses.ts): clauses are found by numbers
// that follow one another, never by a line that merely begins with a figure; every clause lies inside
// one page and is exactly the slice of the page's text it says it is; page furniture is left out; and
// a contract with no usable numbering is still read in order.
import { describe, expect, it } from 'vitest'

import { clauseAt, splitClauses } from '../../src/modules/lb04/analysis/clauses.ts'
import type { PageInput } from '../../src/modules/lb04/analysis/clauses.ts'
import { extractedPages, seedContractIds } from '../support/lb04.ts'

/** Makes a one-page contract from lines. */
function onePage(...lines: string[]): PageInput[] {
  return [{ page: 1, text: lines.join('\n') }]
}

/** The numbers of the clauses, as printed. */
function numbers(pages: readonly PageInput[]): (string | null)[] {
  return splitClauses(pages).map(clause => clause.number)
}

describe('splitting by numbers', () => {
  it('finds articles and their clauses in order, with the heading of the article each belongs to', () => {
    const clauses = splitClauses(onePage(
      'AGREEMENT',
      '1. TERM',
      '1.1 This Agreement lasts two years.',
      '1.2 It renews each year.',
      '2. PAYMENT',
      '2.1 The Customer pays within 30 days.',
    ))

    expect(clauses.map(clause => [clause.number, clause.heading])).toEqual([
      [null, 'AGREEMENT'],
      ['1', 'TERM'],
      ['1.1', 'TERM'],
      ['1.2', 'TERM'],
      ['2', 'PAYMENT'],
      ['2.1', 'PAYMENT'],
    ])
  })

  it('keeps the lines that follow a clause with it until the next one starts', () => {
    const [, first] = splitClauses(onePage('1. TERM', '1.1 This Agreement lasts', 'two years and then ends.', '1.2 It may be renewed.', '2. PAYMENT'))

    expect(first?.text).toBe('1.1 This Agreement lasts\ntwo years and then ends.')
  })

  it('does not take a line that begins with a figure for a clause: a date, an amount, a number out of its turn', () => {
    const lines = [
      '1. TERM',
      '1.1 This Agreement starts on',
      '1 November 2026 and lasts two years.',
      '1.2 The Customer shall give notice',
      '30 days before the end.',
      '1.3 It renews yearly.',
      '2. PAYMENT',
      '2.1 Invoices are due in',
      '90 days.',
      '7.4 A stray number that does not follow.',
    ]

    expect(numbers(onePage(...lines))).toEqual(['1', '1.1', '1.2', '1.3', '2', '2.1'])
  })

  it('reads the named forms: Article 3, Section 4.1 and Clause 5', () => {
    const clauses = splitClauses(onePage('Article 1 - Term', 'The Agreement lasts two years.', 'Article 2: Payment', 'Invoices are due in 30 days.', 'Article 3 Notices', 'Notices are in writing.'))

    expect(clauses.map(clause => clause.number)).toEqual(['1', '2', '3'])
  })

  it('reads schedules only in order, from Schedule 1', () => {
    const clauses = splitClauses(onePage('1. TERM', '1.1 Two years.', '2. PAYMENT', '2.1 Thirty days.', 'Schedule 1 PRICES', 'Espresso 18 EUR', 'Schedule 2 DELIVERY', 'Weekly', 'Schedule 5 STRAY', 'Not a schedule'))

    expect(clauses.map(clause => clause.number)).toEqual(['1', '1.1', '2', '2.1', 'Schedule 1', 'Schedule 2'])
    expect(clauses.at(-1)?.text).toContain('Schedule 5 STRAY')
  })

  it('does not number a clause that skips ahead, and goes on from the number it had reached', () => {
    const clauses = splitClauses(onePage('1. TERM', '1.1 Two years.', '1.2 Renews.', '3. PAYMENT', '3.1 Thirty days.', '2. LIABILITY', '2.1 Capped.'))

    expect(clauses.map(clause => clause.number)).toEqual(['1', '1.1', '1.2', null, '2', '2.1'])
    expect(clauses[3]?.text).toBe('3. PAYMENT\n3.1 Thirty days.')
  })
})

describe('clauses and pages', () => {
  const pages: PageInput[] = [
    { page: 1, text: 'Page one header\n1. TERM\n1.1 This Agreement lasts\ntwo years.\n1' },
    { page: 2, text: 'Page one header\nand renews yearly.\n1.2 Either party may leave.\n2. PAYMENT\n2.1 Thirty days from the date of the\n2' },
    { page: 3, text: 'Page one header\ninvoice.\n2.2 Interest accrues.\n3. NOTICES\n3.1 In writing.\n3' },
  ]

  it('never lets a clause run over a page: the rest of it is a clause of its own on the next page, marked as continued', () => {
    const clauses = splitClauses(pages)

    expect(clauses.map(clause => [clause.page, clause.number, clause.continued])).toEqual([
      [1, '1', false],
      [1, '1.1', false],
      [2, '1.1', true],
      [2, '1.2', false],
      [2, '2', false],
      [2, '2.1', false],
      [3, '2.1', true],
      [3, '2.2', false],
      [3, '3', false],
      [3, '3.1', false],
    ])
  })

  it('leaves page numbers and a header that repeats on every page out of the clauses, and keeps them in the text', () => {
    const clauses = splitClauses(pages)
    const covered = clauses.map(clause => clause.text).join('\n')

    expect(covered).not.toContain('Page one header')
    expect(covered).not.toMatch(/^\d$/m)
    expect(pages[0]?.text).toContain('Page one header')
  })

  it('says exactly which slice of the page each clause is, and finds the clause that holds a place', () => {
    for (const clause of splitClauses(pages)) {
      expect(clause.text).toBe((pages[clause.page - 1] as PageInput).text.slice(clause.start, clause.end))
    }
    const text = (pages[1] as PageInput).text

    expect(clauseAt(splitClauses(pages), 2, text.indexOf('Either party'))?.number).toBe('1.2')
    expect(clauseAt(splitClauses(pages), 2, text.indexOf('and renews'))?.continued).toBe(true)
    expect(clauseAt(splitClauses(pages), 2, text.length + 10)).toBeUndefined()
    expect(clauseAt(splitClauses(pages), 9, 0)).toBeUndefined()
  })
})

describe('a contract with no numbering', () => {
  it('is cut into pieces of about a thousand characters, in order, with no numbers', () => {
    const sentence = 'The Supplier shall deliver the goods to the address on the order.'
    const text = Array.from({ length: 60 }, () => sentence).join('\n')

    const clauses = splitClauses([{ page: 1, text }])

    expect(clauses.length).toBeGreaterThan(2)
    expect(clauses.every(clause => clause.number === null && clause.heading === null)).toBe(true)
    expect(clauses.every(clause => clause.end - clause.start <= 1_400 + sentence.length)).toBe(true)
    expect(clauses.map(clause => clause.start)).toEqual([...clauses.map(clause => clause.start)].sort((a, b) => a - b))
  })

  it('is also what a file made of thousands of tiny numbered fragments gets, since each clause costs the model a label', () => {
    const fragments = Array.from({ length: 40 }, (_, article) => [`${article + 1}. A`, ...Array.from({ length: 49 }, (__, clause) => `${article + 1}.${clause + 1} b`)]).flat()
    const few = fragments.slice(0, 1_500)

    expect(splitClauses([{ page: 1, text: few.join('\n') }]).filter(clause => clause.number !== null)).toHaveLength(1_500)
    expect(splitClauses([{ page: 1, text: fragments.join('\n') }]).every(clause => clause.number === null)).toBe(true)
  })

  it('is read in order even when there is only a little numbering, and gives an empty contract no clauses', () => {
    expect(splitClauses([{ page: 1, text: '1. Only one.\nSome words.\n2. And a second.' }]).every(clause => clause.number === null)).toBe(true)
    expect(splitClauses([{ page: 1, text: '' }])).toEqual([])
    expect(splitClauses([])).toEqual([])
  })
})

describe('the seed contracts', () => {
  for (const id of seedContractIds().filter(candidate => candidate !== 'scanned-supply' && candidate !== 'master-supply-31')) {
    it(`${id}: every clause is the slice of its page it names, clauses never overlap, and they follow the document's order`, async () => {
      const pages = await extractedPages(id)
      const clauses = splitClauses(pages)

      expect(clauses.length).toBeGreaterThan(40)
      for (const clause of clauses) {
        expect(clause.text, clause.id).toBe((pages[clause.page - 1] as PageInput).text.slice(clause.start, clause.end))
      }
      for (let index = 1; index < clauses.length; index += 1) {
        const before = clauses[index - 1]
        const after = clauses[index]
        if (!before || !after) throw new Error('A clause is missing.')
        expect(after.page > before.page || (after.page === before.page && after.start >= before.end), after.id).toBe(true)
      }
      expect(new Set(clauses.map(clause => clause.id)).size).toBe(clauses.length)
    })
  }

  it('numbers the sample the way its articles are numbered, down to the sub-clauses', async () => {
    const clauses = splitClauses(await extractedPages('wholesale-supply'))
    const printed = new Set(clauses.map(clause => clause.number))

    for (const number of ['1', '3.2', '5.3', '19.2', '21', '21.1', 'Schedule 1', 'Schedule 3']) expect(printed.has(number), number).toBe(true)
    expect(clauses.find(clause => clause.number === '21.1')?.heading).toBe('LIABILITY')
  })
})
