// The redline. The model proposes replacement wording for one finding; what the reader sees is not
// the model's markup but a difference the server computes from the two texts, word by word: the
// words the contract has that the proposal drops, the words the proposal adds, and the words they
// share. A model can write what it likes, and the redline still shows exactly what would change.
//
// The difference is the longest common subsequence of the two lists of words, with one tidying
// step: a single short shared word between two changes (a "the" or an "of") is shown as changed
// too, so the redline reads as a few changes and not as a scatter of matches.
import type { Lb04DiffPart } from '@lb/contracts'

// A shared word this short, between two changes, is absorbed into them.
const SHORT_WORD = 3

/** Splits a text into its words: runs of characters that are not white space. */
export function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(word => word.length > 0)
}

/** One word of the difference, and what happened to it. */
interface Edit {
  op: 'equal' | 'delete' | 'insert'
  word: string
}

/** Builds the table of common-subsequence lengths of two lists of words: cell [i][j] is the length for the last i of `a` and the last j of `b`. */
function lengthsTable(a: readonly string[], b: readonly string[]): Uint16Array {
  const width = b.length + 1
  const table = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const here = i * width + j
      table[here] = a[i] === b[j] ? (table[here + width + 1] ?? 0) + 1 : Math.max(table[here + width] ?? 0, table[here + 1] ?? 0)
    }
  }
  return table
}

/** Walks the table from the start and lists, word by word, what is shared, deleted and inserted. */
function editsOf(a: readonly string[], b: readonly string[]): Edit[] {
  const width = b.length + 1
  const table = lengthsTable(a, b)
  const edits: Edit[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      edits.push({ op: 'equal', word: a[i] as string })
      i += 1
      j += 1
    }
    else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      edits.push({ op: 'delete', word: a[i] as string })
      i += 1
    }
    else {
      edits.push({ op: 'insert', word: b[j] as string })
      j += 1
    }
  }
  for (; i < a.length; i += 1) edits.push({ op: 'delete', word: a[i] as string })
  for (; j < b.length; j += 1) edits.push({ op: 'insert', word: b[j] as string })
  return edits
}

/** Groups consecutive edits of one kind into parts, each part's words joined by single spaces. */
function groupEdits(edits: readonly Edit[]): Lb04DiffPart[] {
  const parts: Lb04DiffPart[] = []
  for (const edit of edits) {
    const last = parts.at(-1)
    if (last?.op === edit.op) last.text = `${last.text} ${edit.word}`
    else parts.push({ op: edit.op, text: edit.word })
  }
  return parts
}

/** Tells whether a part is one short shared word, with a change on each side of it. */
function isLoneShortWord(parts: readonly Lb04DiffPart[], index: number): boolean {
  const part = parts[index]
  if (part?.op !== 'equal' || part.text.includes(' ') || part.text.length > SHORT_WORD) return false
  const before = parts[index - 1]
  const after = parts[index + 1]
  return before !== undefined && after !== undefined && before.op !== 'equal' && after.op !== 'equal'
}

/** Turns every lone short shared word into a deletion and an insertion of itself, so the changes around it run together. */
function absorbShortWords(edits: readonly Edit[]): Edit[] {
  const parts = groupEdits(edits)
  const result: Edit[] = []
  parts.forEach((part, index) => {
    const words = wordsOf(part.text)
    if (isLoneShortWord(parts, index)) {
      // The word is both removed and added, which keeps every word of both texts in the right order.
      result.push({ op: 'delete', word: words[0] as string }, { op: 'insert', word: words[0] as string })
    }
    else {
      for (const word of words) result.push({ op: part.op, word })
    }
  })
  return result
}

/** Puts the deletions before the insertions inside each run of changes, so a replaced phrase reads as old then new. */
function deletionsFirst(edits: readonly Edit[]): Edit[] {
  const result: Edit[] = []
  let run: Edit[] = []
  const flush = (): void => {
    result.push(...run.filter(edit => edit.op === 'delete'), ...run.filter(edit => edit.op === 'insert'))
    run = []
  }
  for (const edit of edits) {
    if (edit.op === 'equal') {
      flush()
      result.push(edit)
    }
    else {
      run.push(edit)
    }
  }
  flush()
  return result
}

/**
 * The difference between two texts, word by word, as parts the board shows one after another:
 * `equal` words both texts have, `delete` words only the first has, `insert` words only the second has.
 * The words of the `equal` and `delete` parts, in order, are the first text's; those of the `equal` and
 * `insert` parts are the second's.
 */
export function diffWords(original: string, proposal: string): Lb04DiffPart[] {
  const edits = editsOf(wordsOf(original), wordsOf(proposal))
  return groupEdits(deletionsFirst(absorbShortWords(edits)))
}
