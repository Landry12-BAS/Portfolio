// Tests for the build's own configuration (nuxt.config.ts), read the way a build reads it, with the
// environment a build would have. The end-to-end test build is the only one that accepts the Turnstile
// stand-in and bundles the mock recordings; this proves that a production build never turns it on, and
// that a build made where VERCEL is set (the production site's host) refuses to be one.
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { TEST_BUILD_ON_VERCEL } from '../../shared/build-mode.ts'

// The file under test. It is imported by a path held in a variable so that the type check does not follow it:
// the file uses `defineNuxtConfig`, which Nuxt provides as a global and these tests stand in for.
const CONFIG_FILE = fileURLToPath(new URL('../../nuxt.config.ts', import.meta.url))

/** The few parts of the configuration these tests read. */
interface ConfigParts {
  nitro: { replace: Record<string, string>, serverAssets: { dir: string }[] }
  vite: { define: Record<string, string> }
  $production: { nitro: { output?: { dir: string } } }
}

/** Reads nuxt.config.ts afresh, with exactly these environment variables set, as a build would. */
async function readConfig(environment: Record<string, string | undefined>): Promise<ConfigParts> {
  vi.resetModules()
  vi.stubGlobal('defineNuxtConfig', (config: unknown) => config)
  vi.stubEnv('LB_TEST_BUILD', undefined)
  vi.stubEnv('VERCEL', undefined)
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value)
  const module = await import(CONFIG_FILE) as { default: ConfigParts }
  return module.default
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('the production build', () => {
  it('turns the test build\'s flag off, writes to the usual folder and bundles the real recordings', async () => {
    const config = await readConfig({})

    expect(config.nitro.replace.__LB_TEST_BUILD__).toBe('false')
    expect(config.vite.define.__LB_TEST_BUILD__).toBe('false')
    expect(config.$production.nitro.output).toBeUndefined()
    expect(config.nitro.serverAssets[0]?.dir).toMatch(/[\\/]recordings$/)
    expect(config.nitro.serverAssets[0]?.dir).not.toContain('fixtures')
  })

  it('stays a production build on Vercel, and when LB_TEST_BUILD is anything but 1', async () => {
    for (const environment of [{ VERCEL: '1' }, { LB_TEST_BUILD: '0' }, { LB_TEST_BUILD: 'true', VERCEL: '1' }]) {
      const config = await readConfig(environment)

      expect(config.nitro.replace.__LB_TEST_BUILD__).toBe('false')
    }
  })
})

describe('the test build', () => {
  it('turns the flag on, goes to a folder of its own and bundles the mock recordings', async () => {
    const config = await readConfig({ LB_TEST_BUILD: '1' })

    expect(config.nitro.replace.__LB_TEST_BUILD__).toBe('true')
    expect(config.vite.define.__LB_TEST_BUILD__).toBe('true')
    expect(config.$production.nitro.output?.dir).toMatch(/[\\/]\.output-e2e$/)
    expect(config.nitro.serverAssets[0]?.dir).toContain('fixtures')
  })

  it('is refused where VERCEL is set: the build stops before it can compile the stand-in into the production site', async () => {
    await expect(readConfig({ LB_TEST_BUILD: '1', VERCEL: '1' })).rejects.toThrow(TEST_BUILD_ON_VERCEL)
  })
})
