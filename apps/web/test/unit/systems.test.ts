import { iconNames } from '@lb/icons'
import { describe, expect, it } from 'vitest'

import { TECHNIQUES } from '#shared/catalog'
import { findSystem, systems } from '#shared/data/systems'
import { SystemSchema } from '#shared/schema/system'

describe('systems data', () => {
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

  it('labels every technique a system uses', () => {
    const used = new Set(systems.flatMap(system => system.techniques))
    expect([...used].every(technique => technique in TECHNIQUES)).toBe(true)
  })

  it('follows the playbook build order: Phase 1 is LB-01, LB-05 and LB-08', () => {
    expect(systems.filter(system => system.phase === 1).map(system => system.part)).toEqual(['LB-01', 'LB-05', 'LB-08'])
  })

  it('states model calls per run for every system (CLAUDE.md: budgets are design inputs)', () => {
    expect(systems.every(system => system.limits.some(limit => limit.label.startsWith('Model calls per')))).toBe(true)
  })

  it('finds a system by slug in any case, and nothing for an unknown part', () => {
    expect(findSystem('LB-05')?.name).toBe('Data Analyst')
    expect(findSystem('lb-99')).toBeUndefined()
  })
})
