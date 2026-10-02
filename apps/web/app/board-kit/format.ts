// How the boards write numbers and times for a visitor, in the visitor's language: durations
// ("530 ms", "2.7 s"), whole numbers with their thousands separator, percentages and dates.
// Everything goes through Intl, so Czech gets its comma and its spacing without a table of ours.

import { vlna } from '#shared/typography'

// A space that does not break a line, so "530 ms" never wraps between the number and its unit.
const NBSP = String.fromCharCode(0x00A0)

/** Writes a duration: whole milliseconds under a second, then seconds with one decimal. */
export function formatDuration(ms: number, locale: string): string {
  if (ms < 1_000) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(ms))}${NBSP}ms`
  const seconds = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(ms / 1_000)
  return `${seconds}${NBSP}s`
}

/** Writes a count with the locale's grouping, such as 2 300 in Czech and 2,300 in English. */
export function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
}

/** Writes a share from 0 to 1 as a percentage, such as "67 %" in Czech and "67%" in English. */
export function formatShare(share: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(share)
}

/** Writes a moment as a date and a time in UTC, the zone the daily limits turn over in. */
export function formatMoment(iso: string, locale: string): string {
  const moment = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso))
  return `${moment}${NBSP}UTC`
}

/** Writes a date alone, such as "2 Oct 2026". */
export function formatDay(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso))
}

/**
 * Sets Czech content, such as a ticket or the draft written for it, the way the site sets every
 * Czech text (no line ends on a single-letter word); other languages are left as they are. It
 * changes only where a line may break, so the words are the same.
 */
export function typeset(text: string, language: string): string {
  return language === 'cs' ? vlna(text) : text
}
