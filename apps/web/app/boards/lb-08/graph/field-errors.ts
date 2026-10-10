// Which field of a step a problem belongs to, and why the field is wrong. The validator names a place
// such as `params.channel` or `message`; the inspector draws one input per field and shows the
// words beside the input that is at fault. The reason for an invalid value is read from the field
// itself, not guessed from the validator's English: empty means it is required, longer than the
// limit means it is too long, and anything else does not have the form the field needs.
import type { FormField } from './form'
import type { LocatedIssue } from './issues'

/** Why a value is wrong. */
export type FieldReason = 'required' | 'tooLong' | 'format'

/** Tells whether a problem's place is this field: `name`, `params.name` or something inside `params.name`. */
function concerns(located: LocatedIssue, name: string): boolean {
  const { target } = located
  if (target.kind !== 'node' || target.field === undefined) return false
  return target.field === name || target.field === `params.${name}` || target.field.startsWith(`params.${name}.`) || target.field.startsWith(`${name}.`)
}

/** Finds the first problem that belongs to a field of a step. */
export function problemOf(located: readonly LocatedIssue[], name: string): LocatedIssue | undefined {
  return located.find(item => concerns(item, name))
}

/** Says why a text is wrong, given the longest it may be. */
export function textReason(value: string, maxLength: number): FieldReason {
  if (value.trim() === '') return 'required'
  return value.length > maxLength ? 'tooLong' : 'format'
}

/** Says why the value of a generated field is wrong. */
export function reasonFor(field: FormField, value: unknown): FieldReason {
  if (field.kind === 'text') return textReason(typeof value === 'string' ? value : '', field.maxLength)
  if (field.kind === 'choice') return typeof value === 'string' && value !== '' ? 'format' : 'required'
  return 'format'
}
