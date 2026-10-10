// Tests of how Turborepo caches the site's build. Vercel finds turbo.json and runs the site's build through
// Turbo, with its remote cache; CI and `just` build the site with pnpm and never see the cache. When the
// build task was the icons' (inputs svg/** and scripts/**, outputs sprite.svg), a cache hit replayed the
// site's build log, restored no output, and Vercel failed with "No Output Directory named dist"; and a change
// to the site's own code kept the same cache key. These tests keep the site's build out of that trap.
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

/** The part of one task's definition in turbo.json that decides what is cached and when it is reused. */
const taskSchema = z.object({
  cache: z.boolean().optional(),
  inputs: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
})

/** turbo.json, as far as these tests read it. */
const turboSchema = z.object({ tasks: z.record(z.string(), taskSchema) })

/** The task definitions in the repository's turbo.json. */
function turboTasks(): Record<string, z.infer<typeof taskSchema>> {
  const text = readFileSync(new URL('../../../../turbo.json', import.meta.url), 'utf8')
  return turboSchema.parse(JSON.parse(text)).tasks
}

/** The definition Turbo uses for the site's build: its own entry if it has one, else the shared one. */
function siteBuild(): z.infer<typeof taskSchema> {
  const tasks = turboTasks()
  const definition = tasks['@lb/web#build'] ?? tasks.build
  if (definition === undefined) throw new Error('turbo.json defines no build task for the site.')
  return definition
}

describe('the site\'s build in Turbo\'s cache', () => {
  it('is never replayed without the output Vercel deploys', () => {
    const build = siteBuild()

    if (build.cache !== false) {
      expect(build.outputs).toEqual(expect.arrayContaining(['.vercel/output/**', '.output/**']))
    }
  })

  it('is rebuilt when any of the site\'s own files changes', () => {
    const build = siteBuild()

    if (build.cache !== false) {
      // No inputs means every file of the package; a narrowed list must still start from that default.
      expect(build.inputs === undefined || build.inputs.includes('$TURBO_DEFAULT$')).toBe(true)
    }
  })

  it('keeps the icons\' narrowed cache key to the icons package', () => {
    const tasks = turboTasks()

    expect(tasks['@lb/icons#build']?.inputs).toEqual(['svg/**', 'scripts/**'])
    expect(siteBuild().inputs ?? []).not.toContain('svg/**')
  })
})
