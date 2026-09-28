import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { filterSystems } from '#shared/catalog'
import { systems } from '#shared/data/systems'
import { useCatalogStore } from '~/stores/catalog'
import { isReadingMode } from '~/stores/reading'

const parts = (list: readonly { part: string }[]) => list.map(system => system.part)

describe('filterSystems', () => {
  it('keeps everything when no filter is set', () => {
    expect(filterSystems(systems, { backend: 'all', technique: 'all' })).toHaveLength(10)
  })

  it('filters by back end', () => {
    expect(parts(filterSystems(systems, { backend: 'django', technique: 'all' }))).toEqual(['LB-01', 'LB-02', 'LB-09'])
    expect(parts(filterSystems(systems, { backend: 'node', technique: 'all' }))).toEqual(['LB-04', 'LB-06', 'LB-07', 'LB-08'])
  })

  it('filters by technique', () => {
    expect(parts(filterSystems(systems, { backend: 'all', technique: 'vision' }))).toEqual(['LB-03'])
  })

  it('requires both filters to match', () => {
    expect(parts(filterSystems(systems, { backend: 'flask', technique: 'structured' }))).toEqual(['LB-03', 'LB-05'])
    expect(filterSystems(systems, { backend: 'django', technique: 'vision' })).toEqual([])
  })
})

describe('catalog store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('starts unfiltered', () => {
    const catalog = useCatalogStore()
    expect(catalog.visible).toHaveLength(catalog.total)
    expect(catalog.filtered).toBe(false)
  })

  it('narrows the list and clears back to all ten', () => {
    const catalog = useCatalogStore()
    catalog.backend = 'node'
    catalog.technique = 'browser'
    expect(parts(catalog.visible)).toEqual(['LB-07'])
    expect(catalog.filtered).toBe(true)
    catalog.clear()
    expect(catalog.visible).toHaveLength(10)
    expect(catalog.filtered).toBe(false)
  })
})

describe('reading modes', () => {
  it('accepts only the two modes, so a tampered storage value is ignored', () => {
    expect(isReadingMode('brief')).toBe(true)
    expect(isReadingMode('technical')).toBe(true)
    expect(isReadingMode('<img onerror>')).toBe(false)
    expect(isReadingMode(null)).toBe(false)
  })
})
