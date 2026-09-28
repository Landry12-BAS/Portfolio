// The portfolio site: the design system layer, Pinia, the two languages and the
// security headers from docs/SECURITY.md, section 3.
export default defineNuxtConfig({
  extends: ['@lb/ui'],
  modules: ['@pinia/nuxt', '@nuxtjs/i18n', 'nuxt-security'],
  devtools: { enabled: false },
  app: {
    head: {
      // The page language and the description come from app.vue, per language.
      titleTemplate: '%s · Landry Bodjona',
      meta: [
        { name: 'theme-color', content: '#eceff2', media: '(prefers-color-scheme: light)' },
        { name: 'theme-color', content: '#08090b', media: '(prefers-color-scheme: dark)' },
      ],
    },
  },
  compatibilityDate: '2026-09-28',
  i18n: {
    // English at /, Czech at /cs (docs/STACK.md, decision D6). `language` feeds the
    // <html lang> attribute and the hreflang links.
    locales: [
      { code: 'en', language: 'en', name: 'English', file: 'en.ts' },
      { code: 'cs', language: 'cs', name: 'Čeština', file: 'cs.ts' },
    ],
    defaultLocale: 'en',
    strategy: 'prefix_except_default',
    // No redirect by browser language: it needs a cookie, and the site sets none
    // (docs/SECURITY.md). The visitor picks a language with the switcher's links.
    detectBrowserLanguage: false,
    // hreflang links must be absolute. Production sets NUXT_PUBLIC_I18N_BASE_URL to the
    // site's domain; local runs use this default.
    baseUrl: 'http://localhost:3000',
    compilation: {
      // Messages are plain text: a locale file that contains HTML fails the build.
      strictMessage: true,
    },
  },
  security: {
    // A fresh nonce on every response: pages render on the server per request.
    nonce: true,
    sri: true,
    // Rate limits live at the edge (Cloudflare) and in the gateway, where they see
    // every instance; an in-memory limiter per serverless instance would not.
    rateLimiter: false,
    // Pages are same-origin only; no cross-origin reads, so no CORS headers at all.
    corsHandler: false,
    headers: {
      contentSecurityPolicy: {
        'default-src': ['\'self\''],
        'base-uri': ['\'none\''],
        'connect-src': ['\'self\''],
        'font-src': ['\'self\''],
        'form-action': ['\'self\''],
        'frame-ancestors': ['\'none\''],
        'img-src': ['\'self\'', 'data:'],
        'object-src': ['\'none\''],
        'script-src': ['\'self\'', '\'strict-dynamic\'', '\'nonce-{{nonce}}\''],
        'script-src-attr': ['\'none\''],
        // Styles cannot run code; inline styles stay allowed so Vue style bindings work.
        'style-src': ['\'self\'', '\'unsafe-inline\''],
        'upgrade-insecure-requests': true,
        'require-trusted-types-for': '\'script\'',
        // Vue's own policy, used for its compiled static markup. v-html is banned by lint.
        'trusted-types': ['vue'],
      },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: 'same-origin',
      crossOriginResourcePolicy: 'same-origin',
      referrerPolicy: 'strict-origin-when-cross-origin',
      strictTransportSecurity: { maxAge: 63072000, includeSubdomains: true, preload: true },
      xContentTypeOptions: 'nosniff',
      xFrameOptions: 'DENY',
      permissionsPolicy: {
        'camera': [],
        'display-capture': [],
        'fullscreen': [],
        'geolocation': [],
        'microphone': [],
        'payment': [],
        'usb': [],
      },
    },
  },
})
