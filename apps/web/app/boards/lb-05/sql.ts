// SQL as the board shows it: split into tokens so a keyword, a string, a number and a comment can each
// be drawn in their own style, and every token is plain text in a span. The text is a model's, or the
// checked query's, and is never parsed as markup: nothing here builds HTML, and the tokens put back
// together are exactly the text that went in. The scanner is a single pass over the characters (no
// regular expression runs over the whole text), so a long or hostile query costs time in proportion
// to its length and no more. It does not understand SQL, only how it is written; what a query means
// is for the back end's parse-tree check to say.

/** What a token is, which decides how it is drawn. */
export type SqlTokenKind = 'keyword' | 'function' | 'identifier' | 'string' | 'number' | 'comment' | 'operator' | 'space'

/** One piece of a query: its kind and its exact text. */
export interface SqlToken {
  kind: SqlTokenKind
  text: string
}

// The words drawn as keywords: those of the queries the analyst writes, and those of the attacks it is shown.
const KEYWORDS: ReadonlySet<string> = new Set([
  'ALL', 'ALTER', 'ANALYZE', 'AND', 'AS', 'ASC', 'ATTACH', 'BETWEEN', 'BY', 'CALL', 'CASE', 'CAST', 'COPY', 'CREATE',
  'CROSS', 'CURRENT', 'DATABASE', 'DATE', 'DELETE', 'DESC', 'DESCRIBE', 'DISTINCT', 'DROP', 'ELSE', 'END', 'EXCEPT',
  'EXISTS', 'EXPLAIN', 'EXPORT', 'FALSE', 'FILTER', 'FIRST', 'FOLLOWING', 'FROM', 'FULL', 'GROUP', 'HAVING', 'ILIKE',
  'IN', 'INNER', 'INSERT', 'INSTALL', 'INTERSECT', 'INTERVAL', 'INTO', 'IS', 'JOIN', 'LAST', 'LEFT', 'LIKE', 'LIMIT',
  'LOAD', 'NOT', 'NULL', 'NULLS', 'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER', 'OVER', 'PARTITION', 'PRAGMA', 'PRECEDING',
  'RANGE', 'RECURSIVE', 'REPLACE', 'RIGHT', 'ROW', 'ROWS', 'SELECT', 'SET', 'SHOW', 'TABLE', 'THEN', 'TRUE',
  'TRUNCATE', 'UNBOUNDED', 'UNION', 'UPDATE', 'USING', 'VALUES', 'WHEN', 'WHERE', 'WITH',
])

/** Tells whether a character can start a word: a letter or an underscore, or any character beyond ASCII. */
function startsWord(character: string): boolean {
  return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || character === '_' || character > '\u007F'
}

/** Tells whether a character can continue a word. */
function continuesWord(character: string): boolean {
  return startsWord(character) || isDigit(character) || character === '$'
}

/** Tells whether a character is a decimal digit. */
function isDigit(character: string): boolean {
  return character >= '0' && character <= '9'
}

/** Tells whether a character is whitespace as SQL counts it. */
function isSpace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r' || character === '\f'
}

/** Finds where a run of characters that all pass a test ends, starting at a position. */
function endOfRun(sql: string, from: number, test: (character: string) => boolean): number {
  let end = from
  while (end < sql.length && test(sql.charAt(end))) end += 1
  return end
}

/** Finds where a quoted piece of text ends, counting a doubled quote as part of it. An unterminated one runs to the end of the text. */
function endOfQuoted(sql: string, from: number, quote: string): number {
  let position = from + 1
  while (position < sql.length) {
    if (sql.charAt(position) === quote) {
      if (sql.charAt(position + 1) !== quote) return position + 1
      position += 1
    }
    position += 1
  }
  return sql.length
}

/** Finds where a number ends: its digits, a fraction, and an exponent. */
function endOfNumber(sql: string, from: number): number {
  let end = endOfRun(sql, from, isDigit)
  if (sql.charAt(end) === '.' && isDigit(sql.charAt(end + 1))) end = endOfRun(sql, end + 1, isDigit)
  const exponent = sql.charAt(end)
  if (exponent === 'e' || exponent === 'E') {
    const sign = sql.charAt(end + 1) === '+' || sql.charAt(end + 1) === '-' ? 1 : 0
    if (isDigit(sql.charAt(end + 1 + sign))) end = endOfRun(sql, end + 1 + sign, isDigit)
  }
  return end
}

/** Finds where a comment that starts at a position ends, or returns the position itself when there is no comment there. */
function endOfComment(sql: string, from: number): number {
  if (sql.startsWith('--', from)) {
    const newline = sql.indexOf('\n', from)
    return newline === -1 ? sql.length : newline
  }
  if (sql.startsWith('/*', from)) {
    const close = sql.indexOf('*/', from + 2)
    return close === -1 ? sql.length : close + 2
  }
  return from
}

/** Tells whether the next thing after a position, past any spaces, is an opening bracket: a word followed by one is a function. */
function opensCall(sql: string, from: number): boolean {
  return sql.charAt(endOfRun(sql, from, isSpace)) === '('
}

/** Reads the token that starts at a position. */
function tokenAt(sql: string, from: number): SqlToken {
  const first = sql.charAt(from)
  if (isSpace(first)) return { kind: 'space', text: sql.slice(from, endOfRun(sql, from, isSpace)) }
  const commentEnd = endOfComment(sql, from)
  if (commentEnd > from) return { kind: 'comment', text: sql.slice(from, commentEnd) }
  if (first === '\'') return { kind: 'string', text: sql.slice(from, endOfQuoted(sql, from, '\'')) }
  if (first === '"') return { kind: 'identifier', text: sql.slice(from, endOfQuoted(sql, from, '"')) }
  if (isDigit(first)) return { kind: 'number', text: sql.slice(from, endOfNumber(sql, from)) }
  if (startsWord(first)) {
    const end = endOfRun(sql, from, continuesWord)
    const word = sql.slice(from, end)
    if (KEYWORDS.has(word.toUpperCase())) return { kind: 'keyword', text: word }
    return { kind: opensCall(sql, end) ? 'function' : 'identifier', text: word }
  }
  return { kind: 'operator', text: first }
}

/** Splits a query into tokens. Put back together, they are exactly the text that went in. */
export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  let position = 0
  while (position < sql.length) {
    const token = tokenAt(sql, position)
    tokens.push(token)
    position += token.text.length
  }
  return tokens
}
