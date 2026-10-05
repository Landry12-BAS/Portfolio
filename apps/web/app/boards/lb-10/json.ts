// Showing a reply that is JSON so a person can read it, without changing what the model wrote. A reply is graded
// as it is, so the board must not show a tidier one: parsing JSON and writing it again can change it (a number
// written as 1.0 comes back as 1, an escaped letter comes back as the letter, a key written twice keeps one value).
// So the board never writes a reply again from its parsed value. It re-indents the text itself: every string,
// number and word is copied exactly as written, and only the spaces and line breaks between them are changed. A
// reply is re-indented only when it is one valid JSON document; anything else (prose, a fence around the JSON, JSON
// with text after it) is shown exactly as written, and the page says which it did.

// How deep a reply may nest before the board stops re-indenting it and shows it as written.
const MAX_DEPTH = 64
// The indent of one level.
const INDENT = '  '

/** Tells whether a text is one valid JSON document, which is the only text the board re-indents. */
function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  }
  catch {
    return false
  }
}

/** Reads a string token from its opening quote, escapes and all, and returns where it ends. */
function stringEnd(text: string, start: number): number {
  let index = start + 1
  while (index < text.length) {
    const character = text[index]
    if (character === '\\') index += 2
    else if (character === '"') return index + 1
    else index += 1
  }
  return text.length
}

/** Starts a new line at a depth. */
function newLine(depth: number): string {
  return `\n${INDENT.repeat(depth)}`
}

/**
 * Re-indents a JSON document two spaces a level, keeping every token exactly as written; returns undefined for a
 * text that is not one valid JSON document, or that nests deeper than the board will follow. An empty object or
 * list stays on one line.
 */
export function reindentJson(text: string): string | undefined {
  const source = text.trim()
  if (!isJson(source) || (!source.startsWith('{') && !source.startsWith('['))) return undefined
  let out = ''
  let depth = 0
  let index = 0
  while (index < source.length) {
    const character = source[index] ?? ''
    if (character === '"') {
      const end = stringEnd(source, index)
      out += source.slice(index, end)
      index = end
      continue
    }
    if (/\s/.test(character)) {
      index += 1
      continue
    }
    if (character === '{' || character === '[') {
      const closing = character === '{' ? '}' : ']'
      const next = source.slice(index + 1).trimStart()[0]
      if (next === closing) {
        out += `${character}${closing}`
        index = source.indexOf(closing, index + 1) + 1
        continue
      }
      depth += 1
      if (depth > MAX_DEPTH) return undefined
      out += character + newLine(depth)
    }
    else if (character === '}' || character === ']') {
      depth -= 1
      out += newLine(depth) + character
    }
    else if (character === ',') {
      out += `,${newLine(depth)}`
    }
    else if (character === ':') {
      out += ': '
    }
    else {
      out += character
    }
    index += 1
  }
  return out
}

/** How a reply is shown: re-indented when it is JSON, or as written. */
export interface ShownReply {
  text: string
  reindented: boolean
}

/** Picks how to show a reply: re-indented when it is one JSON document, as written otherwise. */
export function showReply(output: string): ShownReply {
  const reindented = reindentJson(output)
  return reindented === undefined ? { text: output, reindented: false } : { text: reindented, reindented: true }
}
