// Vitest setup for the site's tests, in five projects:
// - unit: plain modules, locale files, Pinia stores and the server's building blocks, in Node;
// - components: Vue components with logic, in a DOM (happy-dom) with real messages;
// - integration: the site's server, handler by handler, over HTTP, against the mock back end;
// - contract: the site's server against the real gateway and a real Redis;
// - production-flag: the few tests that must see the build flag `__LB_TEST_BUILD__` as a
//   production build does, false, so nothing the test build accepts is accepted there.
// None needs a Nuxt runtime, and the aliases match Nuxt's. The flag is true in the other
// projects, as it is in the end-to-end test build.
import { fileURLToPath } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

/** Resolves a path relative to this app. */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '#shared': here('./shared'),
      '~': here('./app'),
      '#brand': here('../../brand'),
    },
  },
  define: { __LB_TEST_BUILD__: 'true' },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', environment: 'node', include: ['test/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'components', environment: 'happy-dom', include: ['test/components/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'integration', environment: 'node', include: ['test/integration/**/*.test.ts'], testTimeout: 20_000, hookTimeout: 60_000 },
      },
      {
        // The site's server against the real gateway on a real Redis (Testcontainers, or LB_TEST_REDIS_URL).
        extends: true,
        test: {
          name: 'contract',
          environment: 'node',
          include: ['test/contract/**/*.test.ts'],
          globalSetup: ['test/support/redis-setup.ts'],
          testTimeout: 20_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        define: { __LB_TEST_BUILD__: 'false' },
        test: { name: 'production-flag', environment: 'node', include: ['test/production/**/*.test.ts'] },
      },
    ],
  },
})
