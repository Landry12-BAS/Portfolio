// The closed vocabulary of a test plan: what the model may ask the browser to do, and nothing else.
// There is no selector, no script, no URL: a step names a shop path, an accessible role and name,
// a form field's label, or a text to expect. The runner turns each step into one Playwright call of
// its own, so a plan can never carry code. Both the planner's answer and the stored plan are checked
// against these schemas, and the generated test is written from the checked plan by a template.
import { z } from 'zod'

import { LB07_LIMITS } from './limits.ts'

/** A path inside the staging shop: absolute, lowercase, with no scheme, host, query or fragment. `//host` is not a path. */
export const lb07ShopPathSchema = z.string().regex(/^\/(?!\/)[a-z0-9/-]{0,80}$/, 'a shop path such as /cart')

/** The accessible roles a step may click. */
export const LB07_CLICK_ROLES = ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem'] as const
/** The accessible roles a step may count. */
export const LB07_COUNT_ROLES = [...LB07_CLICK_ROLES, 'listitem', 'row', 'img', 'heading', 'textbox'] as const

// An accessible name, a label, an option or a text to look for: plain, bounded, and without control characters.
const words = z.string().trim().min(1).max(120).regex(/^[^\p{Cc}\p{Cf}]+$/u, 'plain text without control characters')
const value = z.string().max(200).regex(/^[^\p{Cc}\p{Cf}]*$/u, 'plain text without control characters')

/** Go to a page of the shop. */
export const lb07GotoStepSchema = z.strictObject({ action: z.literal('goto'), path: lb07ShopPathSchema })
/** Click the one element with this role and accessible name. */
export const lb07ClickStepSchema = z.strictObject({ action: z.literal('click'), role: z.enum(LB07_CLICK_ROLES), name: words })
/** Type a value into the form field with this label. */
export const lb07FillStepSchema = z.strictObject({ action: z.literal('fill'), label: words, value })
/** Choose an option in the select with this label. */
export const lb07SelectStepSchema = z.strictObject({ action: z.literal('select'), label: words, option: words })
/** Expect the page to show this text. */
export const lb07ExpectTextStepSchema = z.strictObject({ action: z.literal('expectText'), text: words })
/** Expect this many elements with this role (and name, when given). */
export const lb07ExpectCountStepSchema = z.strictObject({ action: z.literal('expectCount'), role: z.enum(LB07_COUNT_ROLES), name: words.optional(), count: z.int().min(0).max(200) })

/** One step of a plan. */
export const lb07StepSchema = z.discriminatedUnion('action', [lb07GotoStepSchema, lb07ClickStepSchema, lb07FillStepSchema, lb07SelectStepSchema, lb07ExpectTextStepSchema, lb07ExpectCountStepSchema])
/** One step. */
export type Lb07Step = z.infer<typeof lb07StepSchema>
/** The actions a step may have. */
export type Lb07Action = Lb07Step['action']

/** A whole plan: its steps, in order. The first must open a page. */
export const lb07PlanSchema = z.strictObject({
  steps: z.array(lb07StepSchema).min(1).max(LB07_LIMITS.maxPlanSteps),
}).refine(plan => plan.steps[0]?.action === 'goto', 'a plan starts by going to a page of the shop')
/** A plan. */
export type Lb07Plan = z.infer<typeof lb07PlanSchema>

/** What the planner must answer: a plan, and one sentence on how it reads the goal (shown to the visitor as the model's words). */
export const lb07PlanAnswerSchema = z.strictObject({
  reading: z.string().trim().min(1).max(300),
  steps: lb07PlanSchema.shape.steps,
})
/** The planner's answer. */
export type Lb07PlanAnswer = z.infer<typeof lb07PlanAnswerSchema>

/** What the re-planner must answer: the steps that replace the failed step and everything after it. Empty means "stop here". */
export const lb07ReplanAnswerSchema = z.strictObject({
  reason: z.string().trim().min(1).max(300),
  steps: z.array(lb07StepSchema).max(LB07_LIMITS.maxPlanSteps),
})
/** The re-planner's answer. */
export type Lb07ReplanAnswer = z.infer<typeof lb07ReplanAnswerSchema>

/** Says a step in a few words, for a log, a span name or the generated test's comments. Nothing a visitor typed is in it: the words are the plan's. */
export function describeStep(step: Lb07Step): string {
  switch (step.action) {
    case 'goto': return `go to ${step.path}`
    case 'click': return `click the ${step.role} "${step.name}"`
    case 'fill': return `fill "${step.label}"`
    case 'select': return `choose "${step.option}" in "${step.label}"`
    case 'expectText': return `expect the text "${step.text}"`
    case 'expectCount': return `expect ${step.count} ${step.role}${step.name === undefined ? '' : ` "${step.name}"`}`
  }
}
