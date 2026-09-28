// The portfolio site. Security headers follow docs/SECURITY.md, section 3.
export default defineNuxtConfig({
  extends: ['@lb/ui'],
  modules: ['@pinia/nuxt', 'nuxt-security'],
  devtools: { enabled: false },
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      titleTemplate: '%s · Landry Bodjona',
      meta: [
        { name: 'description', content: 'Ten live AI systems, built for one fictional coffee company and open to every visitor, with a trace of every step they take.' },
        { name: 'theme-color', content: '#eceff2', media: '(prefers-color-scheme: light)' },
        { name: 'theme-color', content: '#08090b', media: '(prefers-color-scheme: dark)' },
      ],
    },
  },
  compatibilityDate: '2026-09-28',
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
