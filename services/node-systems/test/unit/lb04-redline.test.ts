// Tests for the word-level difference of a redline (analysis/redline.ts). The model writes the proposal;
// the server computes what changes with code, so the invariants are the point: the words of the `equal`
// and `delete` parts, in order, are the contract's own, the words of the `equal` and `insert` parts are
// the proposal's, and nothing the model wrote around its answer can change what the reader is shown.
import { describe, expect, it } from 'vitest'

import { diffWords, wordsOf } from '../../src/modules/lb04/analysis/redline.ts'
import type { Lb04DiffPart } from '@lb/contracts'

/** Joins the words of the parts of a difference that a text of the given side holds. */
function sideOf(parts: readonly Lb04DiffPart[], side: 'original' | 'proposal'): string {
  const dropped = side === 'original' ? 'insert' : 'delete'
  return parts.filter(part => part.op !== dropped).map(part => part.text).join(' ')
}

/** A random number generator from a seed (mulberry32), so a property test is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

describe('the words of a text', () => {
  it('are the runs of characters between white space, whatever the white space is', () => {
    expect(wordsOf('  the Supplier\tshall\n\npay  (30) days ')).toEqual(['the', 'Supplier', 'shall', 'pay', '(30)', 'days'])
    expect(wordsOf('')).toEqual([])
    expect(wordsOf('   ')).toEqual([])
  })
})

describe('the difference between two texts', () => {
  it('shows a replaced number as the old number deleted and the new one inserted, with the words around it shared', () => {
    const parts = diffWords('The Customer shall pay each invoice within ninety (90) days of the date of the invoice.', 'The Customer shall pay each invoice within thirty (30) days of the date of the invoice.')

    expect(parts).toEqual([
      { op: 'equal', text: 'The Customer shall pay each invoice within' },
      { op: 'delete', text: 'ninety (90)' },
      { op: 'insert', text: 'thirty (30)' },
      { op: 'equal', text: 'days of the date of the invoice.' },
    ])
  })

  it('shows two texts that share nothing as all deleted and all inserted, in that order', () => {
    expect(diffWords('alpha beta', 'gamma delta epsilon')).toEqual([
      { op: 'delete', text: 'alpha beta' },
      { op: 'insert', text: 'gamma delta epsilon' },
    ])
  })

  it('shows identical texts as one shared part, whatever their spacing', () => {
    expect(diffWords('pay within thirty days', 'pay   within\nthirty days')).toEqual([{ op: 'equal', text: 'pay within thirty days' }])
  })

  it('shows a clause that is missing from the contract as wholly new text', () => {
    expect(diffWords('', 'Each party shall indemnify the other.')).toEqual([{ op: 'insert', text: 'Each party shall indemnify the other.' }])
  })

  it('shows a passage that is wholly removed as deleted', () => {
    expect(diffWords('Remove this sentence entirely.', '')).toEqual([{ op: 'delete', text: 'Remove this sentence entirely.' }])
  })

  it('gives nothing for two empty texts', () => {
    expect(diffWords('', '')).toEqual([])
  })

  it('puts the deletions before the insertions in each run of changes, so a replacement reads as old then new', () => {
    const parts = diffWords('A unlimited liability B', 'A capped liability C')

    for (let index = 1; index < parts.length; index += 1) {
      expect(parts[index - 1]?.op === 'insert' && parts[index]?.op === 'delete').toBe(false)
    }
  })

  it('joins two changes that only a short shared word separates, so the redline reads as one change and not as a scatter', () => {
    const parts = diffWords('liability of the Supplier is unlimited', 'liability of a Supplier is capped')

    expect(parts.filter(part => part.op === 'equal').map(part => part.text)).toEqual(['liability of', 'Supplier is'])
    expect(sideOf(parts, 'original')).toBe('liability of the Supplier is unlimited')
    expect(sideOf(parts, 'proposal')).toBe('liability of a Supplier is capped')
  })

  it('does not split a word or touch its punctuation: a changed comma is a changed word', () => {
    const parts = diffWords('pay within 30 days, in full', 'pay within 30 days in full')

    expect(parts).toEqual([
      { op: 'equal', text: 'pay within 30' },
      { op: 'delete', text: 'days,' },
      { op: 'insert', text: 'days' },
      { op: 'equal', text: 'in full' },
    ])
  })

  it('does not show markup a model writes as anything but words: tags and brackets are text', () => {
    const parts = diffWords('keep this', '<script>alert(1)</script> keep this **bold**')

    expect(parts.every(part => part.text.length > 0)).toBe(true)
    expect(sideOf(parts, 'proposal')).toBe('<script>alert(1)</script> keep this **bold**')
  })

  it('rebuilds both texts, word for word, for any two lists of words', () => {
    const random = seeded(20_261_004)
    const vocabulary = ['the', 'Supplier', 'Customer', 'shall', 'pay', 'within', '30', '90', 'days', 'of', 'a', 'an', 'invoice', 'liability', 'is', 'unlimited', 'capped', 'and', 'or', 'to']
    const phrase = (length: number) => Array.from({ length }, () => vocabulary[Math.floor(random() * vocabulary.length)] as string).join(' ')

    for (let round = 0; round < 300; round += 1) {
      const original = phrase(Math.floor(random() * 30))
      const proposal = random() < 0.4 ? original.split(' ').filter(() => random() < 0.8).join(' ') : phrase(Math.floor(random() * 30))

      const parts = diffWords(original, proposal)

      expect(sideOf(parts, 'original'), original).toBe(wordsOf(original).join(' '))
      expect(sideOf(parts, 'proposal'), proposal).toBe(wordsOf(proposal).join(' '))
      expect(parts.every(part => part.text !== ''), original).toBe(true)
      for (let index = 1; index < parts.length; index += 1) expect(parts[index]?.op === parts[index - 1]?.op, original).toBe(false)
    }
  })

  it('handles the longest passages a finding quotes in well under a second', () => {
    const long = Array.from({ length: 220 }, (_, index) => `word${index % 40}`).join(' ')
    const changed = Array.from({ length: 220 }, (_, index) => `word${(index * 7) % 40}`).join(' ')
    const started = performance.now()

    const parts = diffWords(long, changed)

    expect(performance.now() - started).toBeLessThan(1_000)
    expect(sideOf(parts, 'original')).toBe(long)
    expect(sideOf(parts, 'proposal')).toBe(changed)
    expect(parts.length).toBeLessThanOrEqual(1_000)
  })
})
