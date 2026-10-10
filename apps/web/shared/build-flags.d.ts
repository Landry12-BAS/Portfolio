// Build-time flags. The build replaces each one with a literal (nuxt.config.ts), so code behind a
// flag that is false is not in the bundle at all.

/**
 * True only in the end-to-end test build (`LB_TEST_BUILD=1`, `pnpm --filter @lb/web build:e2e`),
 * which accepts a fixed stand-in for a Turnstile token so the journeys can pass the gate with no
 * Cloudflare. It is false in every other build, and `scripts/check-production-build.ts` proves
 * that the production bundle holds no trace of the stand-in.
 */
declare const __LB_TEST_BUILD__: boolean
