// How a query's result is written into a table a visitor can read: each cell as text in the visitor's
// language (numbers with their grouping and decimal comma, dates as the database wrote them), which
// columns are numbers and so aligned to the right, and how many rows to show at a time. Every cell is
// data from the warehouse and is only ever shown as text.
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

/** Writes one cell as text in the visitor's language. */
export function formatCell(cell: Cell, kind: ColumnKind, locale: string, words: CellWords): string {
  if (cell === null) return words.empty
  if (typeof cell === 'boolean') return cell ? words.yes : words.no
  if (typeof cell === 'number') return formatNumber(cell, kind, locale)
  return cell
}

/** Cuts the rows to show first: the first `shown` of them, never more than there are. */
export function rowsToShow<T>(rows: readonly T[], shown: number): readonly T[] {
  return rows.slice(0, Math.max(shown, 0))
}

/** Works out how many rows to show after "show more": one more page, never more than there are. */
export function nextShown(shown: number, total: number): number {
  return Math.min(shown + ROWS_PER_PAGE, total)
}
