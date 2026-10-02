// The inspector's form, generated from the schema that checks the step. A step's settings are
// defined once, in @lb/contracts: `connectorParams` for each connector, and the node schemas for the
// trigger and the approval. This module asks Zod for the JSON Schema of the one that applies and
// turns each property into an input: a closed list becomes a choice, a bounded text becomes a text
// box (a taller one when it may be long), and a record becomes rows of name and value. Nothing is
// written per connector, so a connector added to the contracts gets its form with no change here,
// and a limit changed there changes the form with it.
//
// The words of the form (each field's name and hint) are in the locale files, keyed by the
// field's owner and name; a test checks that every field has them in both languages.
import { approvalNodeSchema, connectorParams, GRAPH_LIMITS, triggerNodeSchema } from '@lb/contracts'
import type { ApprovalNode, TriggerNode, WorkflowNode } from '@lb/contracts'
import { z } from 'zod'

/** What every input has: the setting's name and whether it must be filled in. */
interface FieldBase {
  name: string
  required: boolean
}

/** A setting with a closed list of values. */
export interface ChoiceField extends FieldBase {
  kind: 'choice'
  options: readonly string[]
}

/** A setting that is bounded text. */
export interface TextField extends FieldBase {
  kind: 'text'
  maxLength: number
  // True when the text may be long enough to need a taller box.
  multiline: boolean
  // True when the text may hold {{values}}: a setting that must match a fixed form cannot.
  templated: boolean
}

/** A setting that is named values, such as a webhook's fields. */
export interface EntriesField extends FieldBase {
  kind: 'entries'
  valueMaxLength: number
  maxEntries: number
}

/** One input of the inspector. */
export type FormField = ChoiceField | TextField | EntriesField

// A text longer than this gets a box of several lines.
const MULTILINE_FROM = 120

// The properties of a JSON Schema that the form reads; everything else in it is ignored.
const propertySchema = z.object({
  type: z.string().optional(),
  enum: z.array(z.string()).optional(),
  maxLength: z.number().optional(),
  pattern: z.string().optional(),
  additionalProperties: z.union([z.boolean(), z.object({ maxLength: z.number().optional() })]).optional(),
})
const objectSchema = z.object({
  properties: z.record(z.string(), propertySchema),
  required: z.array(z.string()).optional(),
})

/** Turns one property of a JSON Schema into an input. */
function fieldOf(name: string, property: z.infer<typeof propertySchema>, required: boolean): FormField {
  if (property.enum) return { kind: 'choice', name, required, options: property.enum }
  if (property.type === 'object') {
    const values = typeof property.additionalProperties === 'object' ? property.additionalProperties : {}
    return { kind: 'entries', name, required, valueMaxLength: values.maxLength ?? 200, maxEntries: GRAPH_LIMITS.maxWebhookFields }
  }
  const maxLength = property.maxLength ?? 200
  return { kind: 'text', name, required, maxLength, multiline: maxLength > MULTILINE_FROM, templated: property.pattern === undefined }
}

/** Generates the inputs for a schema, in the order it declares them, leaving out the properties named in `skip`. */
export function fieldsOfSchema(schema: z.ZodType, skip: readonly string[] = []): FormField[] {
  const described = objectSchema.parse(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }))
  const required = new Set(described.required ?? [])
  return Object.entries(described.properties)
    .filter(([name]) => !skip.includes(name))
    .map(([name, property]) => fieldOf(name, property, required.has(name)))
}

// What every step has apart from its own settings.
const STRUCTURAL = ['id', 'label', 'position', 'type', 'connector', 'params']

// The forms, made once: a schema does not change while the page is open.
const cache = new Map<string, FormField[]>()

/** Returns the form of the settings the step with this owner has: a connector's id, `trigger` or `approval`. */
function formOf(owner: string, schema: z.ZodType, skip: readonly string[]): FormField[] {
  const known = cache.get(owner)
  if (known) return known
  const made = fieldsOfSchema(schema, skip)
  cache.set(owner, made)
  return made
}

/** Returns the inputs of a step's own settings: a connector's parameters, a trigger's event, an approval's approver and question. A condition has its own editor. */
export function fieldsFor(node: WorkflowNode): FormField[] {
  if (node.type === 'action') return formOf(node.connector, connectorParams[node.connector], [])
  if (node.type === 'trigger') return formOf('trigger', triggerNodeSchema, STRUCTURAL)
  if (node.type === 'approval') return formOf('approval', approvalNodeSchema, STRUCTURAL)
  return []
}

/** The settings of a step as a plain record: an action's parameters, or the step itself for a trigger and an approval. */
function settingsOf(node: WorkflowNode): Record<string, unknown> {
  return node.type === 'action' ? { ...node.params } : { ...node }
}

/** Reads the current value of one setting of a step; undefined when it has none. */
export function valueOf(node: WorkflowNode, name: string): unknown {
  return settingsOf(node)[name]
}

/** Returns the step with one setting changed. A cleared optional setting is taken off the step instead of being kept empty. */
export function withValue(node: WorkflowNode, field: FormField, value: unknown): WorkflowNode {
  const cleared = value === '' && !field.required
  const kept = Object.entries(settingsOf(node)).filter(([name]) => !(cleared && name === field.name))
  const settings: Record<string, unknown> = { ...Object.fromEntries(kept), ...(cleared ? {} : { [field.name]: value }) }
  if (node.type === 'action') return { ...node, params: settings } as WorkflowNode
  if (node.type === 'trigger') return { ...node, event: settings.event } as TriggerNode
  if (node.type === 'approval') return { ...node, approver: settings.approver, message: settings.message } as ApprovalNode
  return node
}

/** Reads a setting that is text, or an empty text when it is missing or is not text. */
export function textOf(node: WorkflowNode, name: string): string {
  const value = valueOf(node, name)
  return typeof value === 'string' ? value : ''
}

/** Reads a setting that is named values as rows of a name and a text. */
export function entriesOf(node: WorkflowNode, name: string): { name: string, value: string }[] {
  const value = valueOf(node, name)
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).map(([key, text]) => ({ name: key, value: typeof text === 'string' ? text : '' }))
}
