// What stands in for the model in the mock back end's LB-07: the planner, the re-planner and the writer of
// the bug reports' prose. A curated sample, or a visitor's goal that is word for word a golden case's, is
// planned with the golden set's reference plan and re-planned with its scripted re-plans, which is what a
// correct planner writes. One sample is planned wrong on purpose, the way the golden set's re-plan case is
// (a button named "Add to basket", which the shop does not have), so a sample shows a re-plan. Any other
// goal gets a plan made by rules from the words it uses: the coffees and how many, the coupon, the
// checkout. Every plan is in the closed vocabulary and checked by the same schema as a model's. The bug
// reports are written by templates from the findings code made, in English, as the real model writes
// them. None of this is a model, and the mock says so wherever it matters.
import { describeStep, LB07_LIMITS, lb07PlanSchema } from '../../../contracts/src/index.ts'
import type { Lb07BugReport, Lb07Finding, Lb07Step } from '../../../contracts/src/index.ts'
import { COUPON, formatPrice, PRODUCTS } from '../../../../services/node-systems/src/modules/lb07/shop/catalogue.ts'
import type { Product } from '../../../../services/node-systems/src/modules/lb07/shop/catalogue.ts'
import type { GoldenCase } from '../../../../services/node-systems/src/modules/lb07/golden/cases.ts'

/** What the planner answers: how it read the goal, the first plan, and what it answers to each failed step in turn. */
export interface MockPlan {
  reading: string
  plan: Lb07Step[]
  // The re-plans of a golden case, in order. A goal planned by rules re-plans from the page instead (`replanFromPage`).
  scripted: Lb07Step[][] | undefined
}

/** The sample the mock plans wrong once, the way the golden set's re-plan case does, so one curated sample shows a re-plan. */
export const MOCK_REPLAN_SAMPLE = 'cart-count'
/** The name the wrong first plan gives the add button: the golden set's re-plan case's own. */
const WRONG_BUTTON_NAME = 'Add to basket'

// What the checkout form is filled with when a goal does not say: the golden set's own customer.
const CUSTOMER: readonly (readonly [string, string])[] = [['Full name', 'Ada Lovelace'], ['Email address', 'ada@example.test'], ['Street address', '1 Rue du Café'], ['City', 'Prague']]
// Number words a goal may count bags with.
const NUMBER_WORDS: Readonly<Record<string, number>> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 }
// The most bags of one coffee, and the most coffees, a plan made by rules buys, so it stays within sixteen steps.
const MAX_BAGS = 3
const MAX_COFFEES = 3

/** Says how many items, as the shop prints it. */
function itemsText(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`
}

/** Cuts a sentence to a length, as the schemas bound it. */
function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/** Starts a sentence with a capital and ends it with a full stop. */
function sentence(text: string): string {
  const trimmed = text.trim()
  const capital = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`
  return /[.!?]$/.test(capital) ? capital : `${capital}.`
}

/** Tells whether a goal asks the agent to leave the shop or to stop testing, which no step can do. */
export function asksToLeave(goal: string): boolean {
  return /ignore|instructions|https?:|file:|169\.254|meta-data/i.test(goal)
}

/** The lowercase words of a text. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/** Finds where a run of words starts inside a longer one, or -1. */
function indexOfWords(haystack: readonly string[], needle: readonly string[]): number {
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return start
  }
  return -1
}

/** Reads how many bags a goal asks for just before a coffee's name ("two bags of Ethiopia Guji"), one when it does not say. */
function quantityBefore(words: readonly string[], at: number): number {
  for (let look = at - 1; look >= Math.max(0, at - 4); look -= 1) {
    const word = words[look] ?? ''
    if (/^\d{1,2}$/.test(word)) return Math.min(MAX_BAGS, Math.max(1, Number(word)))
    const named = Object.hasOwn(NUMBER_WORDS, word) ? NUMBER_WORDS[word] : undefined
    if (named !== undefined) return Math.min(MAX_BAGS, named)
  }
  return 1
}

/** The coffees a goal names, in the shop's order, with how many bags of each. */
function coffeesIn(goal: string): { product: Product, quantity: number }[] {
  const words = wordsOf(goal)
  const found: { product: Product, quantity: number }[] = []
  for (const product of PRODUCTS) {
    const at = indexOfWords(words, wordsOf(product.name))
    if (at >= 0) found.push({ product, quantity: quantityBefore(words, at) })
  }
  return found.slice(0, MAX_COFFEES)
}

/** What a correct shop shows as the total of a cart, with the coupon taken off once when the goal names it. */
function expectedTotal(coffees: readonly { product: Product, quantity: number }[], coupon: boolean): string {
  const subtotal = coffees.reduce((sum, item) => sum + item.product.priceCents * item.quantity, 0)
  const discount = coupon ? Math.round(subtotal * COUPON.percentOff / 100) : 0
  return `Total ${formatPrice(subtotal - discount)}`
}

