// Vitest setup for the Node systems: fast unit tests, and integration tests against a real
// Postgres and Redis (Testcontainers, or LB_TEST_DATABASE_URL and LB_TEST_REDIS_URL where
// Docker isn't available).
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
    ],
  },
})
