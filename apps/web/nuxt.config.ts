// The portfolio site: the design system layer, Pinia, the two languages, the security headers
// from docs/SECURITY.md (section 3), and the server that stands between a visitor's browser and
// the back ends (section 2): the session, Turnstile, the proxy and the Scope's route.
import { fileURLToPath } from 'node:url'

import { isTestBuild } from './shared/build-mode.ts'
import { SERVER_ROUTES } from './server/api-routes'

/** Resolves a path inside this app. */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// The end-to-end test build (`pnpm --filter @lb/web build:e2e`) is the only build that accepts the
// fixed stand-in for a Turnstile token and bundles the test recordings. Every other build replaces
// this flag with `false` (see shared/build-flags.d.ts), so none of that code is in its bundle. A build
// where VERCEL is set, which is the production site's, refuses to be the test build (shared/build-mode.ts):
// CI cannot see a build made there, so the build itself must stop.
const testBuild = isTestBuild(process.env)

// What a board page adds to the site's Content Security Policy: the Turnstile widget's frame and
// the one Trusted Types policy that makes its script's address.
const BOARD_POLICY = {
  'frame-src': ['https://challenges.cloudflare.com'],
  'trusted-types': ['vue', 'lb-turnstile'],
}

export default defineNuxtConfig({
  extends: ['@lb/ui'],
  modules: ['@pinia/nuxt', '@nuxtjs/i18n', 'nuxt-security'],
  // The test build goes to a folder of its own, so building it never overwrites the production build.
  // Only a build does: the dev server also runs as a test build (`just dev-mock`), and Nitro empties the
  // output folder it is given when it starts, which would wipe a test build made earlier.
  $production: {
    nitro: { output: testBuild ? { dir: here('./.output-e2e') } : undefined },
  },
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
  // The settings of the server that talks to the back ends. Each one is read from the environment
  // variable of the same name with NUXT_ in front (docs/DEPLOY.md, part 10), checked at startup
  // (server/lib/config.ts), and none of them but the Turnstile site key ever reaches the browser.
  runtimeConfig: {
    // The origin of the Django, Flask and Node systems' API: NUXT_LB_API_URL.
    lbApiUrl: '',
    // The origin that serves the gateway's one public route: NUXT_LB_GATEWAY_URL.
    lbGatewayUrl: '',
    // The private key of the `site` pair, which signs visitor tokens: NUXT_LB_WEB_SIGNING_KEY.
    lbWebSigningKey: '',
    // The private key of the `web` service pair, for the gateway: NUXT_LB_GATEWAY_SERVICE_KEY.
    lbGatewayServiceKey: '',
    // The secret the visitors' sessions are made from: NUXT_LB_SESSION_SECRET.
    lbSessionSecret: '',
    // Turnstile's secret key: NUXT_TURNSTILE_SECRET_KEY.
    turnstileSecretKey: '',
    public: {
      // Turnstile's site key, which the browser's widget needs: NUXT_PUBLIC_TURNSTILE_SITE_KEY.
      turnstileSiteKey: '',
    },
  },
  routeRules: {
    // The API reads its own request bodies, each within the limit of its route, and answers every
    // failure in the platform's error shape. nuxt-security's XSS filter would read the body first
    // (leaving nothing for the route to read) and refuse a ticket that quotes a tag, which a
    // demo that invites visitors to try to break it must hand to the system, and its size check
    // answers in another shape. Pages keep both.
    '/api/**': { security: { xssValidator: false, requestSizeLimiter: false } },
    // The evaluation boards, and only they, may run Cloudflare's Turnstile widget before a visitor's
    // first live run: it draws in an iframe from its own origin, and its script's address is made
    // by one Trusted Types policy, named here (app/board-kit/turnstile.ts). Nothing else on the
    // policy changes: the script is trusted by the nonce of the page's own code (strict-dynamic).
    '/systems/*/board': { security: { headers: { contentSecurityPolicy: BOARD_POLICY } } },
    '/cs/systems/*/board': { security: { headers: { contentSecurityPolicy: BOARD_POLICY } } },
  },
  compatibilityDate: '2026-09-28',
  nitro: {
    // Every handler of the site's API, from the one list in server/api-routes.ts.
    handlers: SERVER_ROUTES.map(({ route, method, handler }) => ({ route, method, handler: here(`./server/${handler}`), lazy: true })),
    // The recordings of the curated samples, bundled with the server. The test build bundles the
    // test fixtures instead, so a recording made on the mock can never ship in a production build.
    serverAssets: [{ baseName: 'recordings', dir: here(testBuild ? './e2e/fixtures/recordings' : './recordings') }],
    replace: { __LB_TEST_BUILD__: JSON.stringify(testBuild) },
  },
  vite: {
    define: { __LB_TEST_BUILD__: JSON.stringify(testBuild) },
  },
  hooks: {
    // LB-05's chart is drawn with Vega, whose code is large (about 270 kB gzipped) and is needed only once
    // an answer has a chart to draw. Nuxt would have every visitor of the board page fetch it while idle
    // (a `prefetch` link), so that one chunk is left out of the hints and loads when a chart is first drawn.
    'build:manifest': (manifest) => {
      for (const entry of Object.values(manifest)) {
        if (entry.src?.endsWith('/chart/render.ts')) entry.prefetch = false
      }
    },
  },
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
