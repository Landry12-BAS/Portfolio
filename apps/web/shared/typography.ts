// Typography helpers for the site's languages.

// A single-letter Czech word (the prepositions k, s, v, z and the conjunctions a, i, o, u)
// at the start of the text or after a space, an opening bracket or an opening quote.
const SINGLE_LETTER_WORD = /(?<=^|[\s(„])([aikosuvz]) /gi

/**
 * Joins each single-letter Czech word to the word after it with a non-breaking space, so
 * no line ends on "v" or "a". Czech typesetting requires it; the name comes from the
 * `vlna` tool that does the same for Czech TeX.
 */
export function vlna(text: string): string {
  return text.replace(SINGLE_LETTER_WORD, '$1\u00A0')
}

/** Applies `vlna` to every string in a nested object or array, keeping its shape. */
export function vlnaDeep<T>(value: T): T {
  if (typeof value === 'string') return vlna(value) as T
  if (Array.isArray(value)) return value.map(item => vlnaDeep(item)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, vlnaDeep(item)])) as T
  }
  return value
}
