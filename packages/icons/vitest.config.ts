// Vitest setup for @lb/icons: component tests in a DOM (happy-dom), with Vue's compiler.
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
})
