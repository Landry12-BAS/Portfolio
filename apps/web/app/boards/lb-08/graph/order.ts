// The test order a run is started with: one value for each field the trigger's event carries
// (a wholesale order has a total in euros, a product code and a quantity; a stock alert has the
// product and the kilograms left). The fields come from the catalogue in @lb/contracts, the
// values are checked with the same `triggerPayloadSchema` the service checks them with, and a
// value that does not fit is named by its field, never repeated.
import { examplePayload, TRIGGER_EVENTS, triggerPayloadSchema } from '@lb/contracts'
import type { FieldKind, TriggerEventId, Values } from '@lb/contracts'

/** What the form holds for one field while it is being typed: text, or a tick for a yes-or-no field. */
export type OrderEntry = string | boolean

/** One field of a test order, as the form draws it. */
export interface OrderField {
  name: string
  kind: FieldKind
  // The smallest and largest a number may be, and the longest a text may be.
  min: number | undefined
  max: number | undefined
  // A value that fits, for the placeholder.
  example: string
}

/** Why a field's value does not fit. */
export type OrderProblem = 'required' | 'number' | 'range' | 'tooLong' | 'sandboxAddress'

/** Lists the fields of an event's test order, in the order the catalogue gives them. */
export function orderFields(event: TriggerEventId): OrderField[] {
  return Object.entries(TRIGGER_EVENTS[event].fields).map(([name, spec]) => ({
    name,
    kind: spec.kind,
    min: spec.kind === 'number' ? (spec.min ?? 0) : undefined,
    max: spec.max,
    example: String(spec.example),
  }))
}

/** Writes values the way the form holds them: numbers as text, yes-or-no as a tick. */
export function entriesFromValues(values: Values): Record<string, OrderEntry> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, typeof value === 'boolean' ? value : String(value)]))
}

/** The form's starting values for an event: the catalogue's examples. */
export function exampleEntries(event: TriggerEventId): Record<string, OrderEntry> {
  return entriesFromValues(examplePayload(event))
}

/** Reads the form's entries as the values the API takes: numbers as numbers, text trimmed. A number that is not one is left as text, so the check can name it. */
export function valuesOf(fields: readonly OrderField[], entries: Readonly<Record<string, OrderEntry>>): Values {
  const values: Values = {}
  for (const field of fields) {
    const entry = entries[field.name]
    if (entry === undefined) continue
    if (typeof entry === 'boolean') values[field.name] = entry
    else if (field.kind === 'number') values[field.name] = entry.trim() !== '' && Number.isFinite(Number(entry)) ? Number(entry) : entry
    else values[field.name] = entry.trim()
  }
  return values
}

/** Names why one issue of the payload check happened, from the Zod issue's code. */
function problemOf(code: string, kind: FieldKind, origin: string | undefined): OrderProblem {
  if (code === 'invalid_type') return kind === 'number' ? 'number' : 'required'
  if (code === 'too_small') return origin === 'string' ? 'required' : 'range'
  if (code === 'too_big') return origin === 'string' ? 'tooLong' : 'range'
  return kind === 'email' ? 'sandboxAddress' : 'required'
}

/** Checks a test order with the service's own check, and names the fields that do not fit and why. An empty map means the order is good. */
export function orderProblems(event: TriggerEventId, fields: readonly OrderField[], entries: Readonly<Record<string, OrderEntry>>): Map<string, OrderProblem> {
  const problems = new Map<string, OrderProblem>()
  const checked = triggerPayloadSchema(event).safeParse(valuesOf(fields, entries))
  if (checked.success) return problems
  for (const issue of checked.error.issues) {
    const name = String(issue.path[0] ?? '')
    const field = fields.find(candidate => candidate.name === name)
    if (!field || problems.has(name)) continue
    const origin = 'origin' in issue ? String(issue.origin) : undefined
    problems.set(name, problemOf(issue.code, field.kind, origin))
  }
  return problems
}
