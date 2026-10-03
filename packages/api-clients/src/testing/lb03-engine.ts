// What the mock's LB-03 needs to read an invoice the way the real service does, without a model or
// OCR: the invoice and its field paths, money as whole millionths (never a float), the eleven checks
// of services/flask-systems/lb03/checks.py with their messages, the duplicate rule, the journal entry
// (lb03/accounts.py) and the two CSV files (lb03/export.py). It is a second implementation, written
// for a test fixture, so its tests hold it to the golden set: every planted error of the golden set
// fails exactly the check the set names, every valid document passes all of them, and the journal
// entries balance. The real service's own tests are the authority on what the rules are.
import { createHash } from 'node:crypto'

/** A money amount, a quantity or a rate as a whole number of millionths, so 1850.00 is 1850000000n. */
export type Amount = bigint

const SCALE = 1_000_000n
const CENT = 10_000n
const HALF_CENT = 5_000n
const ONE_CENT_TOLERANCE = CENT
// The most digits an amount may hold before its decimal point: no supplier invoice reaches a trillion.
const LARGEST_AMOUNT = 1_000_000_000_000n * SCALE

/** One row of the invoice's table. */
export interface Line {
  description: string
  quantity: Amount | null
  unitPrice: Amount | null
  total: Amount | null
}

/** One VAT rate of the invoice. */
export interface VatRow {
  rate: Amount | null
  base: Amount | null
  amount: Amount | null
}

/** The kinds of document the service reads. */
export type DocumentType = 'invoice' | 'credit_note' | 'receipt'

/** The fields of one invoice, credit note or receipt, as the model filled them in. */
export interface Invoice {
  documentType: DocumentType
  vendor: string | null
  invoiceNumber: string | null
  issueDate: string | null
  dueDate: string | null
  currency: string | null
  pricesIncludeVat: boolean | null
  lineItems: Line[]
  subtotal: Amount | null
  vat: VatRow[]
  total: Amount | null
}

/** The names of the checks, in the order the service runs them. */
export type CheckId
  = | 'required_fields' | 'dates_valid' | 'currency_known' | 'signs_agree' | 'line_math' | 'line_items_sum'
    | 'vat_math' | 'vat_bases' | 'total_reconciles' | 'fields_on_page' | 'not_duplicate'

/** One check's verdict, in the shape the API shows it. */
export interface CheckResult {
  id: CheckId
  status: 'passed' | 'failed' | 'skipped'
  severity: 'error' | 'warning'
  message: string
  fields: string[]
  expected: string | null
  actual: string | null
}

/** The currencies a Basalt & Bean supplier invoices in. */
export const CURRENCIES = ['CZK', 'EUR', 'USD', 'GBP', 'PLN', 'CHF', 'HUF'] as const
const DOCUMENT_TYPES: readonly string[] = ['invoice', 'credit_note', 'receipt']
const EARLIEST_ISSUE_DATE = '2000-01-01'
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const AMOUNT_TEXT = /^(-?)(\d{1,12})(?:[.,](\d{1,6}))?$/
const CURRENCY_SYMBOLS: Record<string, string> = { '€': 'EUR', '$': 'USD', '£': 'GBP', 'kc': 'CZK', 'kč': 'CZK', 'zł': 'PLN', 'ft': 'HUF' }
const MAX_LINE_ITEMS = 40
const MAX_VAT_LINES = 8
const FIELD_PATH = /^(?:[a-z_]{1,20}|(?:line_items|vat)\.\d{1,2}\.[a-z_]{1,20})$/

