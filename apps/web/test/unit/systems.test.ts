// Unit tests for the datasheets: the English source records, and the Czech translation
// checked against them field by field.
import { iconNames } from '@lb/icons'
import { describe, expect, it } from 'vitest'

import { TECHNIQUES } from '#shared/catalog'
import { findSystemIn, LOCALES, systemsIn } from '#shared/data/datasheets'
import { systems } from '#shared/data/systems'
import { SystemSchema } from '#shared/schema/system'

describe('the English datasheets', () => {
  it.each(systems.map(system => [system.part, system]))('%s matches the datasheet schema', (_, system) => {
    expect(() => SystemSchema.parse(system)).not.toThrow()
  })

  it('lists LB-01 to LB-10 in order, each with its own slug', () => {
    expect(systems.map(system => system.part)).toEqual(
      Array.from({ length: 10 }, (_, i) => `LB-${String(i + 1).padStart(2, '0')}`),
    )
    expect(systems.every(system => system.slug === system.part.toLowerCase())).toBe(true)
  })

  it('draws every system with its own icon from @lb/icons', () => {
    const icons = systems.map(system => system.icon)
    expect(new Set(icons).size).toBe(icons.length)
    expect(icons.every(icon => (iconNames as readonly string[]).includes(icon))).toBe(true)
  })

  it('uses only known techniques', () => {
    const used = new Set(systems.flatMap(system => system.techniques))
    expect([...used].every(technique => (TECHNIQUES as readonly string[]).includes(technique))).toBe(true)
  })

  it('follows the playbook build order: Phase 1 is LB-01, LB-05 and LB-08', () => {
    expect(systems.filter(system => system.phase === 1).map(system => system.part)).toEqual(['LB-01', 'LB-05', 'LB-08'])
  })

  it('states model calls per run for every system (CLAUDE.md: budgets are design inputs)', () => {
    expect(systems.every(system => system.limits.some(limit => limit.label.startsWith('Model calls per')))).toBe(true)
  })
})

describe('the Czech datasheets', () => {
  const czech = systemsIn('cs')

  it.each(czech.map(system => [system.part, system]))('%s matches the datasheet schema', (_, system) => {
    expect(() => SystemSchema.parse(system)).not.toThrow()
  })

  it.each(systems.map((system, i) => [system.part, system, czech[i]!]))('%s has as many steps, highlights, limits and tags as the English', (_, english, translated) => {
    expect(translated.chain).toHaveLength(english.chain.length)
    expect(translated.highlights).toHaveLength(english.highlights.length)
    expect(translated.limits).toHaveLength(english.limits.length)
    expect(translated.tags).toHaveLength(english.tags.length)
    expect(translated.stack).toHaveLength(english.stack.length)
  })

  it('keeps every language-neutral field from the English records', () => {
    for (const [i, english] of systems.entries()) {
      const { part, slug, icon, backend, runtime, techniques, phase, size } = czech[i]!
      expect({ part, slug, icon, backend, runtime, techniques, phase, size })
        .toEqual({ part: english.part, slug: english.slug, icon: english.icon, backend: english.backend, runtime: english.runtime, techniques: english.techniques, phase: english.phase, size: english.size })
    }
  })

  it('is actually translated: no prose field is left in English', () => {
    for (const [i, english] of systems.entries()) {
      const translated = czech[i]!
      for (const field of ['function', 'visitorAction', 'problem', 'tryIt', 'proves'] as const) {
        expect(translated[field], `${english.part} ${field}`).not.toBe(english[field])
      }
      expect(translated.highlights.some((line, j) => line === english.highlights[j])).toBe(false)
    }
  })

  it('states model calls per run for every system, as the English does', () => {
    expect(czech.every(system => system.limits.some(limit => limit.label.startsWith('Volání modelu')))).toBe(true)
  })

  it('never leaves a single-letter word at the end of a line', () => {
    const text = JSON.stringify(czech)
    expect(text).not.toMatch(/(?:^|[\s(„])[aikosuvz] /i)
  })
})

describe('finding a datasheet', () => {
  it('finds a system by slug in any case and language, and nothing for an unknown part', () => {
    expect(findSystemIn('LB-05', 'en')?.name).toBe('Data Analyst')
    expect(findSystemIn('lb-05', 'cs')?.name).toBe('Datový analytik')
    expect(findSystemIn('lb-99', 'cs')).toBeUndefined()
  })

  it('offers English and Czech, English first', () => {
    expect(LOCALES).toEqual(['en', 'cs'])
  })
})
