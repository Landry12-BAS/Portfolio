// Builds the site's services inside Nitro, once: the settings from Nuxt's runtime config (the
// NUXT_* variables), the real clock and network, and the recordings that were bundled with the
// site. Only the running site imports this file; the tests make their own services
// (test/support/site-app.ts), which is why it is the one place that reaches for Nitro's own
// functions. The plugin that checks the settings at startup and the middleware that attaches
// the services to each request both come here, so the settings are read and checked once.
import { randomBytes } from 'node:crypto'

import { useRuntimeConfig, useStorage } from 'nitropack/runtime'

import { loadSiteState } from './config.ts'
import type { RawRuntimeConfig } from './config.ts'
import { SYSTEM_POLICIES } from './policy.ts'
import type { RecordingStore, SiteServices } from './services.ts'
import { TraceCache } from './trace-cache.ts'

// Where the build puts the recordings (nitro.serverAssets in nuxt.config.ts), by system folder: `lb-01/torn-bag.json`.
const RECORDINGS_STORAGE = 'assets:recordings'

/** Reads the recordings the build bundled. A recording is a file `<system>/<sample>.json`. */
function bundledRecordings(): RecordingStore {
  const storage = useStorage(RECORDINGS_STORAGE)
  return {
    list: async (system) => {
      const keys = await storage.getKeys(system)
      return keys.filter(key => key.endsWith('.json')).map(key => key.slice(key.lastIndexOf(':') + 1, -'.json'.length))
    },
    read: async (system, sample) => {
      const stored: unknown = await storage.getItem(`${system}:${sample}.json`)
      if (typeof stored !== 'string') return stored ?? undefined
      try {
        return JSON.parse(stored) as unknown
      }
      catch {
        return undefined
      }
    },
  }
}

let services: SiteServices | undefined

/** Returns the site's services, building them (and checking the settings) the first time. Throws a ConfigError when the settings are wrong. */
export function nitroServices(): SiteServices {
  services ??= {
    state: loadSiteState(useRuntimeConfig() as RawRuntimeConfig, __LB_TEST_BUILD__, Date.now),
    fetch: globalThis.fetch,
    now: Date.now,
    random: bytes => randomBytes(bytes),
    policies: SYSTEM_POLICIES,
    recordings: bundledRecordings(),
    traces: new TraceCache(Date.now),
  }
  return services
}
