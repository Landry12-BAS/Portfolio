// What a step can read while it runs, and how its settings become a request to a connector.
//
// A step reads two things: the payload the run was started with (`trigger.<field>`) and
// the outputs of the action steps that have already run (`<step id>.<field>`). A reference
// names one value, and text may carry references between double braces. That is the whole
// language: nothing here evaluates anything, and a value that is inserted is never
// scanned again, so a payload can't smuggle a placeholder of its own into the text.
//
// Everything here is checked before a graph is saved (`validateWorkflow`), and checked
// again as the step runs, so a value that is somehow missing fails the step instead of
// sending half a message.
import { parseReference, renderTemplate, SANDBOX_EMAIL } from '@lb/contracts'
import type { ActionNode, ConnectorId, Scalar, Values } from '@lb/contracts'

import { PermanentStepError } from './errors.ts'

/** The domain of the team mailboxes an email may go to. `.test` is reserved: nothing sent there can reach anyone. */
export const TEAM_MAILBOX_DOMAIN = 'basalt-bean.test'

// The longest any piece of rendered text may be. Rendering can make text longer than its
// template (a placeholder is replaced by a value), so the result is cut to what the
// run's views and the sandbox's table are built for.
const MAX_BODY = 600
const MAX_SUBJECT = 120
const MAX_TITLE = 120
const MAX_FIELD = 200
// The most kilograms a quantity may name (the same bound the trigger payloads use).
const MAX_QUANTITY_KG = 100_000

/** What a step can read: the run's payload, and the outputs of the steps that have succeeded. */
export interface RunContext {
  trigger: Values
  outputs: ReadonlyMap<string, Values>
}

/** What a connector is asked to do: its name and the values it works with, every text already filled in. */
export interface ConnectorCall {
  connector: ConnectorId
  payload: Values
}

/** Looks up the value a reference names, or returns undefined when there is none. */
export function lookup(context: RunContext, reference: string): Scalar | undefined {
  const parsed = parseReference(reference)
  if (!parsed) return undefined
  const source = parsed.source === 'trigger' ? context.trigger : context.outputs.get(parsed.source)
  // `hasOwn`, so a field called `constructor` finds nothing instead of a function.
  return source !== undefined && Object.hasOwn(source, parsed.field) ? source[parsed.field] : undefined
}

/** Returns the value a condition reads, or fails the step: a condition with nothing to compare can't choose a branch. */
export function readValue(context: RunContext, reference: string): Scalar {
  const value = lookup(context, reference)
  if (value === undefined) throw new PermanentStepError('missing_value', 'A value this step needs isn\'t available.')
  return value
}

/** Cuts text to `maxLength` characters, without leaving half of an emoji at the end. */
function clip(text: string, maxLength: number): string {
  const cut = text.slice(0, maxLength)
  const last = cut.charCodeAt(cut.length - 1)
  const endsInsidePair = last >= 0xD800 && last <= 0xDBFF
  return endsInsidePair ? cut.slice(0, -1) : cut
}

/** Fills in a template's placeholders and cuts the result to `maxLength`; a placeholder with no value fails the step. */
function render(template: string, context: RunContext, maxLength: number): string {
  const { text, missing } = renderTemplate(template, reference => lookup(context, reference))
  if (missing.length > 0) throw new PermanentStepError('missing_value', 'A value this step needs isn\'t available.')
  return clip(text, maxLength)
}

/** Works out the address an email goes to: the customer's, from the payload, or a team mailbox. */
function recipientOf(to: string, context: RunContext): string {
  if (to !== 'customer') return `${to}@${TEAM_MAILBOX_DOMAIN}`
  const address = lookup(context, 'trigger.contactEmail')
  if (typeof address !== 'string' || !SANDBOX_EMAIL.test(address)) {
    throw new PermanentStepError('no_recipient', 'The payload has no sandbox address to send to.')
  }
  return address
}

/** Reads a rendered quantity as kilograms: a number above zero and within bounds. */
function quantityOf(text: string): number {
  const kilograms = Number(text)
  if (!Number.isFinite(kilograms) || kilograms <= 0 || kilograms > MAX_QUANTITY_KG) {
    throw new PermanentStepError('invalid_quantity', 'The quantity isn\'t a number of kilograms above zero.')
  }
  return kilograms
}

/** Builds the request for a webhook call: its endpoint and event, and each field with a `field.` prefix so none can collide with them. */
function webhookPayload(node: Extract<ActionNode, { connector: 'webhook' }>, context: RunContext): Values {
  const payload: Values = { endpoint: node.params.endpoint, event: node.params.event }
  for (const [name, template] of Object.entries(node.params.fields)) payload[`field.${name}`] = render(template, context, MAX_FIELD)
  return payload
}

/**
 * Turns an action step's settings into the request its connector receives: every text
 * rendered from the context, the recipient resolved, nothing left to interpret. A value
 * the step needs and doesn't have fails it for good, because trying again won't produce one.
 */
export function buildCall(node: ActionNode, context: RunContext): ConnectorCall {
  switch (node.connector) {
    case 'stock_check': {
      const payload: Values = { sku: render(node.params.sku, context, 60) }
      if (node.params.quantityKg !== undefined) payload.quantityKg = quantityOf(render(node.params.quantityKg, context, 30))
      return { connector: 'stock_check', payload }
    }
    case 'slack_alert':
      return { connector: 'slack_alert', payload: { channel: node.params.channel, message: render(node.params.message, context, MAX_BODY) } }
    case 'email':
      return {
        connector: 'email',
        payload: { to: recipientOf(node.params.to, context), subject: render(node.params.subject, context, MAX_SUBJECT), body: render(node.params.body, context, MAX_BODY) },
      }
    case 'webhook':
      return { connector: 'webhook', payload: webhookPayload(node, context) }
    case 'create_task':
      return {
        connector: 'create_task',
        payload: { board: node.params.board, title: render(node.params.title, context, MAX_TITLE), priority: node.params.priority ?? 'normal' },
      }
  }
}

/** Fills in the placeholders of an approval's question, for the person who is asked. */
export function renderQuestion(template: string, context: RunContext): string {
  return render(template, context, MAX_BODY)
}
