// How a datasheet prints its measured values in the visitor's language: a duration in the hero's words
// (under 10 ms, 784 ms, 6.1 s), a count with the language's digit grouping, and a day written out.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/** Formatters for the numbers and dates a datasheet shows. */
export function useDatasheetFormat() {
  const { t, locale } = useI18n()
  const digits = computed(() => new Intl.NumberFormat(locale.value))
  const days = computed(() => new Intl.DateTimeFormat(locale.value, { day: 'numeric', month: 'long', year: 'numeric' }))

  /** A duration as the Scope prints it: instants under 10 ms, milliseconds under a second, seconds with one decimal above. */
  function duration(ms: number): string {
    if (ms < 10) return t('home.hero.scope.instant')
    if (ms < 1000) return t('home.hero.scope.ms', { n: digits.value.format(Math.round(ms)) })
    return t('home.hero.scope.s', { n: digits.value.format(Math.round(ms / 100) / 10) })
  }

  /** A count with the language's grouping, such as 1,351 or 1 351. */
  function count(n: number): string {
    return digits.value.format(n)
  }

  /** A day given as YYYY-MM-DD, written out in the visitor's language. */
  function day(iso: string): string {
    const [year, month, date] = iso.split('-').map(Number)
    if (!year || !month || !date) return iso
    return days.value.format(new Date(Date.UTC(year, month - 1, date, 12)))
  }

  return { duration, count, day }
}
