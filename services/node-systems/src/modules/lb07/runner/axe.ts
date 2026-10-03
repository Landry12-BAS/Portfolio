// Accessibility findings from axe-core, run inside the page the agent drove. axe is the sandbox's
// own code, read once from the installed package and injected into the page; nothing a model wrote
// is ever run. Each violation becomes one finding per rule and page, with the rule's id, its impact,
// how many elements it names and the first element's selector, made plain and bounded.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

import type { Page } from 'playwright-core'

import type { RunnerFinding } from './protocol.ts'
import { plainDetail } from './snapshot.ts'

/** What axe says of one violation, as this module reads it. */
interface AxeViolation {
  id: string
  impact?: string | null
  help?: string
  nodes?: { target?: unknown[] }[]
}

/** The result of `axe.run`, as this module reads it. */
interface AxeResult {
  violations?: AxeViolation[]
}

let source: string | undefined

/** The axe-core source, read once from the installed package. */
export function axeSource(): string {
  source ??= readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
  return source
}

// The WCAG 2.2 AA tags the site's own accessibility tests use.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

/** Runs axe in the page and returns one finding per violated rule. Throws when axe cannot run, which the caller records as a step error. */
export async function runAxe(page: Page, path: string): Promise<Omit<RunnerFinding, 'engine' | 'stepIndex'>[]> {
  await page.addScriptTag({ content: axeSource() })
  const result = await page.evaluate(async (tags: string[]) => {
    // This function runs inside the page, where `globalThis` is the window with axe on it.
    const scope = globalThis as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<unknown> }, document: unknown }
    return scope.axe.run(scope.document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] })
  }, TAGS) as AxeResult
  return (result.violations ?? []).slice(0, 40).map((violation) => {
    const nodes = violation.nodes ?? []
    const first = nodes[0]?.target?.map(String).join(' ') ?? ''
    const rule = /^[a-z0-9-]{1,60}$/.test(violation.id) ? violation.id : 'unknown-rule'
    return {
      kind: 'accessibility' as const,
      title: `Accessibility: ${rule} (${violation.impact ?? 'unknown'} impact)`,
      detail: plainDetail(`${violation.help ?? rule}. ${nodes.length} element${nodes.length === 1 ? '' : 's'} on ${path}${first ? `, the first at ${first}` : ''}.`),
      rule,
      path,
    }
  })
}
