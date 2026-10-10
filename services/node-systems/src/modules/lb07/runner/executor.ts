// Turning one step of the closed vocabulary into one Playwright call, under a timeout, and saying what
// became of it as a stable code. There is no selector and no script anywhere in a step: a click names a
// role and an accessible name (strict: one element, or the step is ambiguous), a fill names a label, an
// expectation names a text or a count. A step that would leave the shop (a `goto` to another origin, a
// link whose `href` points outside) is refused before the browser is asked, and recorded. An
// expectation that does not hold is a finding, not a failure of the plan: it is what the run is for.
import type { Lb07Step } from '@lb/contracts'
import type { Page } from 'playwright-core'

import type { FindingCollector } from './findings.ts'
import { decideShopPath, decideUrl, shopPathOf, STEP_TIMEOUT_MS } from './guard.ts'
import type { StepOutcome } from './protocol.ts'
import { plainDetail } from './snapshot.ts'

/** What one step came to. */
export interface StepResult {
  outcome: StepOutcome
  durationMs: number
}

/** Tells a Playwright error's kind by its message, since the library throws one class for most of them. */
function classify(error: unknown, found: number | undefined): StepOutcome {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('strict mode violation')) return 'ambiguous'
  if (message.includes('Timeout') || message.includes('timeout')) return found === 0 ? 'not_found' : 'timeout'
  return 'error'
}

/** Waits for the page to settle after an action, without failing the step when it does not. */
async function settle(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.waitForLoadState('load', { timeout: timeoutMs })
  }
  catch {
    // A page that keeps loading is not a failed step: the next step's own wait will say so if it matters.
  }
}

/** Finds the lines of the page's text that share a word with what was expected, so an expectation's detail can say what the page says instead. */
async function nearestLines(page: Page, expected: string): Promise<string> {
  const text = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '')
  if (text === '') return ''
  const words = expected.split(/\s+/).filter(word => word.length >= 3)
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  const near = lines.filter(line => words.some(word => line.includes(word))).slice(0, 3)
  return near.join(' | ')
}

/** Runs the `goto` step: a path of the shop, or a refusal. */
async function goTo(page: Page, path: string, shopOrigin: string, findings: FindingCollector): Promise<StepOutcome> {
  const decision = decideShopPath(path, shopOrigin)
  if (!decision.allowed) {
    findings.blockedNavigation(decision.target, 'goto')
    return 'blocked'
  }
  await page.goto(decision.url.href, { timeout: STEP_TIMEOUT_MS, waitUntil: 'load' })
  return 'ok'
}

/** Runs a `click` step: the one element with the role and name; a link is checked for where it leads first. */
async function click(page: Page, step: Extract<Lb07Step, { action: 'click' }>, shopOrigin: string, findings: FindingCollector): Promise<StepOutcome> {
  const locator = page.getByRole(step.role, { name: step.name, exact: true })
  const count = await locator.count()
  if (count === 0) {
    // A moment for a page that is still rendering, then the same question once more.
    try {
      await locator.waitFor({ state: 'attached', timeout: Math.min(3_000, STEP_TIMEOUT_MS) })
    }
    catch {
      return 'not_found'
    }
  }
  if (await locator.count() > 1) return 'ambiguous'
  if (step.role === 'link') {
    const href = await locator.getAttribute('href', { timeout: STEP_TIMEOUT_MS })
    if (href !== null) {
      const decision = decideUrl(href, page.url(), shopOrigin)
      if (!decision.allowed) {
        findings.blockedNavigation(decision.target, 'link')
        return 'blocked'
      }
    }
  }
  await locator.click({ timeout: STEP_TIMEOUT_MS })
  await settle(page, STEP_TIMEOUT_MS)
  return 'ok'
}

/** Runs a `fill` step: the one field with the label. */
async function fill(page: Page, step: Extract<Lb07Step, { action: 'fill' }>): Promise<StepOutcome> {
  const locator = page.getByLabel(step.label, { exact: true })
  if (await locator.count() === 0) return 'not_found'
  if (await locator.count() > 1) return 'ambiguous'
  await locator.fill(step.value, { timeout: STEP_TIMEOUT_MS })
  return 'ok'
}

/** Runs a `select` step: the select with the label, and the option by its visible text. */
async function select(page: Page, step: Extract<Lb07Step, { action: 'select' }>): Promise<StepOutcome> {
  const locator = page.getByLabel(step.label, { exact: true })
  if (await locator.count() === 0) return 'not_found'
  if (await locator.count() > 1) return 'ambiguous'
  await locator.selectOption({ label: step.option }, { timeout: STEP_TIMEOUT_MS })
  return 'ok'
}

/** Runs an `expectText` step: the page shows the text within a short wait, or a finding says what it shows instead. */
async function expectText(page: Page, step: Extract<Lb07Step, { action: 'expectText' }>, shopOrigin: string, findings: FindingCollector): Promise<StepOutcome> {
  const locator = page.getByText(step.text, { exact: false })
  try {
    await locator.first().waitFor({ state: 'attached', timeout: Math.min(4_000, STEP_TIMEOUT_MS) })
    return 'ok'
  }
  catch {
    const says = await nearestLines(page, step.text)
    findings.add({ kind: 'expectation_failed', title: 'The page does not say what was expected', detail: plainDetail(`expected "${step.text}"; the page says ${says ? `"${says}"` : 'nothing like it'}`), rule: null, path: shopPathOf(page.url(), shopOrigin) })
    return 'expectation'
  }
}

/** Runs an `expectCount` step: that many elements of the role (and name), or a finding with the count the page has. */
async function expectCount(page: Page, step: Extract<Lb07Step, { action: 'expectCount' }>, shopOrigin: string, findings: FindingCollector): Promise<StepOutcome> {
  const locator = step.name === undefined ? page.getByRole(step.role) : page.getByRole(step.role, { name: step.name, exact: true })
  await settle(page, 2_000)
  const count = await locator.count()
  if (count === step.count) return 'ok'
  const what = step.name === undefined ? `${step.role}s` : `${step.role}s named "${step.name}"`
  findings.add({ kind: 'expectation_failed', title: 'The page does not have what was expected', detail: plainDetail(`expected ${step.count} ${what}; the page has ${count}`), rule: null, path: shopPathOf(page.url(), shopOrigin) })
  return 'expectation'
}

/** Performs one step by its action. */
function perform(page: Page, step: Lb07Step, shopOrigin: string, findings: FindingCollector): Promise<StepOutcome> {
  switch (step.action) {
    case 'goto': return goTo(page, step.path, shopOrigin, findings)
    case 'click': return click(page, step, shopOrigin, findings)
    case 'fill': return fill(page, step)
    case 'select': return select(page, step)
    case 'expectText': return expectText(page, step, shopOrigin, findings)
    case 'expectCount': return expectCount(page, step, shopOrigin, findings)
  }
}

/** Runs one step and says what became of it. Never throws: an error of the browser is the outcome `error`. */
export async function runStep(page: Page, step: Lb07Step, shopOrigin: string, findings: FindingCollector): Promise<StepResult> {
  const startedAt = Date.now()
  let outcome: StepOutcome
  try {
    outcome = await perform(page, step, shopOrigin, findings)
  }
  catch (error) {
    let found: number | undefined
    if (step.action === 'click') found = await page.getByRole(step.role, { name: step.name, exact: true }).count().catch(() => undefined)
    outcome = classify(error, found)
  }
  return { outcome, durationMs: Date.now() - startedAt }
}
