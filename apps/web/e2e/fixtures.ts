// The shared Playwright fixture: every end-to-end test fails if the page breaks the
// security policy, throws, or logs an error, not just when its own assertions fail.
import { test as base, expect } from '@playwright/test'

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
        window.__cspViolations.push(`${event.violatedDirective} blocked ${event.blockedURI || event.sample}`)
      })
    })
    page.on('pageerror', error => problems.errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const expected404 = message.text().includes('status of 404') && notFoundDocuments.has(message.location().url)
      if (!expected404) problems.errors.push(message.text())
    })
    await use(problems)
    if (!page.isClosed() && page.url().startsWith('http')) {
      problems.violations.push(...await page.evaluate(() => window.__cspViolations ?? []))
    }
    expect(problems.violations, 'CSP or Trusted Types violations').toEqual([])
    expect(problems.errors, 'page errors').toEqual([])
  }, { auto: true }],
})

export { expect }
