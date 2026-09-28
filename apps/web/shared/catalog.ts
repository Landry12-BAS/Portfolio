// Vocabulary for the systems catalog: the back ends and techniques a visitor can filter
// by, and the filter itself. Only the stable keys live here; each language's labels
// live in the locale files (catalog.backends and catalog.techniqueNames).

/** Every back end a system can run on. */
export const BACKENDS = ['django', 'flask', 'node'] as const

/** Every AI technique a system can demonstrate. */
export const TECHNIQUES = [
  'rag',
  'tool',
  'multi',
  'vision',
  'voice',
  'browser',
  'structured',
  'citations',
  'evals',
  'multiprovider',
  'realtime',
  'local',
] as const

/** One back end key, such as `django`. */
export type Backend = (typeof BACKENDS)[number]
/** One technique key, such as `rag`. */
export type Technique = (typeof TECHNIQUES)[number]

/** The selection guide's two filters; `all` switches a filter off. */
export interface CatalogFilter {
  backend: Backend | 'all'
  technique: Technique | 'all'
}

/** The two fields of a system that the filters look at. */
interface Filterable {
  backend: Backend
  techniques: readonly Technique[]
}

/** Tells whether a system passes both filters. */
export function matchesFilter(system: Filterable, filter: CatalogFilter): boolean {
  return (filter.backend === 'all' || system.backend === filter.backend)
    && (filter.technique === 'all' || system.techniques.includes(filter.technique))
}

/** Returns the systems that pass both filters, in catalog order. */
export function filterSystems<T extends Filterable>(systems: readonly T[], filter: CatalogFilter): T[] {
  return systems.filter(system => matchesFilter(system, filter))
}