/** Reads an amount as people write it in the API: digits, an optional minus, a dot or comma and up to six decimals. */
export function parseAmount(text: string): Amount | undefined {
  const match = AMOUNT_TEXT.exec(text.replace(/[\s']/g, ''))
  if (!match) return undefined
  const [, sign = '', whole = '0', fraction = ''] = match
  const value = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'))
  return sign === '-' ? -value : value
}

/** Rounds an amount half away from zero to the cent, as Python's ROUND_HALF_UP does. */
export function cents(value: Amount): Amount {
  const sign = value < 0n ? -1n : 1n
  return sign * (((sign * value + HALF_CENT) / CENT) * CENT)
}

/** Tells whether two amounts are equal at the cent, give or take the one-cent tolerance. */
export function sameAmount(left: Amount, right: Amount): boolean {
  const difference = cents(left) - cents(right)
  return (difference < 0n ? -difference : difference) <= ONE_CENT_TOLERANCE
}

/** The product of a quantity and a price, rounded half up to the cent. */
export function times(quantity: Amount, price: Amount): Amount {
  const exact = quantity * price
  const unit = SCALE * CENT
  const sign = exact < 0n ? -1n : 1n
  return sign * ((sign * exact + unit / 2n) / unit) * CENT
}

/** The VAT on a base at a rate in percent, rounded half up to the cent. */
export function vatAmount(base: Amount, rate: Amount): Amount {
  const exact = base * rate
  const unit = SCALE * 100n * CENT
  const sign = exact < 0n ? -1n : 1n
  return sign * ((sign * exact + unit / 2n) / unit) * CENT
}

/** Writes an amount with two decimals and a dot, such as `1040.60`. */
export function amountText(value: Amount): string {
  const rounded = cents(value)
  const negative = rounded < 0n
  const absolute = negative ? -rounded : rounded
  const whole = absolute / SCALE
  const fraction = ((absolute % SCALE) / CENT).toString().padStart(2, '0')
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

/** Writes a quantity without trailing zeros, such as `4` or `0.75`. */
export function quantityText(value: Amount): string {
  const negative = value < 0n
  const absolute = negative ? -value : value
  const whole = absolute / SCALE
  const fraction = (absolute % SCALE).toString().padStart(6, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`
}

/** Sums amounts. */
function sum(values: Iterable<Amount>): Amount {
  let total = 0n
  for (const value of values) total += value
  return total
}

/** Writes the fields of an invoice in reading order: header, line items, subtotal, VAT rows, total. */
export function fieldPaths(invoice: Invoice): string[] {
  const paths = ['document_type', 'vendor', 'invoice_number', 'issue_date', 'due_date', 'currency']
  invoice.lineItems.forEach((_, index) => paths.push(...['description', 'quantity', 'unit_price', 'total'].map(name => `line_items.${index}.${name}`)))
  paths.push('subtotal')
  invoice.vat.forEach((_, index) => paths.push(...['rate', 'base', 'amount'].map(name => `vat.${index}.${name}`)))
  paths.push('total')
  return paths
}

/** Splits a field path such as `vat.1.rate` into the list, the row and the column. */
function splitPath(path: string): { list: string, index: number, column: string } | { scalar: string } | undefined {
  if (!FIELD_PATH.test(path)) return undefined
  const parts = path.split('.')
  const [first = '', second, third] = parts
  return parts.length === 1 ? { scalar: first } : { list: first, index: Number(second), column: third ?? '' }
}

/** Writes one scalar of an invoice as the API shows it, or undefined for a field the invoice does not have. */
function scalarText(invoice: Invoice, name: string): string | null | undefined {
  switch (name) {
    case 'document_type': return invoice.documentType
    case 'vendor': return invoice.vendor
    case 'invoice_number': return invoice.invoiceNumber
    case 'issue_date': return invoice.issueDate
    case 'due_date': return invoice.dueDate
    case 'currency': return invoice.currency
    case 'subtotal': return invoice.subtotal === null ? null : amountText(invoice.subtotal)
    case 'total': return invoice.total === null ? null : amountText(invoice.total)
    default: return undefined
  }
}

/** Reads a field's value as text, null when it is empty, undefined when the invoice has no such field. */
export function getField(invoice: Invoice, path: string): string | null | undefined {
  const where = splitPath(path)
  if (where === undefined) return undefined
  if ('scalar' in where) return scalarText(invoice, where.scalar)
  const { list, index, column } = where
  if (list === 'line_items') {
    const line = invoice.lineItems[index]
    if (line === undefined) return undefined
    switch (column) {
      case 'description': return line.description === '' ? null : line.description
      case 'quantity': return line.quantity === null ? null : quantityText(line.quantity)
      case 'unit_price': return line.unitPrice === null ? null : amountText(line.unitPrice)
      case 'total': return line.total === null ? null : amountText(line.total)
      default: return undefined
    }
  }
  const row = invoice.vat[index]
  if (row === undefined) return undefined
  switch (column) {
    case 'rate': return row.rate === null ? null : quantityText(row.rate)
    case 'base': return row.base === null ? null : amountText(row.base)
    case 'amount': return row.amount === null ? null : amountText(row.amount)
    default: return undefined
  }
}

/** Reads text a visitor typed as an optional bounded text, or false when it does not fit. */
function readText(text: string, limit: number): string | null | false {
  const flat = [...text].map(character => (/\p{C}/u.test(character) ? ' ' : character)).join('').split(/\s+/).filter(Boolean).join(' ')
  if (['', 'null', 'none', 'n/a', 'na', '-', '—'].includes(flat.toLowerCase())) return null
  return flat.length > limit ? false : flat
}

/** Reads an amount typed for a field: nothing means empty, text that is not an amount does not fit. */
function readAmount(text: string): Amount | null | false {
  const flat = text.trim()
  if (['', 'null', 'none', 'n/a', 'na', '-', '—'].includes(flat.toLowerCase())) return null
  const value = parseAmount(flat)
  return value === undefined || (value < 0n ? -value : value) >= LARGEST_AMOUNT ? false : value
}

/** Reads a day typed for a field: `YYYY-MM-DD` of a day that exists, and nothing else. */
function readDay(text: string): string | null | false {
  const flat = text.trim()
  if (['', 'null', 'none', 'n/a', 'na', '-', '—'].includes(flat.toLowerCase())) return null
  const match = ISO_DAY.exec(flat)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? flat : false
}

/** Reads a currency typed for a field: three capital letters, or a common symbol. */
function readCurrency(text: string): string | null | false {
  const flat = readText(text, 12)
  if (flat === null || flat === false) return flat
  const code = CURRENCY_SYMBOLS[flat.toLowerCase()] ?? flat.toUpperCase()
  return /^[A-Z]{3}$/.test(code) ? code : false
}

/** Copies an invoice, so an edit never changes the one it was made from. */
function copyInvoice(invoice: Invoice): Invoice {
  return { ...invoice, lineItems: invoice.lineItems.map(line => ({ ...line })), vat: invoice.vat.map(row => ({ ...row })) }
}

/** Sets a scalar field of an invoice from typed text; false when the text does not fit the field. */
function setScalar(invoice: Invoice, name: string, text: string): boolean {
  switch (name) {
    case 'vendor': {
      const value = readText(text, 120)
      if (value === false) return false
      invoice.vendor = value
      return true
    }
    case 'invoice_number': {
      const value = readText(text, 40)
      if (value === false) return false
      invoice.invoiceNumber = value
      return true
    }
    case 'issue_date':
    case 'due_date': {
      const value = readDay(text)
      if (value === false) return false
      if (name === 'issue_date') invoice.issueDate = value
      else invoice.dueDate = value
      return true
    }
    case 'currency': {
      const value = readCurrency(text)
      if (value === false) return false
      invoice.currency = value
      return true
    }
    case 'document_type': {
      const value = readText(text, 20)
      const normalised = value === null || value === false ? 'invoice' : value.toLowerCase().replace(/[ -]/g, '_')
      if (value === false || !DOCUMENT_TYPES.includes(normalised)) return false
      invoice.documentType = normalised as DocumentType
      return true
    }
    case 'subtotal':
    case 'total': {
      const value = readAmount(text)
      if (value === false) return false
      if (name === 'subtotal') invoice.subtotal = value
      else invoice.total = value
      return true
    }
    default: return false
  }
}

/** Sets a column of a line item from typed text. */
function setLineColumn(line: Line, column: string, text: string): boolean {
  if (column === 'description') {
    const value = readText(text, 160)
    if (value === false) return false
    line.description = value ?? ''
    return true
  }
  const value = readAmount(text)
  if (value === false) return false
  if (column === 'quantity') line.quantity = value
  else if (column === 'unit_price') line.unitPrice = value
  else if (column === 'total') line.total = value
  else return false
  return true
}

/** Sets a column of a VAT row from typed text. */
function setVatColumn(row: VatRow, column: string, text: string): boolean {
  const value = readAmount(text)
  if (value === false) return false
  if (column === 'rate') row.rate = value
  else if (column === 'base') row.base = value
  else if (column === 'amount') row.amount = value
  else return false
  return true
}

/** Returns the invoice with one field replaced by what a visitor typed, or undefined when the path or the text does not fit. */
export function setField(invoice: Invoice, path: string, text: string): Invoice | undefined {
  const where = splitPath(path)
  if (where === undefined || getField(invoice, path) === undefined) return undefined
  const edited = copyInvoice(invoice)
  let fits: boolean
  if ('scalar' in where) {
    fits = setScalar(edited, where.scalar, text)
  }
  else {
    const row = where.list === 'line_items' ? edited.lineItems[where.index] : edited.vat[where.index]
    fits = row !== undefined && (where.list === 'line_items' ? setLineColumn(row as Line, where.column, text) : setVatColumn(row as VatRow, where.column, text))
  }
  return fits ? edited : undefined
}

/** A check that passed. */
function passed(id: CheckId, fields: string[] = []): CheckResult {
  return { id, status: 'passed', severity: 'error', message: '', fields, expected: null, actual: null }
}

/** A check that could not run for want of numbers. */
function skipped(id: CheckId, message: string): CheckResult {
  return { id, status: 'skipped', severity: 'error', message, fields: [], expected: null, actual: null }
}

/** A check the document failed. */
function failed(id: CheckId, message: string, fields: string[], expected: string | null = null, actual: string | null = null, severity: 'error' | 'warning' = 'error'): CheckResult {
  return { id, status: 'failed', severity, message, fields, expected, actual }
}

/** Requires a vendor, a number, an issue date, a currency, a total and at least one line item. */
function checkRequired(invoice: Invoice): CheckResult {
  const missing = [
    ['vendor', invoice.vendor], ['invoice_number', invoice.invoiceNumber], ['issue_date', invoice.issueDate], ['currency', invoice.currency], ['total', invoice.total],
  ].filter(([, value]) => value === null).map(([path]) => String(path))
  if (invoice.lineItems.length === 0) missing.push('line_items')
  return missing.length > 0 ? failed('required_fields', `These fields are missing: ${missing.join(', ')}.`, missing) : passed('required_fields')
}

/** Requires an issue date that is not in the future, and a due date that is not before it. */
function checkDates(invoice: Invoice, today: string): CheckResult {
  const issue = invoice.issueDate
  if (issue === null) return skipped('dates_valid', 'There is no issue date to check.')
  if (issue > today) return failed('dates_valid', `The issue date ${issue} is in the future.`, ['issue_date'], `on or before ${today}`, issue)
  if (issue < EARLIEST_ISSUE_DATE) return failed('dates_valid', `The issue date ${issue} is before 2000.`, ['issue_date'], `${EARLIEST_ISSUE_DATE} or later`, issue)
  if (invoice.dueDate !== null && invoice.dueDate < issue) return failed('dates_valid', `The due date ${invoice.dueDate} is before the issue date ${issue}.`, ['due_date'], `${issue} or later`, invoice.dueDate)
  return passed('dates_valid', ['issue_date', 'due_date'])
}

/** Requires a currency from the short list of those Basalt & Bean trades in. */
function checkCurrency(invoice: Invoice): CheckResult {
  if (invoice.currency === null) return skipped('currency_known', 'There is no currency to check.')
  if (!(CURRENCIES as readonly string[]).includes(invoice.currency)) {
    return failed('currency_known', `The currency ${invoice.currency} is not one of ${CURRENCIES.join(', ')}.`, ['currency'], CURRENCIES.join(', '), invoice.currency)
  }
  return passed('currency_known', ['currency'])
}

/** Collects every amount the invoice prints. */
function printedAmounts(invoice: Invoice): Amount[] {
  const amounts: (Amount | null)[] = [...invoice.lineItems.map(line => line.total), invoice.subtotal, ...invoice.vat.map(row => row.amount), invoice.total]
  return amounts.filter((value): value is Amount => value !== null)
}

/** Requires the printed amounts to agree in sign. */
function checkSigns(invoice: Invoice): CheckResult {
  const amounts = printedAmounts(invoice).filter(value => value !== 0n)
  if (amounts.length < 2) return skipped('signs_agree', 'There are too few amounts to compare.')
  if (amounts.every(value => value > 0n) || amounts.every(value => value < 0n)) return passed('signs_agree')
  return failed('signs_agree', 'Some amounts are positive and some negative.', ['total'])
}

/** Requires quantity times unit price to be the line total, for every line that prints all three. */
function checkLineMath(invoice: Invoice): CheckResult {
  let checked = 0
  for (const [index, line] of invoice.lineItems.entries()) {
    if (line.quantity === null || line.unitPrice === null || line.total === null) continue
    checked += 1
    const product = times(line.quantity, line.unitPrice)
    if (!sameAmount(product, line.total)) {
      return failed('line_math', `Line ${index + 1}: ${quantityText(line.quantity)} times ${amountText(line.unitPrice)} is ${amountText(product)}, but the line total is ${amountText(line.total)}.`, [`line_items.${index}.total`], amountText(product), amountText(line.total))
    }
  }
  return checked === 0 ? skipped('line_math', 'No line prints a quantity, a unit price and a total.') : passed('line_math')
}

/** Returns every line's total, or null when any line has none. */
function lineTotals(invoice: Invoice): Amount[] | null {
  const totals = invoice.lineItems.map(line => line.total)
  return totals.length === 0 || totals.some(total => total === null) ? null : totals as Amount[]
}

/** Requires the line totals to add up to the subtotal, or to the total when the prices include VAT. */
function checkLineSum(invoice: Invoice): CheckResult {
  const totals = lineTotals(invoice)
  const gross = invoice.pricesIncludeVat === true
  const target = gross ? invoice.total : invoice.subtotal
  const path = gross ? 'total' : 'subtotal'
  if (totals === null) return skipped('line_items_sum', 'Not every line prints a total.')
  if (target === null) return skipped('line_items_sum', `There is no ${path} to compare the lines with.`)
  const added = sum(totals)
  if (sameAmount(added, target)) return passed('line_items_sum')
  return failed('line_items_sum', `The line totals add up to ${amountText(added)}, but the ${path} is ${amountText(target)}.`, [path, ...totals.map((_, index) => `line_items.${index}.total`)], amountText(added), amountText(target))
}

/** Returns what a VAT row applies to: its own base, or the subtotal when it is the only row. */
function vatBase(invoice: Invoice, row: VatRow): Amount | null {
  if (row.base !== null) return row.base
  return invoice.vat.length === 1 && invoice.pricesIncludeVat !== true ? invoice.subtotal : null
}

/** Requires each VAT amount to be its base times its rate, rounded to the cent (give or take one). */
function checkVatMath(invoice: Invoice): CheckResult {
  let checked = 0
  for (const [index, row] of invoice.vat.entries()) {
    const base = vatBase(invoice, row)
    if (row.rate === null || row.amount === null || base === null) continue
    checked += 1
    const expected = vatAmount(base, row.rate)
    if (!sameAmount(expected, row.amount)) {
      return failed('vat_math', `VAT line ${index + 1}: ${quantityText(row.rate)}% of ${amountText(base)} is ${amountText(expected)}, but the VAT is ${amountText(row.amount)}.`, [`vat.${index}.amount`], amountText(expected), amountText(row.amount))
    }
  }
  return checked === 0 ? skipped('vat_math', 'No VAT line prints a rate, an amount and what it applies to.') : passed('vat_math')
}

/** Requires the VAT bases to add up to the subtotal, or base plus VAT to the total when prices include VAT. */
function checkVatBases(invoice: Invoice): CheckResult {
  if (invoice.vat.length === 0 || invoice.vat.some(row => row.base === null)) return skipped('vat_bases', 'Not every VAT line prints what it applies to.')
  const gross = invoice.pricesIncludeVat === true
  const target = gross ? invoice.total : invoice.subtotal
  const path = gross ? 'total' : 'subtotal'
  if (target === null || (gross && invoice.vat.some(row => row.amount === null))) return skipped('vat_bases', `There is no ${path} to compare the VAT bases with.`)
  const added = sum(invoice.vat.map(row => row.base ?? 0n)) + (gross ? sum(invoice.vat.map(row => row.amount ?? 0n)) : 0n)
  if (sameAmount(added, target)) return passed('vat_bases')
  return failed('vat_bases', `The VAT lines apply to ${amountText(added)}, but the ${path} is ${amountText(target)}.`, [path, ...invoice.vat.map((_, index) => `vat.${index}.base`)], amountText(added), amountText(target))
}

/** Requires the subtotal plus the VAT to be the total: the line totals stand in for a subtotal the document omits. */
function checkTotal(invoice: Invoice): CheckResult {
  if (invoice.total === null) return skipped('total_reconciles', 'There is no total to check.')
  if (invoice.pricesIncludeVat === true && invoice.subtotal === null) return skipped('total_reconciles', 'The prices include VAT and there is no subtotal.')
  let base = invoice.subtotal
  if (base === null) {
    const totals = lineTotals(invoice)
    base = totals === null ? null : sum(totals)
  }
  if (base === null) return skipped('total_reconciles', 'There is no subtotal, and not every line prints a total.')
  if (invoice.vat.some(row => row.amount === null)) return skipped('total_reconciles', 'A VAT line prints no amount.')
  const expected = base + sum(invoice.vat.map(row => row.amount ?? 0n))
  if (sameAmount(expected, invoice.total)) return passed('total_reconciles')
  return failed('total_reconciles', `The subtotal and the VAT come to ${amountText(expected)}, but the total is ${amountText(invoice.total)}.`, ['total'], amountText(expected), amountText(invoice.total))
}

/** Runs the nine checks that need only the invoice, in the service's order, as of a day. */
export function runChecks(invoice: Invoice, today: string): CheckResult[] {
  return [
    checkRequired(invoice), checkDates(invoice, today), checkCurrency(invoice), checkSigns(invoice), checkLineMath(invoice),
    checkLineSum(invoice), checkVatMath(invoice), checkVatBases(invoice), checkTotal(invoice),
  ]
}

/** Lists the paths of the fields the page is looked at for: those that hold a value and are printed. */
export function expectedPaths(invoice: Invoice): string[] {
  return fieldPaths(invoice).filter(path => path !== 'document_type' && getField(invoice, path) !== null && getField(invoice, path) !== undefined)
}

/** Makes the `fields_on_page` warning: which values the invoice holds that no word of the page was found for. */
export function checkFieldsOnPage(invoice: Invoice, placed: ReadonlySet<string>, confirmed: ReadonlySet<string>): CheckResult {
  const expected = expectedPaths(invoice)
  if (expected.length === 0) return skipped('fields_on_page', 'The invoice holds no values to look for on the page.')
  const missing = expected.filter(path => !placed.has(path) && !confirmed.has(path))
  if (missing.length === 0) return passed('fields_on_page')
  return failed('fields_on_page', `${missing.length} of ${expected.length} values were not found among the words read from the page.`, missing, `${expected.length} values on the page`, `${expected.length - missing.length} found`, 'warning')
}

/** Tells whether any failed check is an error: such a document is not exported. */
export function blocksExport(checks: readonly CheckResult[]): boolean {
  return checks.some(check => check.status === 'failed' && check.severity === 'error')
}

/** What identifies an invoice: its vendor's key, its number's key and a hash of its content. */
export interface Identity {
  vendor: string
  number: string
  content: string
}

const LEGAL_FORMS = new Set(['sro', 'as', 'spol', 'gmbh', 'ltd', 'limited', 'inc', 'llc', 'srl', 'sl', 'bv', 'nv', 'co', 'corp', 'company', 'ag'])

/** Takes the accents off a text and lowers it. */
function plain(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

/** Reduces a number to letters and digits in lower case. */
export function numberKey(text: string): string {
  return plain(text).replace(/[^a-z0-9]+/g, '')
}

/** Reduces a vendor to its words without the legal forms that end a company's name. */
export function vendorKey(vendor: string): string {
  const words = plain(vendor.replaceAll('.', '')).match(/[a-z0-9]+/g) ?? []
  const kept = words.filter(word => !LEGAL_FORMS.has(word))
  return (kept.length > 0 ? kept : words).join('')
}

/** Hashes an invoice's amounts, dates and lines, as text that cannot differ by formatting. */
function contentHash(invoice: Invoice): string {
  const content = {
    type: invoice.documentType,
    issued: invoice.issueDate,
    currency: invoice.currency,
    subtotal: invoice.subtotal === null ? null : amountText(invoice.subtotal),
    total: invoice.total === null ? null : amountText(invoice.total),
    lines: invoice.lineItems.map(line => [numberKey(line.description), line.quantity === null ? null : quantityText(line.quantity), line.unitPrice === null ? null : amountText(line.unitPrice), line.total === null ? null : amountText(line.total)]),
    vat: invoice.vat.map(row => [row.rate === null ? null : quantityText(row.rate), row.base === null ? null : amountText(row.base), row.amount === null ? null : amountText(row.amount)]),
  }
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}

/** Returns an invoice's identity, or undefined when it has no vendor or number to be told apart by. */
export function identityOf(invoice: Invoice): Identity | undefined {
  if (!invoice.vendor || !invoice.invoiceNumber) return undefined
  const vendor = vendorKey(invoice.vendor)
  const number = numberKey(invoice.invoiceNumber)
  return vendor === '' || number === '' ? undefined : { vendor, number, content: contentHash(invoice) }
}

/** A document an upload is compared with: a document of the visitor's, or a sample (with the hash of its file). */
export interface Known {
  source: 'document' | 'sample'
  reference: string
  identity: Identity
  fileSha256?: string
}

/** The document an upload duplicates, and whether its content is the same as well. */
export interface Match {
  known: Known
  sameContent: boolean
}

/** Finds the document an invoice duplicates: the same vendor and number, an identical one in preference. A sample whose own file this is is not a candidate. */
export function findDuplicate(identity: Identity, known: readonly Known[], fileSha256?: string): Match | undefined {
  const candidates = known.filter(item => item.identity.vendor === identity.vendor && item.identity.number === identity.number && !(fileSha256 !== undefined && item.fileSha256 === fileSha256))
  const identical = candidates.find(item => item.identity.content === identity.content)
  if (identical) return { known: identical, sameContent: true }
  const first = candidates[0]
  return first ? { known: first, sameContent: false } : undefined
}

/** Makes the `not_duplicate` check's result. */
export function duplicateResult(identity: Identity | undefined, match: Match | undefined): CheckResult {
  if (identity === undefined) return skipped('not_duplicate', 'The document has no vendor or number to be told apart by.')
  if (match === undefined) return passed('not_duplicate', ['vendor', 'invoice_number'])
  const sameness = match.sameContent ? 'and the same content' : 'but different content'
  return failed('not_duplicate', `The same vendor and invoice number as ${match.known.source} ${match.known.reference}, ${sameness}.`, ['vendor', 'invoice_number'], 'a document not seen before', `${match.known.source} ${match.known.reference}`)
}

/** An account of the chart, and the rules that send a line to an expense account. */
export interface Chart {
  accounts: { code: string, name: string, kind: string }[]
  payable: string
  cash: string
  inputVat: string
  rounding: string
  defaultExpense: string
  rules: { account: string, keywords: string[] }[]
}

/** One line of a journal entry. */
export interface JournalLine {
  account: string
  name: string
  debit: Amount
  credit: Amount
  memo: string
}

/** A balanced entry. */
export interface Journal {
  date: string
  reference: string
  currency: string
  lines: JournalLine[]
}

/** Shares an amount among accounts in proportion to their weights, to the cent, the remainders going to the largest. */
function shareOut(total: Amount, weights: Map<string, Amount>): Map<string, Amount> | undefined {
  const weightSum = sum(weights.values())
  if (weightSum <= 0n) return undefined
  const shares = new Map<string, Amount>()
  const remainders: [string, Amount][] = []
  for (const [code, weight] of weights) {
    const exact = total * weight
    const floor = (exact / weightSum / CENT) * CENT
    shares.set(code, floor)
    remainders.push([code, exact - floor * weightSum])
  }
  let leftover = (total - sum(shares.values())) / CENT
  for (const [code] of remainders.toSorted((a, b) => (a[1] === b[1] ? 0 : a[1] < b[1] ? 1 : -1))) {
    if (leftover <= 0n) break
    shares.set(code, (shares.get(code) ?? 0n) + CENT)
    leftover -= 1n
  }
  return shares
}

/** Returns the expense account a line with this description is posted to. */
function expenseFor(chart: Chart, description: string): string {
  const text = description.toLowerCase()
  return chart.rules.find(rule => rule.keywords.some(keyword => text.includes(keyword)))?.account ?? chart.defaultExpense
}

/** Adds up the expenses by account: the lines' totals, or, when the prices hold VAT, their share of the net total. */
function expenseAmounts(invoice: Invoice, chart: Chart, vatTotal: Amount): Map<string, Amount> | undefined {
  const gross = new Map<string, Amount>()
  for (const line of invoice.lineItems) {
    if (line.total === null) return undefined
    const code = expenseFor(chart, line.description)
    gross.set(code, (gross.get(code) ?? 0n) + (line.total < 0n ? -line.total : line.total))
  }
  if (invoice.pricesIncludeVat) {
    if (invoice.total === null) return undefined
    return shareOut((invoice.total < 0n ? -invoice.total : invoice.total) - vatTotal, gross)
  }
  return new Map([...gross].map(([code, amount]) => [code, cents(amount)]))
}

/** Makes the balanced journal entry of a document that passed its checks, or undefined when its numbers can't balance. */
export function post(invoice: Invoice, chart: Chart): Journal | undefined {
  if (invoice.total === null || invoice.issueDate === null) return undefined
  const vatTotal = sum(invoice.vat.map(row => (row.amount === null ? 0n : row.amount < 0n ? -row.amount : row.amount)))
  const expenses = expenseAmounts(invoice, chart, vatTotal)
  if (expenses === undefined) return undefined
  const gross = cents(invoice.total < 0n ? -invoice.total : invoice.total)
  const difference = gross - sum(expenses.values()) - vatTotal
  if ((difference < 0n ? -difference : difference) > ONE_CENT_TOLERANCE) return undefined
  const reference = `${invoice.vendor ?? 'Unknown vendor'} ${invoice.invoiceNumber ?? ''}`.trim()
  const creditNote = invoice.documentType === 'credit_note'
  const owed = invoice.documentType === 'receipt' ? chart.cash : chart.payable
  const nameOf = (code: string): string => chart.accounts.find(account => account.code === code)?.name ?? code
  const lineOf = (code: string, amount: Amount, credit: boolean): JournalLine => ({ account: code, name: nameOf(code), debit: credit ? 0n : amount, credit: credit ? amount : 0n, memo: reference })
  const sides: [string, Amount][] = [...expenses].toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  if (vatTotal !== 0n) sides.push([chart.inputVat, vatTotal])
  const lines = sides.map(([code, amount]) => lineOf(code, amount, creditNote))
  if (difference !== 0n) lines.push(lineOf(chart.rounding, difference < 0n ? -difference : difference, creditNote !== (difference < 0n)))
  lines.push(lineOf(owed, gross, !creditNote))
  const entry: Journal = { date: invoice.issueDate, reference, currency: invoice.currency ?? '', lines }
  return sum(lines.map(line => line.debit)) === sum(lines.map(line => line.credit)) ? entry : undefined
}

/** Totals the two sides of a journal entry, as the API shows them. */
export function journalTotals(entry: Journal): { debit: Amount, credit: Amount } {
  return { debit: sum(entry.lines.map(line => line.debit)), credit: sum(entry.lines.map(line => line.credit)) }
}

/** Makes a cell of free text safe to open in a spreadsheet: control characters out, formulas turned into text. */
export function safeCell(text: string | null): string {
  if (!text) return ''
  const cleaned = [...text.replace(/[\r\n]+/g, ' ')].filter(character => /\P{C}/u.test(character) || character === '\t').join('')
  const leading = cleaned.trimStart().normalize('NFKC').slice(0, 1)
  return /^[=+\-@\t\r]/.test(cleaned) || ['=', '+', '-', '@'].includes(leading) ? `'${cleaned}` : cleaned
}

/** Writes one CSV cell, quoted when it needs to be. */
function cell(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** The byte order mark that tells a spreadsheet the file is UTF-8, written as a code rather than as an invisible character. */
const BYTE_ORDER_MARK = String.fromCharCode(0xFEFF)

/** Writes a CSV document with a byte order mark and CRLF lines: the header, then the rows. */
function writeCsv(header: readonly string[], rows: string[][]): string {
  return `${BYTE_ORDER_MARK}${[header, ...rows].map(row => row.map(cell).join(',')).join('\r\n')}\r\n`
}

/** Writes the document's line items as a CSV, one row each, with the document's header and totals on every row. */
export function linesCsv(invoice: Invoice): string {
  const vatTotal = sum(invoice.vat.map(row => row.amount ?? 0n))
  const header = ['vendor', 'invoice_number', 'document_type', 'issue_date', 'due_date', 'currency', 'line', 'description', 'quantity', 'unit_price', 'line_total', 'subtotal', 'vat_total', 'total']
  const rows = invoice.lineItems.map((line, index) => [
    safeCell(invoice.vendor), safeCell(invoice.invoiceNumber), invoice.documentType, invoice.issueDate ?? '', invoice.dueDate ?? '', invoice.currency ?? '', String(index + 1),
    safeCell(line.description), line.quantity === null ? '' : quantityText(line.quantity), line.unitPrice === null ? '' : amountText(line.unitPrice), line.total === null ? '' : amountText(line.total),
    invoice.subtotal === null ? '' : amountText(invoice.subtotal), invoice.vat.length > 0 ? amountText(vatTotal) : '', invoice.total === null ? '' : amountText(invoice.total),
  ])
  return writeCsv(header, rows)
}

/** Writes a journal entry as a CSV, one row per line, in the order of the entry. */
export function journalCsv(entry: Journal): string {
  const header = ['date', 'reference', 'account', 'account_name', 'debit', 'credit', 'currency', 'memo']
  const rows = entry.lines.map(line => [entry.date, safeCell(entry.reference), line.account, line.name, line.debit === 0n ? '' : amountText(line.debit), line.credit === 0n ? '' : amountText(line.credit), entry.currency, safeCell(line.memo)])
  return writeCsv(header, rows)
}

/** Reads the printed truth of a golden document (strings, as the YAML holds them) as an invoice. */
export function invoiceFromTruth(truth: Record<string, unknown>): Invoice {
  const amount = (value: unknown): Amount | null => (value === null || value === undefined ? null : parseAmount(String(value)) ?? null)
  const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))
  const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value as Record<string, unknown>[] : [])
  return {
    documentType: (DOCUMENT_TYPES.includes(String(truth.document_type)) ? truth.document_type : 'invoice') as DocumentType,
    vendor: text(truth.vendor),
    invoiceNumber: text(truth.invoice_number),
    issueDate: text(truth.issue_date),
    dueDate: text(truth.due_date),
    currency: text(truth.currency),
    pricesIncludeVat: typeof truth.prices_include_vat === 'boolean' ? truth.prices_include_vat : null,
    lineItems: rows(truth.line_items).slice(0, MAX_LINE_ITEMS).map(item => ({ description: text(item.description) ?? '', quantity: amount(item.quantity), unitPrice: amount(item.unit_price), total: amount(item.total) })),
    subtotal: amount(truth.subtotal),
    vat: rows(truth.vat).slice(0, MAX_VAT_LINES).map(item => ({ rate: amount(item.rate), base: amount(item.base), amount: amount(item.amount) })),
    total: amount(truth.total),
  }
}

/** Writes an invoice as the JSON the JSON export holds: every amount as text. */
export function invoiceJson(invoice: Invoice): Record<string, unknown> {
  const money = (value: Amount | null): string | null => (value === null ? null : amountText(value))
  return {
    document_type: invoice.documentType,
    vendor: invoice.vendor,
    invoice_number: invoice.invoiceNumber,
    issue_date: invoice.issueDate,
    due_date: invoice.dueDate,
    currency: invoice.currency,
    prices_include_vat: invoice.pricesIncludeVat,
    line_items: invoice.lineItems.map(line => ({ description: line.description, quantity: line.quantity === null ? null : quantityText(line.quantity), unit_price: money(line.unitPrice), total: money(line.total) })),
    subtotal: money(invoice.subtotal),
    vat: invoice.vat.map(row => ({ rate: row.rate === null ? null : quantityText(row.rate), base: money(row.base), amount: money(row.amount) })),
    total: money(invoice.total),
  }
}
