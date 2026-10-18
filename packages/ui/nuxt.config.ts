// The LB design system as a Nuxt layer. Apps extend it to get the tokens, the fonts,
// the theme switching and the base components in one line.
import { fileURLToPath } from 'node:url'

/** Resolves a path relative to this layer, wherever the app that extends it lives. */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineNuxtConfig({
  modules: ['@nuxtjs/color-mode'],
  css: [here('./app/assets/css/main.css')],
  colorMode: {
    // Use the cinematic dark design on first visit; a visitor can still select light
    // or the system theme. The choice remains in localStorage, never a cookie.
    preference: 'dark',
    fallback: 'dark',
    classSuffix: '',
    storage: 'localStorage',
    storageKey: 'lb-theme',
  },
  alias: {
    // The mark comes only from the brand files (AGENTS.md, design rules).
    '#brand': here('../../brand'),
  },
  build: {
    // The icon package ships TypeScript and Vue sources, so the server bundle
    // compiles it instead of loading it from node_modules at runtime.
    transpile: ['@lb/icons'],
  },
})
