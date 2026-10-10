// Datasheets in the visitor's language, as reactive values for pages and components.
import { isLocaleCode, systemsIn } from '#shared/data/datasheets'
import type { LocaleCode } from '#shared/data/datasheets'
import type { System } from '#shared/schema/system'

/** Returns the current language as one of the site's codes, falling back to English. */
export function useLocaleCode(): ComputedRef<LocaleCode> {
  const { locale } = useI18n()
  return computed(() => (isLocaleCode(locale.value) ? locale.value : 'en'))
}

/** Returns the ten datasheets in the visitor's current language, in catalog order. */
export function useDatasheets(): ComputedRef<readonly System[]> {
  const code = useLocaleCode()
  return computed(() => systemsIn(code.value))
}
