// Time as LB-02's roastery keeps it: Prague time. The server writes every moment in UTC, and the
// sessions, the days of the calendar and the words of a receipt all go by the Prague clock
// (services/django-systems/lb02/messages.py, `when_text`). These helpers turn a Prague date and
// hour into a moment and back, and write a session's time the way the real receipts do.

/** The roastery's time zone. */
export const ZONE = 'Europe/Prague'

const WEEKDAYS = {
  en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  cs: ['po', 'út', 'st', 'čt', 'pá', 'so', 'ne'],
} as const
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// The en dash between the start and the end of a session.
const EN_DASH = String.fromCharCode(0x2013)

const FORMAT = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' })

/** A moment broken into its Prague date and time. */
export interface PragueParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  // 0 for Monday up to 6 for Sunday.
  weekday: number
}

/** Reads the Prague date and time of a moment. */
export function pragueParts(moment: number): PragueParts {
  const parts = FORMAT.formatToParts(new Date(moment))
  const number = (type: string): number => Number(parts.find(part => part.type === type)?.value ?? '0')
  const name = parts.find(part => part.type === 'weekday')?.value ?? 'Mon'
  return { year: number('year'), month: number('month'), day: number('day'), hour: number('hour'), minute: number('minute'), weekday: Math.max(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name), 0) }
}

/** How far Prague's clock is ahead of UTC at a moment, in milliseconds. */
function zoneOffset(moment: number): number {
  const parts = pragueParts(moment)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - Math.floor(moment / 60_000) * 60_000
}

/** Finds the moment at which Prague's clock reads a date and time. */
export function pragueToUtc(year: number, month: number, day: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  const first = guess - zoneOffset(guess)
  const second = guess - zoneOffset(first)
  return second
}

/** Writes the Prague date of a moment as `YYYY-MM-DD`. */
export function pragueDay(moment: number): string {
  const parts = pragueParts(moment)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

/** Finds the date a number of days after another, as `YYYY-MM-DD`. */
export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number)
  const moved = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + days))
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, '0')}-${String(moved.getUTCDate()).padStart(2, '0')}`
}

/** Writes a session's day and time on the roastery's clock, as the real receipts do: `Fri 2 Oct, 14:30-15:30` and `pá 2. 10., 14:30-15:30`. */
export function whenText(startsAt: number, endsAt: number, language: 'en' | 'cs'): string {
  const start = pragueParts(startsAt)
  const end = pragueParts(endsAt)
  const clock = (parts: PragueParts): string => `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
  const hours = `${clock(start)}${EN_DASH}${clock(end)}`
  if (language === 'cs') return `${WEEKDAYS.cs[start.weekday] ?? ''} ${start.day}. ${start.month}., ${hours}`
  return `${WEEKDAYS.en[start.weekday] ?? ''} ${start.day} ${MONTHS_EN[start.month - 1] ?? ''}, ${hours}`
}

/** Writes a moment in ISO 8601 with a `Z`, as Pydantic writes a UTC moment. */
export function isoMoment(moment: number): string {
  return new Date(moment).toISOString().replace('.000Z', 'Z')
}
