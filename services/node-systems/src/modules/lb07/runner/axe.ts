// Accessibility findings from axe-core, run inside the page the agent drove. axe is the sandbox's own code, read
// once from the installed package and evaluated in the page through the browser's debugging protocol, which the
// page's own Content-Security-Policy does not govern (a script tag would be refused by the shop's policy, which
// the sandbox no longer bypasses); nothing a model wrote is ever run. axe runs beside the page's own scripts, so
// what it answers is read as the page's data: checked by a schema, its rule ids and impacts held to closed forms,
// and its words made plain and bounded. Each violation becomes one finding per rule and page, with the rule's id,
// its impact, how many elements it names and the first element's selector.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

import type { Page } from 'playwright-core'
import { z } from 'zod'

import type { RunnerFinding } from './protocol.ts'
import { plainDetail } from './snapshot.ts'

// What this module reads of `axe.run`'s answer: a list of violations (an answer of another shape is refused), each
// read on its own so one that does not fit is left out and the rest are kept; a field of the wrong kind counts as absent.
const axeResultSchema = z.object({ violations: z.array(z.unknown()).max(500).optional() })
const violationSchema = z.object({
  id: z.string().max(200),
  impact: z.string().max(200).optional().catch(undefined),
  help: z.string().max(2_000).optional().catch(undefined),
  nodes: z.array(z.unknown()).max(10_000).catch([]),
})
const nodeSchema = z.object({ target: z.array(z.unknown()).max(50) })

/** The violations of an answer that have the shape axe gives them. */
function violationsOf(result: z.infer<typeof axeResultSchema>): z.infer<typeof violationSchema>[] {
  return (result.violations ?? []).flatMap((entry) => {
    const parsed = violationSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

/** The selector of the first element a violation names, as plain text, or empty. */
function firstTarget(nodes: readonly unknown[]): string {
  const first = nodeSchema.safeParse(nodes[0])
  return first.success ? plainDetail(first.data.target.map(String).join(' '), 200) : ''
}

// axe's own impacts; anything else a page claims is `unknown`.
const IMPACTS: readonly string[] = ['minor', 'moderate', 'serious', 'critical']

let source: string | undefined

/** The axe-core source, read once from the installed package. */
export function axeSource(): string {
  source ??= readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
  return source
}

// The WCAG 2.2 AA tags the site's own accessibility tests use.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

/** Runs axe in the page and returns what it answered, unchecked: the page's scripts could have changed axe. */
async function askAxe(page: Page): Promise<unknown> {
  await page.evaluate(axeSource())
  return page.evaluate(async (tags: string[]) => {
    // This function runs inside the page, where `globalThis` is the window with axe on it.
    const scope = globalThis as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<unknown> }, document: unknown }
    return scope.axe.run(scope.document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] })
  }, TAGS)
}

/** Runs axe in the page and returns one finding per violated rule. Throws when axe cannot run or answers in a shape it does not have, which the caller records as a finding of its own. */
export async function runAxe(page: Page, path: string): Promise<Omit<RunnerFinding, 'engine' | 'stepIndex'>[]> {
  const result = axeResultSchema.parse(await askAxe(page))
  return violationsOf(result).slice(0, 40).map((violation) => {
    const nodes = violation.nodes
    const first = firstTarget(nodes)
    const rule = /^[a-z0-9-]{1,60}$/.test(violation.id) ? violation.id : 'unknown-rule'
    const impact = IMPACTS.includes(violation.impact ?? '') ? violation.impact : 'unknown'
    return {
      kind: 'accessibility' as const,
      title: `Accessibility: ${rule} (${impact} impact)`,
      detail: plainDetail(`${violation.help ?? rule}. ${nodes.length} element${nodes.length === 1 ? '' : 's'} on ${path}${first ? `, the first at ${first}` : ''}.`),
      rule,
      path,
    }
  })
}
