// Unit tests for the SQL tokenizer: every kind of token, the promise that the tokens put back together
// are exactly the text that went in (whatever the text is), and that a long or hostile query costs
// time in proportion to its length. The tokenizer draws text; it is never trusted to understand it.
import { describe, expect, it } from 'vitest'

import { tokenizeSql } from '~/boards/lb-05/sql'
import type { SqlToken } from '~/boards/lb-05/sql'

/** Writes tokens as `kind:text` pairs, leaving out the spaces between them. */
function kinds(sql: string): string[] {
  return tokenizeSql(sql).filter(token => token.kind !== 'space').map(token => `${token.kind}:${token.text}`)
}

/** Puts tokens back together. */
function joined(tokens: readonly SqlToken[]): string {
  return tokens.map(token => token.text).join('')
}

describe('tokenizing SQL', () => {
  it('tells keywords, functions, names, numbers and strings apart', () => {
    expect(kinds('SELECT SUM(order_lines.quantity) FROM orders WHERE status = \'shipped\' LIMIT 10')).toEqual([
      'keyword:SELECT', 'function:SUM', 'operator:(', 'identifier:order_lines', 'operator:.', 'identifier:quantity', 'operator:)',
      'keyword:FROM', 'identifier:orders', 'keyword:WHERE', 'identifier:status', 'operator:=', 'string:\'shipped\'', 'keyword:LIMIT', 'number:10',
    ])
  })

  it('reads keywords in any case, and a function name before a bracket even with spaces between', () => {
    expect(kinds('select count (*) from t')).toEqual(['keyword:select', 'function:count', 'operator:(', 'operator:*', 'operator:)', 'keyword:from', 'identifier:t'])
  })

  it('reads numbers with fractions and exponents, and a quoted name as a name', () => {
    expect(kinds('3.14 1e-3 2E10 "Order Total"')).toEqual(['number:3.14', 'number:1e-3', 'number:2E10', 'identifier:"Order Total"'])
  })

  it('reads a doubled quote as part of a string', () => {
    expect(kinds('\'it\'\'s\' x')).toEqual(['string:\'it\'\'s\'', 'identifier:x'])
  })

  it('reads line and block comments, and an unterminated one to the end', () => {
    expect(kinds('a -- note\nb /* more */ c /* never closed')).toEqual(['identifier:a', 'comment:-- note', 'identifier:b', 'comment:/* more */', 'identifier:c', 'comment:/* never closed'])
  })

  it('reads an unterminated string to the end of the text', () => {
    expect(kinds('SELECT \'open')).toEqual(['keyword:SELECT', 'string:\'open'])
  })

  it('shows the words of an attack as keywords', () => {
    expect(kinds('DROP TABLE orders; DELETE FROM orders')).toEqual(['keyword:DROP', 'keyword:TABLE', 'identifier:orders', 'operator:;', 'keyword:DELETE', 'keyword:FROM', 'identifier:orders'])
  })
})

describe('the promise of the tokenizer', () => {
  const texts = [
    '',
    'SELECT 1',
    'line one\nline two\r\n\ttabbed',
    '<script>alert(1)</script> -- not markup, only text',
    '\'unterminated',
    '"unterminated',
    '/* unterminated',
    `ünïcödé ключ 咖啡 ☕ ${String.fromCharCode(0)} ${String.fromCharCode(0x202E)} reversed`,
    '1.2.3e+e-5',
    '((((((((((',
    '$1 $$ dollar $$ quoted',
  ]

  it.each(texts)('puts back together exactly what went in: %j', (text) => {
    expect(joined(tokenizeSql(text))).toBe(text)
  })

  it('makes no empty token, so it always moves on', () => {
    for (const text of texts) expect(tokenizeSql(text).every(token => token.text.length > 0)).toBe(true)
  })

  it('takes time in proportion to the text: a 13,000-character query of nested brackets and quotes in a blink', () => {
    const hostile = `${'(\''.repeat(3_000)}${'/*'.repeat(2_000)}${'"'.repeat(3_000)}`
    const started = performance.now()
    const tokens = tokenizeSql(hostile)
    expect(performance.now() - started).toBeLessThan(250)
    expect(joined(tokens)).toBe(hostile)
  })
})
