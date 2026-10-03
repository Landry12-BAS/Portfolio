// Rendering HTML without ever building markup from a string that was not escaped: a tagged
// template whose interpolations are escaped unless they are already rendered markup. The shop
// echoes what a visitor typed (a coupon code, a checkout form) and what a cart holds, so every
// value passes through here.

/** Markup that has already been rendered and escaped, which the template inserts as it is. */
export class Markup {
  readonly text: string

  /** Wraps rendered markup. */
  constructor(text: string) {
    this.text = text
  }
}

/** Escapes text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&#39;')
}

/** Renders one interpolated value: markup as it is, lists joined, nothing for null, undefined and false, and escaped text for the rest. */
function renderValue(value: unknown): string {
  if (value instanceof Markup) return value.text
  if (Array.isArray(value)) return value.map(renderValue).join('')
  if (value === null || value === undefined || value === false) return ''
  return escapeHtml(String(value))
}

/** The template tag: `html\`<p>${name}</p>\`` escapes `name`; a nested `html` result is inserted as markup. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Markup {
  let out = ''
  strings.forEach((part, index) => {
    out += part
    if (index < values.length) out += renderValue(values[index])
  })
  return new Markup(out)
}
