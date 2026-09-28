// The datasheets in the visitor's language. The English records (systems.ts) are the
// source of truth; each other language overlays its own text on them, typeset for that
// language once, when this module loads.
import type { System } from '../schema/system'
import { vlnaDeep } from '../typography'
import { systems } from './systems'
import type { SystemRecord } from './systems'
import { systemsCs } from './systems.cs'

/** The site's languages: English, the default, and Czech. */
export const LOCALES = ['en', 'cs'] as const
/** One of the site's language codes. */
export type LocaleCode = (typeof LOCALES)[number]

/** The datasheet fields that change with the language. */
export type SystemText = Pick<System, 'name' | 'function' | 'visitorAction' | 'problem' | 'tryIt' | 'proves' | 'tags' | 'chain' | 'stack' | 'highlights' | 'limits'>
/** A system's slug, such as `lb-01`. */
export type SystemSlug = SystemRecord['slug']

// The ten datasheets in each language, built once. Czech gets non-breaking spaces after
// its single-letter words (see vlna).
const czech = vlnaDeep(systemsCs)
const byLocale: Record<LocaleCode, readonly System[]> = {
  en: systems,
  cs: systems.map(system => ({ ...system, ...czech[system.slug] })),
}

/** Tells whether a value is one of the site's language codes. */
export function isLocaleCode(value: unknown): value is LocaleCode {
  return LOCALES.includes(value as LocaleCode)
}

/** Returns the ten datasheets in a language, in catalog order. */
export function systemsIn(locale: LocaleCode): readonly System[] {
  return byLocale[locale]
}

/** Finds one datasheet in a language by its slug, ignoring case; undefined when there is none. */
export function findSystemIn(slug: string, locale: LocaleCode): System | undefined {
  const key = slug.toLowerCase()
  return byLocale[locale].find(system => system.slug === key)
}
