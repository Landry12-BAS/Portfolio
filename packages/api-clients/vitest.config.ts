// Vitest setup for @lb/api-clients: unit tests of the route table and the clients, and the mock
// back end's own tests, which prove it answers what the OpenAPI documents say. No services needed.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