/** The steps that buy the coffees a goal names, then check the count, the coupon, the total and the order, as far as the goal asks. */
function purchaseSteps(goal: string, coffees: readonly { product: Product, quantity: number }[]): Lb07Step[] {
  const steps: Lb07Step[] = []
  for (const { product, quantity } of coffees) {
    for (let bag = 0; bag < quantity; bag += 1) steps.push({ action: 'goto', path: '/' }, { action: 'click', role: 'button', name: `Add ${product.name} to cart` })
  }
  const items = coffees.reduce((sum, item) => sum + item.quantity, 0)
  steps.push({ action: 'expectText', text: itemsText(items) })
  const coupon = goal.toUpperCase().includes(COUPON.code)
  if (coupon) {
    steps.push({ action: 'fill', label: 'Coupon code', value: COUPON.code }, { action: 'click', role: 'button', name: 'Apply coupon' })
  }
  steps.push({ action: 'expectText', text: expectedTotal(coffees, coupon) })
  if (/check ?out|place (?:the |an |my )?order|confirm/i.test(goal)) {
    steps.push({ action: 'click', role: 'link', name: 'Go to checkout' })
    for (const [label, value] of CUSTOMER) steps.push({ action: 'fill', label, value })
    steps.push({ action: 'click', role: 'button', name: 'Place order' }, { action: 'expectText', text: 'is confirmed' })
  }
  return steps
}

/** A plan for a goal by rules: a purchase when it names coffees, otherwise a look at the page it names. */
function planByRules(goal: string): Lb07Step[] {
  const coffees = coffeesIn(goal)
  if (coffees.length > 0) return purchaseSteps(goal, coffees).slice(0, LB07_LIMITS.maxPlanSteps)
  if (/about|partner|weather/i.test(goal)) return [{ action: 'goto', path: '/about' }, { action: 'expectText', text: 'Partner links' }]
  if (/\bcart\b/i.test(goal)) return [{ action: 'goto', path: '/cart' }, { action: 'expectText', text: 'Your cart' }]
  return [{ action: 'goto', path: '/' }, { action: 'expectText', text: 'Fresh roasts' }, { action: 'expectCount', role: 'heading', count: 7 }]
}

/** The planner's one sentence on how it read the goal, made from the plan it wrote. */
export function readingOf(goal: string, plan: readonly Lb07Step[]): string {
  const adds = plan.filter(step => step.action === 'click' && step.name.startsWith('Add ')).length
  const parts: string[] = []
  if (adds > 0) parts.push(`add ${adds} ${adds === 1 ? 'bag' : 'bags'} to the cart`)
  if (plan.some(step => step.action === 'click' && step.name === 'Apply coupon')) parts.push(`apply ${COUPON.code}`)
  if (plan.some(step => step.action === 'click' && step.name === 'Place order')) parts.push('place the order')
  if (plan.some(step => step.action === 'click' && step.role === 'link' && step.name !== 'Go to checkout')) parts.push('follow the link it names')
  if (parts.length === 0) parts.push(`open ${plan[0]?.action === 'goto' ? plan[0].path : '/'}`)
  const checks = plan.filter(step => step.action === 'expectText' || step.action === 'expectCount').length
  const intent = `I will ${parts.join(', ')} in the staging shop and check ${checks} ${checks === 1 ? 'expectation' : 'expectations'} on the way.`
  return bounded(asksToLeave(goal) ? `The goal asks for things outside the shop, which no step can do. ${intent}` : intent, 300)
}

/** Writes the first plan wrong the way the golden set's re-plan case does: its first add button gets a name the shop does not have. */
function wrongFirstPlan(plan: readonly Lb07Step[]): { plan: Lb07Step[], replans: Lb07Step[][] } {
  const at = plan.findIndex(step => step.action === 'click' && step.name.startsWith('Add '))
  if (at < 0) return { plan: [...plan], replans: [] }
  const wrong: Lb07Step = { action: 'click', role: 'button', name: WRONG_BUTTON_NAME }
  return { plan: [...plan.slice(0, at), wrong, ...plan.slice(at + 1)], replans: [plan.slice(at)] }
}

/** Plans a run: the golden case's plan for a sample or a goal that is a case's word for word, and rules for any other goal. */
export function planFor(goal: string, golden: readonly GoldenCase[], sampleId: string | null): MockPlan {
  const entry = sampleId === null ? golden.find(candidate => candidate.goal.trim() === goal.trim()) : golden.find(candidate => candidate.id === sampleId)
  if (entry) {
    const { plan, replans } = entry.id === MOCK_REPLAN_SAMPLE && sampleId !== null ? wrongFirstPlan(entry.plan) : { plan: entry.plan, replans: entry.replans }
    return { reading: readingOf(goal, entry.plan), plan, scripted: replans }
  }
  const plan = lb07PlanSchema.parse({ steps: planByRules(goal) }).steps
  return { reading: readingOf(goal, plan), plan, scripted: undefined }
}

