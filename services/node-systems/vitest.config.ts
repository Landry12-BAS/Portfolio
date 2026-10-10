// Vitest setup for the Node systems: fast unit tests, and integration tests against a real
// Postgres and Redis (Testcontainers, or LB_TEST_DATABASE_URL and LB_TEST_REDIS_URL where
// Docker isn't available), and the browser tests of LB-07's runner, which need a Chromium and run on their own (`pnpm test:browser`).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/support/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          // LB-07's runner on a real Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE, or Playwright's own install): `pnpm test:browser`.
          name: 'browser',
          include: ['test/browser/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
})
