// Vitest setup for the Node systems: fast unit tests, and integration tests against a real
// Postgres and Redis. Where Docker isn't available, LB_TEST_DATABASE_URL and
// LB_TEST_REDIS_URL point at local servers instead.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
    ],
  },
})
