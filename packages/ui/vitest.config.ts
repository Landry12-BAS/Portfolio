import { fileURLToPath } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '#brand': fileURLToPath(new URL('../../brand', import.meta.url)) },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
})
