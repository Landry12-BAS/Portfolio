// How LB-02's board writes times, dates, prices and languages for a visitor, in the visitor's
// language and on the roastery's clock. The server writes every moment in UTC; the sessions are held
// in Prague, so a visitor on any clock reads the time the roastery will see. Everything goes through
// Intl, so Czech gets its own order and spacing without a table of ours.
import { ROASTERY_TIME_ZONE } from './calendar'

// A space that does not break a line, so "14:30–15:30" never splits and "Fri 2 Oct" stays together.
const NBSP = String.fromCharCode(0x00A0)
// The en dash between the start and the end of a session.
const EN_DASH = String.fromCharCode(0x2013)

/** Writes a moment's time of day in Prague, such as `14:30`. */
export function formatClock(moment: string | number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: ROASTERY_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(moment))
}

/** Writes a moment's time of day with seconds, such as `14:35:20`, for a hold that runs out at a second. */
export function formatClockSeconds(moment: string | number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: ROASTERY_TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(moment))
}

/** Writes a session's time as a range, such as `14:30–15:30`, in Prague time. */
export function formatSession(startsAt: string, endsAt: string, locale: string): string {
  return `${formatClock(startsAt, locale)}${EN_DASH}${formatClock(endsAt, locale)}`
}

/** Writes a Prague date given as `YYYY-MM-DD` as a short weekday, day and month, such as `Fri 2 Oct`. */
export function formatDayShort(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00Z`)).replace(' ', NBSP)
}

/** Writes a Prague date given as `YYYY-MM-DD` with the weekday in full, such as `Friday 2 October`. */
export function formatDayLong(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00Z`))
}

/** Writes a moment's day and time in Prague, such as `Fri 2 Oct, 14:30`. */
export function formatWhen(moment: string, locale: string): string {
  const day = new Intl.DateTimeFormat(locale, { timeZone: ROASTERY_TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(moment))
  return `${day}, ${formatClock(moment, locale)}`
}

/** Writes a recorded moment as a date and a time in Prague time, such as `2 Oct 2026, 14:35`. */
export function formatRecorded(moment: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: ROASTERY_TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(moment))
}

/** Splits the time left of a hold into minutes and two-digit seconds, never below zero. */
export function countdown(untilMs: number, nowMs: number): { minutes: string, seconds: string, totalSeconds: number } {
  const totalSeconds = Math.max(Math.ceil((untilMs - nowMs) / 1_000), 0)
  return { minutes: String(Math.floor(totalSeconds / 60)), seconds: String(totalSeconds % 60).padStart(2, '0'), totalSeconds }
}

/** Writes a price in Czech crowns in the visitor's language, such as `450 CZK` or `450 Kč`. */
export function formatPrice(czk: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 }).format(czk)
}

/** Names a language by its code in the visitor's language, such as `Czech`; an unknown code is written as it is in capitals. */
export function languageName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames(locale, { type: 'language' }).of(code) ?? code.toUpperCase()
  }
  catch {
    return code.toUpperCase()
  }
}
