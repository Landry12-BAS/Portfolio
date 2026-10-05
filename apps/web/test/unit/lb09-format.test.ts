// Tests of how LB-09's board writes seconds, moments and languages: a second of the recording as
// minutes and seconds in every language, a length as the visitor's language writes numbers, and the
// language the transcriber heard named in the visitor's language whether it came as a code or as a
// name in English.
import { describe, expect, it } from 'vitest'

import { clockTime, decimalSeconds, languageName, withinSpan } from '~/boards/lb-09/format'

describe('a moment of the recording', () => {
  it('is minutes and seconds, rounded down, the same in every language', () => {
    expect(clockTime(0)).toBe('0:00')
    expect(clockTime(7.9)).toBe('0:07')
    expect(clockTime(60)).toBe('1:00')
    expect(clockTime(-3)).toBe('0:00')
  })

  it('falls in a span from its start up to, not including, its end', () => {
    expect(withinSpan(4, 4, 7)).toBe(true)
    expect(withinSpan(7, 4, 7)).toBe(false)
  })
})

describe('a length', () => {
  it('has one decimal, written as the visitor\'s language writes numbers', () => {
    expect(decimalSeconds(41.085, 'en')).toBe('41.1')
    expect(decimalSeconds(41.085, 'cs')).toBe('41,1')
    expect(decimalSeconds(5, 'cs')).toBe('5,0')
  })
})

describe('the language heard', () => {
  it('is named in the visitor\'s language when the transcriber gave its code', () => {
    expect(languageName('en', 'en')).toBe('English')
    expect(languageName('en', 'cs')).toBe('Angličtina')
    expect(languageName('CS', 'cs')).toBe('Čeština')
    expect(languageName('yue', 'en')).toBe('Cantonese')
  })

  it('is named in the visitor\'s language when the transcriber gave its name in English, in any case', () => {
    expect(languageName('English', 'cs')).toBe('Angličtina')
    expect(languageName('english', 'en')).toBe('English')
    expect(languageName('Czech', 'cs')).toBe('Čeština')
    expect(languageName('german', 'cs')).toBe('Němčina')
  })

  it('is written as it came, with a capital, when the browser does not know it', () => {
    expect(languageName('klingonese', 'cs')).toBe('Klingonese')
  })
})
