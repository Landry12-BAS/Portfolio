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
        // Real Redis from Testcontainers (Docker), or from LB_TEST_REDIS_URL where Docker
        // isn't available. Fake providers run as local HTTP servers.
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
