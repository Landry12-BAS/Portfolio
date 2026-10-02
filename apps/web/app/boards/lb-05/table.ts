// How a query's result is written into a table a visitor can read: each cell as text in the visitor's
// language (numbers with their grouping and decimal comma, dates and moments in the visitor's own way
// of writing them), which columns are numbers and so aligned to the right, and how many rows to show
// at a time. Every cell is data from the warehouse and is only ever shown as text.
import type { ColumnKind } from '#shared/data/sql-safety'

import type { Cell } from './schemas'

/** How many rows the table shows first, and how many more each press of "show more" adds. */
export const ROWS_PER_PAGE = 50

/** Tells whether a column holds numbers, which are written with a fixed set of digits and align to the right. */
export function isNumeric(kind: ColumnKind): boolean {
  return kind === 'integer' || kind === 'number'
}

/** The words a table uses for the values that are not text or a number: nothing, yes and no. */
export interface CellWords {
  empty: string
  yes: string
  no: string
}

/** Writes a number: a whole number with its grouping, a fractional one with at most four decimals. */
export function formatNumber(value: number, kind: ColumnKind, locale: string): string {
  if (!Number.isFinite(value)) return String(value)
  const digits = kind === 'integer' ? 0 : 4
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)
}

// A day, or a day and a time of day, as the warehouse writes it: with no offset, or in UTC.
const MOMENT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?Z?$/

/** A day or a moment read from text: when it is, counted in milliseconds as if it were UTC, and whether it is a whole day. */
interface ParsedMoment {
  time: number
  wholeDay: boolean
}

/**
 * Reads a day or a moment as the warehouse writes it, or returns undefined for text that is not one
 * (or not a real one: the 31st of February would roll over into March). The values carry no zone, so
 * they are read as the wall-clock day and time they say, counted as if they were UTC, and never shifted.
 */
function parseMoment(value: string): ParsedMoment | undefined {
  const parts = MOMENT.exec(value)
  if (!parts) return undefined
  const [, year = '', month = '', day = '', hour = '00', minute = '00', second = '00'] = parts
  const time = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  const moment = new Date(time)
  const real = !Number.isNaN(time) && moment.getUTCMonth() === Number(month) - 1 && moment.getUTCDate() === Number(day) && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59
  return real ? { time, wholeDay: hour === '00' && minute === '00' && second === '00' } : undefined
}

/** Counts a day or a moment in milliseconds as if it were UTC, so it reads the same in every time zone; undefined for text that is not one. */
export function momentToUtc(value: string): number | undefined {
  return parseMoment(value)?.time
}

/**
 * Writes a day or a moment as the visitor's language writes it: a day alone when the time of day is
 * midnight (the warehouse gives a date as midnight of that day), otherwise the day and the time. Text
 * that is not a day or a moment is returned as it came.
 */
export function formatMoment(value: string, locale: string): string {
  const parsed = parseMoment(value)
  if (!parsed) return value
  const style: Intl.DateTimeFormatOptions = parsed.wholeDay ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' }
  return new Intl.DateTimeFormat(locale, { ...style, timeZone: 'UTC' }).format(new Date(parsed.time))
}

/** Writes one cell as text in the visitor's language. */
export function formatCell(cell: Cell, kind: ColumnKind, locale: string, words: CellWords): string {
  if (cell === null) return words.empty
  if (typeof cell === 'boolean') return cell ? words.yes : words.no
  if (typeof cell === 'number') return formatNumber(cell, kind, locale)
  return kind === 'date' ? formatMoment(cell, locale) : cell
}

/** Cuts the rows to show first: the first `shown` of them, never more than there are. */
export function rowsToShow<T>(rows: readonly T[], shown: number): readonly T[] {
  return rows.slice(0, Math.max(shown, 0))
}

/** Works out how many rows to show after "show more": one more page, never more than there are. */
export function nextShown(shown: number, total: number): number {
  return Math.min(shown + ROWS_PER_PAGE, total)
}
