// Vitest setup for @lb/common: fast unit tests, and contract tests that run the real
// gateway (services/gateway) on fake providers, against a real Redis from Testcontainers
// or from LB_TEST_REDIS_URL where Docker isn't available.
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
          globalSetup: ['test/support/redis-setup.ts'],
          testTimeout: 20_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
})
