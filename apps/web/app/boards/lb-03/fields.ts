// How the board lays out an invoice's fields. The service lists them in reading order, each with a path
// (`vendor`, `line_items.1.total`, `vat.0.rate`); this file turns that flat list into the groups a person
// reads (the document's own details, each line, the subtotal, each VAT line, the total) and names the
// words each field and each group takes from the locale files, so no text of the service's is ever a label.
import type { Check, Field } from './schemas'

/** The parts of a field's path: which group of the invoice it is in, which row of that group, and its name. */
export interface FieldAddress {
  group: 'document' | 'line' | 'subtotal' | 'vat' | 'total'
  // The row, from 0, for a line item or a VAT line; undefined for the fields that are not in a list.
  row: number | undefined
  name: string
}

/** One group of fields, with the words its heading takes. */
export interface FieldGroup {
  // A stable key for the group, such as `line-1`, for lists and tests.
  key: string
  // The locale key of the heading and the number it is given, when the heading is for a row.
  heading: { key: string, number: number | undefined }
  fields: Field[]
}

// The words of every field the board has: the locale key for each group and name. Written out in full, not built
// from the parts, so a key that no locale file has is found by a test and a key nothing uses is too.
const LABEL_KEYS: Readonly<Record<string, string>> = {
  'document:document_type': 'lb03.fields.document_type',
  'document:vendor': 'lb03.fields.vendor',
  'document:invoice_number': 'lb03.fields.invoice_number',
  'document:issue_date': 'lb03.fields.issue_date',
  'document:due_date': 'lb03.fields.due_date',
  'document:currency': 'lb03.fields.currency',
  'subtotal:subtotal': 'lb03.fields.subtotal',
  'total:total': 'lb03.fields.total',
  'line:description': 'lb03.fields.line.description',
  'line:quantity': 'lb03.fields.line.quantity',
  'line:unit_price': 'lb03.fields.line.unit_price',
  'line:total': 'lb03.fields.line.total',
  'vat:rate': 'lb03.fields.vat.rate',
  'vat:base': 'lb03.fields.vat.base',
  'vat:amount': 'lb03.fields.vat.amount',
}

// The words of each group's heading.
const GROUP_KEYS: Readonly<Record<FieldAddress['group'], string>> = {
  document: 'lb03.fields.groups.document',
  line: 'lb03.fields.groups.line',
  subtotal: 'lb03.fields.groups.subtotal',
  vat: 'lb03.fields.groups.vat',
  total: 'lb03.fields.groups.total',
}

/** Reads a field's path into its parts. A path the service would never write is read as a field of the document. */
export function addressOf(path: string): FieldAddress {
  const parts = path.split('.')
  const [first, second, third] = parts
  if ((first === 'line_items' || first === 'vat') && second !== undefined && third !== undefined) {
    return { group: first === 'line_items' ? 'line' : 'vat', row: Number(second), name: third }
  }
  if (first === 'subtotal') return { group: 'subtotal', row: undefined, name: 'subtotal' }
  if (first === 'total') return { group: 'total', row: undefined, name: 'total' }
  return { group: 'document', row: undefined, name: first ?? path }
}

/** Gives the locale key of a field's label, such as `lb03.fields.line.total`, or undefined for a field the board has no word for. */
export function labelKey(path: string): string | undefined {
  const { group, name } = addressOf(path)
  return LABEL_KEYS[`${group}:${name}`]
}

/** What `t` of vue-i18n is to this file: a key and the values to put in its message. */
export type Translate = (key: string, values?: Record<string, string | number>) => string

/** Writes a field's name in the visitor's language, with its row when it is in a list: `Total`, `Line 2: Total`, `VAT line 1: Rate`. */
export function fieldLabel(path: string, t: Translate): string {
  // `required_fields` names the line items as a whole when there are none, which is not a field of the table.
  if (path === 'line_items') return t('lb03.fields.groups.lineItems')
  const { group, row } = addressOf(path)
  const key = labelKey(path)
  const name = key === undefined ? path : t(key)
  if (row === undefined) return name
  return t(group === 'line' ? 'lb03.fields.lineOf' : 'lb03.fields.vatOf', { n: row + 1, field: name })
}

/** Says which line item or VAT line a path is about, counting from 1, or undefined for a field that is not in a list. */
export function rowNumber(path: string): number | undefined {
  const { row } = addressOf(path)
  return row === undefined ? undefined : row + 1
}

/** Groups the fields in the order the service gave them: the details, each line, the subtotal, each VAT line, the total. */
export function groupFields(fields: readonly Field[]): FieldGroup[] {
  const groups: FieldGroup[] = []
  for (const field of fields) {
    const { group, row } = addressOf(field.path)
    const key = row === undefined ? group : `${group}-${row + 1}`
    let target = groups.find(item => item.key === key)
    if (target === undefined) {
      target = { key, heading: { key: GROUP_KEYS[group], number: row === undefined ? undefined : row + 1 }, fields: [] }
      groups.push(target)
    }
    target.fields.push(field)
  }
  return groups
}

/** Finds a field by its path. */
export function fieldAt(fields: readonly Field[] | null, path: string | undefined): Field | undefined {
  if (fields === null || path === undefined) return undefined
  return fields.find(field => field.path === path)
}

/**
 * Picks the field to light up when a reading opens, so the page is never shown with nothing pointed at: the
 * first field that a failed check names (the ones that stop the export first) and that was found on the page,
 * else the total if it was found, else the first field that was found, else the first field.
 */
export function firstFieldToShow(fields: readonly Field[] | null, checks: readonly Check[] | null): string | undefined {
  if (fields === null || fields.length === 0) return undefined
  const failed = (checks ?? []).filter(check => check.status === 'failed')
  const stopping = failed.filter(check => check.severity === 'error')
  const namedPaths = [...stopping, ...failed].flatMap(check => check.fields)
  const onPage = (path: string): boolean => {
    const field = fieldAt(fields, path)
    return field !== undefined && field.box !== null
  }
  const named = namedPaths.find(onPage)
  if (named !== undefined) return named
  if (onPage('total')) return 'total'
  return (fields.find(field => field.box !== null) ?? fields[0])?.path
}

/** The currencies the company trades in: the ones the `currency_known` check accepts (services/flask-systems/lb03/invoice.py). */
export const KNOWN_CURRENCIES = ['CZK', 'EUR', 'USD', 'GBP', 'PLN', 'CHF', 'HUF'] as const

/** The kinds of document the service reads, which a visitor may choose between when correcting the document's type. */
export const DOCUMENT_TYPES = ['invoice', 'credit_note', 'receipt'] as const
