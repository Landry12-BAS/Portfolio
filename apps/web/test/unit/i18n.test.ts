// Unit tests for the site's two languages: the message files match key for key, carry
// no markup, and Czech typography keeps single-letter words off the end of a line.
import { describe, expect, it } from 'vitest'

import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'
import { vlna, vlnaDeep } from '#shared/typography'

/** Lists every message key as a dotted path, with its text. */
function flatten(messages: object, prefix = ''): [string, string][] {
  return Object.entries(messages).flatMap(([key, value]): [string, string][] =>
    typeof value === 'string' ? [[`${prefix}${key}`, value]] : flatten(value as object, `${prefix}${key}.`))
}

const english = flatten(en)
const czech = flatten(cs)

describe('message files', () => {
  it('have exactly the same keys in English and Czech', () => {
    expect(czech.map(([key]) => key)).toEqual(english.map(([key]) => key))
  })

  it('have no empty messages', () => {
    expect([...english, ...czech].filter(([, text]) => text.trim() === '')).toEqual([])
  })

  it('carry no markup and no vue-i18n syntax characters', () => {
    // Messages are plain text: no tags, no linked messages (@), no plural pipes (|).
    expect([...english, ...czech].filter(([, text]) => /[<>@|]/.test(text))).toEqual([])
  })

  it('use the same placeholders in both languages', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
    for (const [i, [key, text]] of english.entries()) {
      expect(placeholders(czech[i]![1]), key).toEqual(placeholders(text))
    }
  })

  it('are actually translated where the words differ', () => {
    const same = czech.filter(([key, text], i) => text === english[i]![1] && !/backends|techniqueNames\.rag|theme\.system|anatomy\.scope$|quickref\.ai$|board\.scope\.columns\.model$|lb01\.pipeline\.title$|lb06\.(services\.web|dashboard\.chart|dashboard\.markerLetters\.recovered|hypotheses\.where|postmortem\.title|value\.(mb|ms|percent))$/.test(key))
    expect(same.map(([key]) => key)).toEqual([])
  })
})

describe('Czech typography (vlna)', () => {
  it('joins single-letter words to the next word with a non-breaking space', () => {
    expect(vlna('Běží v prohlížeči a na serveru.')).toBe('Běží v\u00A0prohlížeči a\u00A0na serveru.')
  })

  it('handles runs of single-letter words, capitals and a word at the start', () => {
    expect(vlna('V obou případech a v noci')).toBe('V\u00A0obou případech a\u00A0v\u00A0noci')
    expect(vlna('„A to“ (s citací)')).toBe('„A\u00A0to“ (s\u00A0citací)')
  })

  it('leaves longer words and other letters alone', () => {
    expect(vlna('Jen testovací e-shop, 60 s')).toBe('Jen testovací e-shop, 60 s')
    expect(vlna('Graf b je jiný')).toBe('Graf b je jiný')
  })

  it('applies to every string in a nested value and keeps its shape', () => {
    expect(vlnaDeep({ list: ['k datům', 'z pravidel'], n: 3 })).toEqual({ list: ['k\u00A0datům', 'z\u00A0pravidel'], n: 3 })
  })
})
