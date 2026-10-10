// The shared Playwright fixture: every end-to-end test fails if the page breaks the
// security policy, throws, or logs an error, not just when its own assertions fail.
import { test as base, expect } from '@playwright/test'
import type { Locator } from '@playwright/test'

/** What went wrong on a page while a test ran. */
interface PageProblems {
  violations: string[]
  errors: string[]
}

declare global {
  /** The page's window, plus the CSP violations the fixture collects. */
  interface Window {
    __cspViolations: string[]
  }
}

// Every test fails if the page reports a CSP or Trusted Types violation, throws, or
// logs an error. The listener is installed by Playwright itself, outside the page's CSP.
export const test = base.extend<{ problems: PageProblems }>({
  problems: [async ({ page }, use) => {
    const problems: PageProblems = { violations: [], errors: [] }
    // A page that answers 404 on purpose makes the browser log its own document load
    // as an error; that one message is expected, anything else is not.
    const notFoundDocuments = new Set<string>()
    page.on('response', (response) => {
      if (response.request().isNavigationRequest() && response.status() === 404) notFoundDocuments.add(response.url())
    })
    await page.addInitScript(() => {
      window.__cspViolations = []
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__cspViolations.push(`${event.violatedDirective} blocked ${event.blockedURI} ${event.sample}`.trim())
      })
    })
    page.on('pageerror', error => problems.errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const notFound = message.text().includes('status of 404')
      const expected404 = notFound && notFoundDocuments.has(message.location().url)
      // A run's trace does not exist for the first moments of the run, and the Scope reads it until it does:
      // that 404 is how the trace route says "not yet", and the browser logs every one.
      const traceNotYet = notFound && /\/api\/runs\/[\w-]+\/spans/.test(message.location().url)
      if (!expected404 && !traceNotYet) problems.errors.push(message.text())
    })
    await use(problems)
    if (!page.isClosed() && page.url().startsWith('http')) {
      problems.violations.push(...await page.evaluate(() => window.__cspViolations ?? []))
    }
    expect(problems.violations, 'CSP or Trusted Types violations').toEqual([])
    expect(problems.errors, 'page errors').toEqual([])
  }, { auto: true }],
})

/**
 * Presses a toggle button until the page reports it pressed (`aria-pressed="true"`).
 *
 * The server renders the page before Vue hydrates it, and a click that lands in between finds
 * a button with no handler yet and is lost; on a busy CI runner that gap is long enough to
 * catch a test that clicks right after `goto`. Use it only on a button that sets a value
 * rather than flipping one, such as a catalog filter, so that pressing it again is harmless.
 */
export async function pressUntilPressed(button: Locator): Promise<void> {
  await expect(async () => {
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true', { timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
}

export { expect }
