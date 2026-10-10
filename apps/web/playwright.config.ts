// Playwright setup for the site's end-to-end tests. They run against the test build of the site
// (`pnpm --filter @lb/web build:e2e` first), which is the production build plus a stand-in for
// Cloudflare's Turnstile and the mock recordings, so they check the real security headers and bundles.
import { defineConfig, devices } from '@playwright/test'

// The port the production server listens on during the tests.
const port = Number(process.env.E2E_PORT ?? 3100)

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // A failing journey is a bug to fix, not a flake to retry.
  retries: 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Machines with a preinstalled Chromium point at it; CI installs Playwright's own.
        launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
      },
    },
  ],
  // The test build of the site and the mock back end it talks to, started together with throwaway
  // keys (e2e/support/serve.ts). Nothing needs a network, a model or Cloudflare.
  webServer: {
    command: 'node e2e/support/serve.ts',
    url: `http://127.0.0.1:${port}`,
    env: { E2E_PORT: String(port) },
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
