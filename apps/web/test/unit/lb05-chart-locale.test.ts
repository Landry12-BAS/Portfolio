// Tests of the number and date conventions a chart's axes follow: English is Vega's own and needs no
// definition, and Czech is built from the browser's own data in the shape Vega reads (twelve months,
// seven days starting from Sunday, the separators of numbers), so nothing of it is typed in.
import { describe, expect, it } from 'vitest'

import { vegaLocale } from '~/boards/lb-05/chart/locale'

describe('the conventions of a chart\'s axes', () => {
  it('gives none for English, which is the drawing library\'s own', () => {
    expect(vegaLocale('en')).toBeUndefined()
  })

  it('gives Czech its decimal comma and its space between thousands', () => {
    const number = vegaLocale('cs')?.number
    expect(number?.decimal).toBe(',')
    expect(number?.thousands).toMatch(/^\s$/u)
    expect(number?.grouping).toEqual([3])
    expect(number?.currency).toEqual(['', ''])
  })

  it('gives Czech twelve months and seven days, the days starting from Sunday', () => {
    const time = vegaLocale('cs')?.time
    expect(time?.months).toHaveLength(12)
    expect(time?.shortMonths).toHaveLength(12)
    expect(time?.days).toHaveLength(7)
    expect(time?.shortDays).toHaveLength(7)
    expect(time?.months[0]).toBe('leden')
    expect(time?.months[2]).toBe('březen')
    expect(time?.days[0]).toBe('neděle')
    expect(time?.days[1]).toBe('pondělí')
  })

  it('names each month and each day differently, and the morning and the afternoon differently', () => {
    const time = vegaLocale('cs')?.time
    expect(new Set(time?.months).size).toBe(12)
    expect(new Set(time?.days).size).toBe(7)
    expect(time?.periods[0]).not.toBe('')
    expect(time?.periods[0]).not.toBe(time?.periods[1])
  })

  it('writes a Czech date day first, with a full stop and a space after the day and the month', () => {
    expect(vegaLocale('cs')?.time?.date).toBe('%-d. %-m. %Y')
  })
})
