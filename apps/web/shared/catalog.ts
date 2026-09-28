// Vocabulary for the systems catalog: the back ends and techniques a visitor can
// filter by, and the filter itself. Keys are stable; labels are what people read.

export const BACKENDS = {
  django: 'Django',
  flask: 'Flask',
  node: 'Node + TypeScript',
} as const

export const TECHNIQUES = {
  rag: 'RAG',
  tool: 'Tool use',
  multi: 'Multi-agent',
  vision: 'Vision',
  voice: 'Voice',
  browser: 'Browser agent',
  structured: 'Structured output',
  citations: 'Citations',
  evals: 'Evals',
  multiprovider: 'Multi-provider',
  realtime: 'Real-time',
  local: 'Local model',
} as const

export type Backend = keyof typeof BACKENDS
export type Technique = keyof typeof TECHNIQUES

export interface CatalogFilter {
  backend: Backend | 'all'
  technique: Technique | 'all'
}

interface Filterable {
  backend: Backend
  techniques: readonly Technique[]
}

export function matchesFilter(system: Filterable, filter: CatalogFilter): boolean {
  return (filter.backend === 'all' || system.backend === filter.backend)
    && (filter.technique === 'all' || system.techniques.includes(filter.technique))
}

export function filterSystems<T extends Filterable>(systems: readonly T[], filter: CatalogFilter): T[] {
  return systems.filter(system => matchesFilter(system, filter))
}