/** The words of a name worth comparing: three letters or more, in lower case. */
function significantWords(name: string): string[] {
  return wordsOf(name).filter(word => word.length >= 3)
}

/** Re-plans from the page, as a model shown the page's tree would: the failed step's control as the page names it, then the rest. Empty means "stop here". */
export function replanFromPage(failed: Lb07Step, remaining: readonly Lb07Step[], names: readonly { role: string, name: string }[]): Lb07Step[] {
  if (failed.action !== 'click' && failed.action !== 'fill') return []
  const role = failed.action === 'click' ? failed.role : 'textbox'
  const wanted = significantWords(failed.action === 'click' ? failed.name : failed.label)
  let best: { name: string, shared: number } | undefined
  for (const candidate of names) {
    if (candidate.role !== role || candidate.name === '') continue
    const shared = significantWords(candidate.name).filter(word => wanted.includes(word)).length
    if (shared > 0 && (best === undefined || shared > best.shared)) best = { name: candidate.name, shared }
  }
  if (!best) return []
  const fixed: Lb07Step = failed.action === 'click' ? { action: 'click', role: failed.role, name: best.name } : { action: 'fill', label: best.name, value: failed.value }
  return [fixed, ...remaining].slice(0, LB07_LIMITS.maxPlanSteps)
}

/** How to see a finding, as test steps in words: the steps that ran up to the one that made it. */
function stepsToSee(finding: Lb07Finding, ran: readonly Lb07Step[]): string[] {
  const upTo = finding.stepIndex === null ? ran : ran.slice(0, finding.stepIndex + 1)
  const said = upTo.slice(-12).map(step => bounded(sentence(describeStep(step)), 200))
  return said.length > 0 ? said : ['Open the shop.']
}

/** The words of one report for a finding of each kind. */
function wordsFor(finding: Lb07Finding): Pick<Lb07BugReport, 'title' | 'expected' | 'actual' | 'severity'> {
  const where = finding.path ?? 'the page'
  switch (finding.kind) {
    case 'expectation_failed':
      return { title: `The page at ${where} does not show what the goal expects`, expected: 'The page shows what a correct shop shows for the goal.', actual: sentence(finding.detail), severity: where.startsWith('/cart') || where.startsWith('/checkout') ? 'high' : 'medium' }
    case 'console_error':
      return { title: `A script error on ${where}`, expected: 'The page loads without an error in the console.', actual: sentence(`The console shows ${finding.detail}`), severity: 'low' }
    case 'failed_request':
      return { title: finding.engine === 'firefox-ua' ? `A request fails on ${where} in the second engine` : `A request fails on ${where}`, expected: 'Every request the page makes succeeds.', actual: sentence(finding.detail), severity: / 5\d\d\b/.test(finding.detail) ? 'high' : 'medium' }
    case 'accessibility':
      return { title: finding.rule === 'image-alt' ? `Pictures without a text alternative on ${where}` : `An accessibility rule fails on ${where}`, expected: 'Every picture has a text alternative a screen reader can read.', actual: sentence(finding.detail), severity: 'medium' }
    case 'blocked_navigation':
      return { title: 'The sandbox stopped a link', expected: 'The test stays in the shop.', actual: sentence(finding.detail), severity: 'low' }
  }
}

/** Writes the bug reports from the findings code made: one for each finding of a bug, the pictures' findings of one rule together. Never one for a stopped link, which is the sandbox at work. */
export function writeReports(findings: readonly Lb07Finding[], ran: readonly Lb07Step[]): Lb07BugReport[] {
  const reports: Lb07BugReport[] = []
  const byRule = new Map<string, Lb07BugReport>()
  for (const finding of findings) {
    if (finding.kind === 'blocked_navigation') continue
    const grouped = finding.kind === 'accessibility' && finding.rule !== null ? byRule.get(finding.rule) : undefined
    if (grouped) {
      if (grouped.findingIds.length < 8) grouped.findingIds.push(finding.id)
      continue
    }
    const words = wordsFor(finding)
    const report: Lb07BugReport = { findingIds: [finding.id], title: bounded(words.title, 120), steps: stepsToSee(finding, ran), expected: bounded(words.expected, 400), actual: bounded(words.actual, 400), severity: words.severity }
    if (finding.kind === 'accessibility' && finding.rule !== null) byRule.set(finding.rule, report)
    reports.push(report)
  }
  return reports.slice(0, 12)
}
