// Text from outside the board made safe to put on a drawing. A chart's titles and labels come from
// the names of a query's columns and the values in its cells, and are drawn on a canvas, which does
// not read markup; this still removes what has no business in a label: control characters, which could
// start a new line or ring a bell, and the invisible marks that reorder text from left to right to the
// reverse (they are how a label can be made to read as something other than what is in it).

// Every character of Unicode's "Other" categories (control, format, surrogate, private use, unassigned),
// which include the bidirectional marks and the zero-width characters, and the line and paragraph separators.
const NOT_PRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/gu

/** Replaces what cannot be shown in a label with a space, squeezes runs of spaces and trims the ends. */
export function plainText(text: string): string {
  return text.replace(NOT_PRINTABLE, ' ').replace(/ {2,}/g, ' ').trim()
}
