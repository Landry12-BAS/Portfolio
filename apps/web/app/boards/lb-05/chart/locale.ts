// The number and date conventions a chart's axes follow, so a Czech reader sees "1 500 000" and
// "leden" where an English reader sees "1,500,000" and "January". Vega formats the numbers and dates
// on an axis itself and knows English only, so for any other language it is handed a definition built
// from the browser's own `Intl` data: the separators and the names of the months and days are not
// typed in here. English is Vega's default, so it needs no definition.
import type { Config } from 'vega'

/** The languages the site speaks. */
export type ChartLanguage = 'en' | 'cs'

/** A language's number and date conventions, in the shape Vega reads them. */
export type VegaLocale = NonNullable<Config['locale']>

/** Number conventions in the shape Vega reads them. */
type NumberLocale = NonNullable<VegaLocale['number']>

/** Date and time conventions in the shape Vega reads them. */
type TimeLocale = NonNullable<VegaLocale['time']>

/** The languages whose conventions differ from Vega's English ones. */
type OtherLanguage = Exclude<ChartLanguage, 'en'>

/** How a language writes a date and time together, a date, and a time of day. */
interface Patterns {
  dateTime: string
  date: string
  time: string
}

// The patterns for a date and a time of day in each language that is not English.
const PATTERNS: Readonly<Record<OtherLanguage, Patterns>> = {
  cs: { dateTime: '%x %X', date: '%-d. %-m. %Y', time: '%H:%M:%S' },
}

/** Reads one separator off the browser's own number formatting, with a fallback if it has none. */
function separator(language: OtherLanguage, type: 'decimal' | 'group', fallback: string): string {
  const parts = new Intl.NumberFormat(language).formatToParts(1_234_567.5)
  return parts.find(part => part.type === type)?.value ?? fallback
}

/** Builds a language's number conventions from the browser's own data. */
function numberLocale(language: OtherLanguage): NumberLocale {
  return { decimal: separator(language, 'decimal', '.'), thousands: separator(language, 'group', ','), grouping: [3], currency: ['', ''] }
}

/** Names the twelve months in a language, by formatting the first day of each. */
function monthNames(language: OtherLanguage, style: 'long' | 'short'): TimeLocale['months'] {
  const format = new Intl.DateTimeFormat(language, { month: style, timeZone: 'UTC' })
  const names = Array.from({ length: 12 }, (_, month) => format.format(new Date(Date.UTC(2024, month, 1))))
  return names as TimeLocale['months']
}

/** Names the seven days in a language, starting from Sunday (the 7th of January 2024 was one). */
function dayNames(language: OtherLanguage, style: 'long' | 'short'): TimeLocale['days'] {
  const format = new Intl.DateTimeFormat(language, { weekday: style, timeZone: 'UTC' })
  const names = Array.from({ length: 7 }, (_, day) => format.format(new Date(Date.UTC(2024, 0, 7 + day))))
  return names as TimeLocale['days']
}

/** Names the morning and the afternoon in a language. */
function periodNames(language: OtherLanguage): TimeLocale['periods'] {
  const format = new Intl.DateTimeFormat(language, { hour: 'numeric', hour12: true, timeZone: 'UTC' })
  const nameAt = (hour: number): string => format.formatToParts(new Date(Date.UTC(2024, 0, 1, hour))).find(part => part.type === 'dayPeriod')?.value ?? ''
  return [nameAt(9), nameAt(15)]
}

/** Builds a language's date and time conventions from the browser's own data. */
function timeLocale(language: OtherLanguage): TimeLocale {
  return {
    ...PATTERNS[language],
    periods: periodNames(language),
    days: dayNames(language, 'long'),
    shortDays: dayNames(language, 'short'),
    months: monthNames(language, 'long'),
    shortMonths: monthNames(language, 'short'),
  }
}

/** Gives the conventions a language's chart follows, or undefined for English, which is Vega's own. */
export function vegaLocale(language: ChartLanguage): VegaLocale | undefined {
  if (language === 'en') return undefined
  return { number: numberLocale(language), time: timeLocale(language) }
}
