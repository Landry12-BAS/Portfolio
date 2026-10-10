// Tests for showing a JSON reply so a person can read it without changing what the model wrote: the text is re-indented
// with every token kept as written (a number written 1.0, an escaped letter, a key written twice all stay), and a reply
// that is not one JSON document (prose, a fence, JSON with text after it) is not touched.
import { describe, expect, it } from 'vitest'
import { reindentJson, showReply } from '~/boards/lb-10/json'

describe('re-indenting a JSON reply', () => {
  it('lays an object out two spaces a level, and changes nothing else', () => {
    expect(reindentJson('{"a":1,"b":[true,null,"x"],"c":{}}')).toBe('{\n  "a": 1,\n  "b": [\n    true,\n    null,\n    "x"\n  ],\n  "c": {}\n}')
  })

  it('keeps every value exactly as the model wrote it, where parsing and writing again would change it', () => {
    const written = '{"price": 1.0, "name": "Caf\\u00e9", "big": 12345678901234567890, "dup": 1, "dup": 2}'
    const shown = reindentJson(written) ?? ''
    expect(shown).toContain('"price": 1.0')
    expect(shown).toContain('"name": "Caf\\u00e9"')
    expect(shown).toContain('"big": 12345678901234567890')
    expect(shown.match(/"dup"/g)).toHaveLength(2)
    expect(shown.replace(/\s/g, '')).toBe(written.replace(/\s/g, ''))
  })

  it('keeps the spaces, braces and commas inside a string as they are', () => {
    expect(reindentJson('{"text": "a, {b}: [c]  d"}')).toBe('{\n  "text": "a, {b}: [c]  d"\n}')
    expect(reindentJson('{"quote": "she said \\"no\\", twice"}')).toBe('{\n  "quote": "she said \\"no\\", twice"\n}')
  })

  it('leaves alone a reply that is not one JSON document', () => {
    expect(reindentJson('The ticket is about a late order.')).toBeUndefined()
    expect(reindentJson('```json\n{"a": 1}\n```')).toBeUndefined()
    expect(reindentJson('{"a": 1} and more')).toBeUndefined()
    expect(reindentJson('"just a string"')).toBeUndefined()
    expect(reindentJson('42')).toBeUndefined()
  })

  it('gives up on a reply that nests deeper than it follows, rather than draw it', () => {
    const deep = `${'['.repeat(80)}${']'.repeat(80)}`
    expect(reindentJson(deep)).toBeUndefined()
  })

  it('says whether it re-indented a reply or shows it as written', () => {
    expect(showReply('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', reindented: true })
    expect(showReply('prose')).toEqual({ text: 'prose', reindented: false })
  })
})
