// A word-level difference of two outputs, worked out in the browser, so a visitor can see what changed between
// what production's prompt got and what theirs got. The outputs are split into words and the spaces between them,
// the longest sequence the two share is found (a plain table, the textbook method), and every other piece is
// marked as removed (only in production's output) or added (only in the edited prompt's). The pieces are text: the
// page draws each one as a text node inside a span or an <ins>/<del>, never as markup. Outputs are cut at 2,000
// characters by the service, so the table stays small; past a size this module gives up and marks nothing, which
// the page says.

/** One piece of an output: a word or the spaces after it, and whether the other output has it. */
export interface DiffPiece {
  text: string
  kind: 'same' | 'removed' | 'added'
}

/** The two outputs as pieces: production's with what it lost marked, the edited prompt's with what it gained. */
export interface WordDiff {
  production: DiffPiece[]
  edited: DiffPiece[]
  // False when the outputs were too long to compare word by word: every piece is then plain.
  compared: boolean
  // False when the two share too few words for marks to help (a JSON object against prose): every piece is then plain.
  related: boolean
}

// The most cells the comparison table may have: two outputs of 2,000 characters are about 700 words each.
const MAX_CELLS = 1_000_000
// The share of an output's words the other must share for the marks to be worth drawing.
const MIN_SHARED = 0.2
// A word, or a run of spaces and line breaks: the pieces an output is cut into.
const PIECE = /\s+|\S+/g

/** Cuts a text into words and the runs of space between them, keeping every character. */
export function piecesOf(text: string): string[] {
  return text.match(PIECE) ?? []
}

/** Builds the table of the longest common sequences of two lists of pieces, from the end of each. */
function commonTable(before: readonly string[], after: readonly string[]): Uint16Array[] {
  const table = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1))
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const row = table[i]!
    const below = table[i + 1]!
    for (let j = after.length - 1; j >= 0; j -= 1) {
      row[j] = before[i] === after[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  return table
}

/** Writes two texts as plain pieces, with nothing marked. */
function unmarked(before: readonly string[], after: readonly string[], compared: boolean, related: boolean): WordDiff {
  return { production: merge(before.map(text => ({ text, kind: 'same' }))), edited: merge(after.map(text => ({ text, kind: 'same' }))), compared, related }
}

/** Counts the words of a list of pieces, and those of them the other text shares. */
function sharedShare(pieces: readonly DiffPiece[]): number {
  const words = pieces.filter(piece => piece.text.trim() !== '')
  if (words.length === 0) return 1
  return words.filter(piece => piece.kind === 'same').length / words.length
}

/** Marks every piece of two texts as shared, only in the first (removed) or only in the second (added). */
export function wordDiff(production: string, edited: string): WordDiff {
  const before = piecesOf(production)
  const after = piecesOf(edited)
  if ((before.length + 1) * (after.length + 1) > MAX_CELLS) return unmarked(before, after, false, true)
  const table = commonTable(before, after)
  const left: DiffPiece[] = []
  const right: DiffPiece[] = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      left.push({ text: before[i]!, kind: 'same' })
      right.push({ text: after[j]!, kind: 'same' })
      i += 1
      j += 1
    }
    else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      left.push({ text: before[i]!, kind: 'removed' })
      i += 1
    }
    else {
      right.push({ text: after[j]!, kind: 'added' })
      j += 1
    }
  }
  for (; i < before.length; i += 1) left.push({ text: before[i]!, kind: 'removed' })
  for (; j < after.length; j += 1) right.push({ text: after[j]!, kind: 'added' })
  if (sharedShare(left) < MIN_SHARED && sharedShare(right) < MIN_SHARED) return unmarked(before, after, true, false)
  return { production: merge(left), edited: merge(right), compared: true, related: true }
}

/**
 * Joins neighbouring pieces of the same kind, so the page draws a few spans rather than one for every word. Spaces and
 * line breaks are never marked: a reply laid out differently is not a reply that says something else, and a mark over
 * a line break would draw over the start of the next line.
 */
function merge(pieces: readonly DiffPiece[]): DiffPiece[] {
  const merged: DiffPiece[] = []
  for (const piece of pieces) {
    const kind = piece.text.trim() === '' ? 'same' : piece.kind
    const last = merged.at(-1)
    if (last && last.kind === kind) last.text += piece.text
    else merged.push({ text: piece.text, kind })
  }
  return merged
}

/** Tells whether a diff found any difference at all. */
export function hasChanges(diff: WordDiff): boolean {
  return diff.production.some(piece => piece.kind !== 'same') || diff.edited.some(piece => piece.kind !== 'same')
}
