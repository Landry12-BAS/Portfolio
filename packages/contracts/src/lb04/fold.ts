// Folding: how a quote and a page's text are made comparable. A contract's text comes out of a
// PDF with line breaks in the middle of sentences, words split by a hyphen at the end of a line,
// curly quotes and ligatures, and a model that quotes it copies it a little differently each time.
// Both sides are folded the same way, so a quote is found when it says the same thing in the same
// letters, whatever the line breaks, hyphens, spacing, capitals, accents and quotation marks.
//
// A folded text, its key, keeps only letters, digits and symbols, lowercased and without accents.
// Every character of the key remembers where it came from in the original text, so a match in
// the key is turned back into a range of the original: that range is the citation. What the
// reader sees is always the original's own characters at that range, never the quote the model
// wrote.
//
// The module is pure and shared by the server and the board.

// What folding drops: combining marks (accents), format characters (soft hyphens, zero-width
// joiners), controls and white space, and every kind of dash or hyphen.
const DROPPED = /^[\p{M}\p{Cf}\p{Cc}\p{White_Space}\p{Pd}−]$/u
// The quotation marks that become a plain ' or ".
const SINGLE_QUOTES = new Set(['‘', '’', '‚', '‛', '′', 'ʼ', '´', '`'])
const DOUBLE_QUOTES = new Set(['“', '”', '„', '‟', '″', '«', '»'])

/** A text folded for comparison, and where each of its characters came from. */
export interface FoldedText {
  // The folded characters.
  key: string
  // For each character of the key: where the original character it came from starts, and where it ends (the end excluded), in the original's UTF-16 units.
  starts: readonly number[]
  ends: readonly number[]
}

/** Folds one ASCII character: white space and the hyphen vanish, a grave accent becomes an apostrophe, capitals become small letters. */
function foldAscii(character: string, code: number): string {
  if (code <= 0x20 || code === 0x7F || character === '-') return ''
  if (character === '`') return '\''
  return code >= 0x41 && code <= 0x5A ? character.toLowerCase() : character
}

/** Folds one character (a whole code point) into what it contributes to a key: nothing, or one or more characters. */
function foldCharacter(character: string): string {
  const code = character.charCodeAt(0)
  if (character.length === 1 && code < 0x80) return foldAscii(character, code)
  let folded = ''
  for (const part of character.normalize('NFKD').toLowerCase()) {
    if (DROPPED.test(part)) continue
    if (SINGLE_QUOTES.has(part)) folded += '\''
    else if (DOUBLE_QUOTES.has(part)) folded += '"'
    else folded += part
  }
  return folded
}

/** Folds a text and remembers where every character of the result came from. */
export function foldText(text: string): FoldedText {
  let key = ''
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  for (const character of text.toWellFormed()) {
    const folded = foldCharacter(character)
    for (let position = 0; position < folded.length; position += 1) {
      starts.push(offset)
      ends.push(offset + character.length)
    }
    key += folded
    offset += character.length
  }
  return { key, starts, ends }
}

/** Folds a quote into the key it is compared by. */
export function foldQuote(quote: string): string {
  return foldText(quote).key
}

/** A stretch of a page's text: `text.slice(start, end)`. */
export interface TextRange {
  start: number
  end: number
}

/** Turns a match in the key, from `from` for `length` characters, into the range of the original text it covers. */
function rangeOfMatch(folded: FoldedText, from: number, length: number): TextRange | undefined {
  const start = folded.starts[from]
  const end = folded.ends[from + length - 1]
  return start === undefined || end === undefined ? undefined : { start, end }
}

/**
 * Finds every place the quote occurs in the folded text, as ranges of the original text, in order.
 * A quote that folds to nothing, or occurs nowhere, gives an empty list. Matches may not overlap
 * one another, so a repeated phrase is reported once for each time it is written.
 */
export function findQuoteRanges(folded: FoldedText, quote: string): TextRange[] {
  const needle = foldQuote(quote)
  if (needle.length === 0) return []
  const ranges: TextRange[] = []
  for (let from = folded.key.indexOf(needle); from !== -1; from = folded.key.indexOf(needle, from + needle.length)) {
    const range = rangeOfMatch(folded, from, needle.length)
    if (range !== undefined) ranges.push(range)
  }
  return ranges
}
