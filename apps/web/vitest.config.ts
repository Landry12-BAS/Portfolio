// Vitest setup for the site's unit tests.
import { fileURLToPath } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

/** Resolves a path relative to this app. */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// Unit tests cover plain modules, locale files and Pinia stores, so they run without a
// Nuxt runtime; the aliases match Nuxt's.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '#shared': here('./shared'),
      '~': here('./app'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
  },
})
