// How a step refers to data, and how that data is written into text.
//
// A reference names one value: `trigger.totalEur` is a field of the event's payload, and
// `check_stock.etaDays` is a field of a step's output. Text can carry references between
// double braces, such as "Order {{trigger.orderId}} ships in {{check_stock.etaDays}} days".
// That is the whole language: no expressions, no function calls, no code. Rendering
// replaces each placeholder once, and never looks inside the value it inserted, so a
// payload can't smuggle a placeholder of its own into the text.

/** One value a step may read, as a payload or output field. */
export type Scalar = string | number | boolean

/** A reference split into where the value comes from and which of its fields it is. */
export interface Reference {
  // `trigger`, or the id of an action step.
  source: string
  field: string
}

// `trigger.totalEur` or `check_stock.etaDays`: a source (`trigger`, or a step's id), a dot
// and a field name. No step may be called `trigger`, so a source is never ambiguous.
const REFERENCE = /^([a-z][a-z0-9_]{0,31})\.([a-zA-Z][a-zA-Z0-9]{0,31})$/
// A placeholder: braces around a short run of anything but braces.
const PLACEHOLDER = /\{\{([^{}]{1,80})\}\}/g

/** The pattern a reference must match, for schemas that check it. */
export const referencePattern = REFERENCE

/** Splits a reference into its source and field, or returns undefined when the text isn't one. */
export function parseReference(text: string): Reference | undefined {
  const match = REFERENCE.exec(text)
  if (!match) return undefined
  const [, source, field] = match
  if (source === undefined || field === undefined) return undefined
  return { source, field }
}

/** What a scan of a piece of text found: the references it holds, and whether any braces are left over. */
export interface TemplateScan {
  // The text of every {{placeholder}}, trimmed, in order and with repeats.
  placeholders: string[]
  // True when double braces remain that don't form a placeholder, such as an unclosed `{{`.
  stray: boolean
}

/** Finds the placeholders in a piece of text, and reports any double braces that are not one. */
export function scanTemplate(template: string): TemplateScan {
  const placeholders = [...template.matchAll(PLACEHOLDER)].map(match => (match[1] ?? '').trim())
  const rest = template.replaceAll(PLACEHOLDER, '')
  return { placeholders, stray: rest.includes('{{') || rest.includes('}}') }
}

/** Text with its placeholders filled in, and the references that had no value. */
export interface Rendered {
  text: string
  missing: string[]
}

/**
 * Fills the placeholders of a piece of text from `resolve`, which returns the value of a
 * reference or undefined when there is none. A missing value renders as nothing and is
 * listed, so the caller decides whether that is an error.
 */
export function renderTemplate(template: string, resolve: (reference: string) => Scalar | undefined): Rendered {
  const missing: string[] = []
  const text = template.replaceAll(PLACEHOLDER, (_whole, inner: string) => {
    const reference = inner.trim()
    const value = resolve(reference)
    if (value === undefined) {
      missing.push(reference)
      return ''
    }
    return String(value)
  })
  return { text, missing }
}
