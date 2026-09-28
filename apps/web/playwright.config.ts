import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 3100)

// End-to-end tests run against the production build (`pnpm build` first), so they
// check the real security headers and the real bundles.
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
  webServer: {
    command: 'node .output/server/index.mjs',
    url: `http://127.0.0.1:${port}`,
    env: { PORT: String(port), HOST: '127.0.0.1' },
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
