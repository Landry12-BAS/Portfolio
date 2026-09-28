import { fileURLToPath } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// Unit tests cover plain modules and Pinia stores, so they run without a Nuxt runtime.
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
