// Tests for the word-level difference of two replies: the words only one reply has are marked, every character of
// both replies is kept, spaces and line breaks are never marked, two replies that share almost nothing are left
// unmarked (and say so), and replies too long to compare are shown plain.
import { describe, expect, it } from 'vitest'
import { hasChanges, piecesOf, wordDiff } from '~/boards/lb-10/diff'
import type { DiffPiece } from '~/boards/lb-10/diff'

/** Joins pieces back into their text. */
function joined(pieces: readonly DiffPiece[]): string {
  return pieces.map(piece => piece.text).join('')
}

/** Lists the marked words of a side. */
function marked(pieces: readonly DiffPiece[], kind: DiffPiece['kind']): string[] {
  return pieces.filter(piece => piece.kind === kind).map(piece => piece.text)
}

describe('the word-level difference', () => {
  it('cuts a text into words and the spaces between them, keeping every character', () => {
    expect(piecesOf('one  two\nthree')).toEqual(['one', '  ', 'two', '\n', 'three'])
    expect(piecesOf('')).toEqual([])
  })

  it('marks what only production\'s reply says as removed and what only the edited one says as added', () => {
    const diff = wordDiff('The order is late and lost.', 'The order is late, sorry.')
    expect(joined(diff.production)).toBe('The order is late and lost.')
    expect(joined(diff.edited)).toBe('The order is late, sorry.')
    expect(marked(diff.production, 'removed')).toEqual(['late', 'and', 'lost.'])
    expect(marked(diff.edited, 'added')).toEqual(['late,', 'sorry.'])
    expect(diff.compared && diff.related).toBe(true)
    expect(hasChanges(diff)).toBe(true)
  })

  it('never marks spaces and line breaks, so a reply laid out differently has no marks', () => {
    const diff = wordDiff('{"a": 1,\n  "b": 2}', '{"a": 1, "b": 2}')
    expect(hasChanges(diff)).toBe(false)
    expect(joined(diff.production)).toBe('{"a": 1,\n  "b": 2}')
  })

  it('leaves two replies that share almost no words unmarked, and says they are unrelated', () => {
    const diff = wordDiff('{"category": "damaged", "order_number": "BB-1040"}', 'The ticket is about an order. A colleague should look at it today.')
    expect(diff.related).toBe(false)
    expect(hasChanges(diff)).toBe(false)
    expect(joined(diff.edited)).toBe('The ticket is about an order. A colleague should look at it today.')
  })

  it('shows replies too long to compare word by word plain, and says it did not compare them', () => {
    const long = Array.from({ length: 1_200 }, (_, index) => `w${index}`).join(' ')
    const diff = wordDiff(long, `${long} more`)
    expect(diff.compared).toBe(false)
    expect(hasChanges(diff)).toBe(false)
    expect(joined(diff.edited)).toBe(`${long} more`)
  })

  it('compares two empty replies as the same', () => {
    expect(wordDiff('', '')).toEqual({ production: [], edited: [], compared: true, related: true })
  })
})
