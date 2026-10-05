// The generated test as the code view shows it: lines, each cut into pieces of text with a kind (a
// comment, a quoted string, a keyword, or anything else), so the view can set each piece in its own type
// and colour with nothing but text spans. Nothing is parsed as markup and nothing is run: the cutting is a
// plain scan of characters, line by line, that knows only where a comment and a quoted string begin and
// end, which is all a test written by the service's template needs.

/** The kind of a piece of code, which decides how it is set. */
export type TokenKind = 'comment' | 'string' | 'keyword' | 'plain'

/** One piece of a line. */
export interface Token {
  kind: TokenKind
  text: string
}

// The words the template writes that read as the language's own.
const KEYWORDS: ReadonlySet<string> = new Set(['import', 'from', 'await', 'async', 'const', 'let', 'new', 'if', 'return', 'true', 'false', 'null', 'undefined'])
const QUOTES: ReadonlySet<string> = new Set(['\'', '"', '`'])

/** Tells whether a character is part of a word. */
function isWordCharacter(character: string): boolean {
  return /\w/.test(character)
}

/** Adds a piece to a line, joining it to the last one when they are of the same kind. */
function push(tokens: Token[], kind: TokenKind, text: string): void {
  if (text === '') return
  const last = tokens.at(-1)
  if (last && last.kind === kind) last.text += text
  else tokens.push({ kind, text })
}

/** Finds where a quoted string that opens at `start` ends: after its closing quote, or at the end of the line. A backslash escapes the next character. */
function stringEnd(line: string, start: number): number {
  const quote = line[start]
  for (let index = start + 1; index < line.length; index += 1) {
    if (line[index] === '\\') index += 1
    else if (line[index] === quote) return index + 1
  }
  return line.length
}

/** Cuts one line into its pieces. */
export function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < line.length) {
    const character = line[index] ?? ''
    if (character === '/' && line[index + 1] === '/') {
      push(tokens, 'comment', line.slice(index))
      break
    }
    if (QUOTES.has(character)) {
      const end = stringEnd(line, index)
      push(tokens, 'string', line.slice(index, end))
      index = end
      continue
    }
    if (isWordCharacter(character)) {
      let end = index
      while (end < line.length && isWordCharacter(line[end] ?? '')) end += 1
      const word = line.slice(index, end)
      push(tokens, KEYWORDS.has(word) ? 'keyword' : 'plain', word)
      index = end
      continue
    }
    push(tokens, 'plain', character)
    index += 1
  }
  return tokens
}

/** Cuts a whole test into lines of pieces. */
export function tokenize(source: string): Token[][] {
  const lines = source.replace(/\n$/, '').split('\n')
  return lines.map(tokenizeLine)
}
