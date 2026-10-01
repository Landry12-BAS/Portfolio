// The payload a run is started with: one object whose fields are the trigger event's,
// checked against the event's own field list. A payload may hold only sandbox values:
// contact addresses must end in the reserved .test domain, so no real person's address
// ever reaches the engine.
import { z } from 'zod'

import { SANDBOX_EMAIL, TRIGGER_EVENTS } from './catalogue.ts'
import type { FieldSpec, TriggerEventId } from './catalogue.ts'
import type { Scalar } from './references.ts'

// The longest a text field may be unless its spec says otherwise.
const DEFAULT_TEXT_LENGTH = 120
// The largest a number field may be unless its spec says otherwise.
const DEFAULT_NUMBER_MAX = 1_000_000

/** Builds the check for one payload field from its spec. */
function fieldSchema(spec: FieldSpec): z.ZodType<Scalar> {
  switch (spec.kind) {
    case 'text':
      return z.string().trim().min(1).max(spec.max ?? DEFAULT_TEXT_LENGTH)
    case 'email':
      return z.string().regex(SANDBOX_EMAIL, 'a sandbox address that ends in .test')
    case 'number':
      return z.number().min(spec.min ?? 0).max(spec.max ?? DEFAULT_NUMBER_MAX)
    case 'boolean':
      return z.boolean()
  }
}

/** Builds the check for a trigger event's payload: every field of the event, and no others. */
export function triggerPayloadSchema(event: TriggerEventId): z.ZodType<Record<string, Scalar>> {
  const shape: Record<string, z.ZodType<Scalar>> = {}
  for (const [name, spec] of Object.entries(TRIGGER_EVENTS[event].fields)) shape[name] = fieldSchema(spec)
  return z.strictObject(shape)
}

/** Returns a plausible payload for a trigger event, to prefill the test run. */
export function examplePayload(event: TriggerEventId): Record<string, Scalar> {
  return Object.fromEntries(Object.entries(TRIGGER_EVENTS[event].fields).map(([name, spec]) => [name, spec.example]))
}
