// Splitting a contract into clauses, in plain code and with no model. Clauses are found by their
// numbers and headings ("9.", "9.2", "Article 9", "Schedule 1", an all-capitals heading), and a
// number counts only when it follows the one before it (9.2 after 9.1, 10 after 9.4), so a
// line that happens to begin with a figure ("30 days after...") is not mistaken for a clause.
//
// The clauses are what the model reads, in order and with their numbers, and what a finding's
// clause number is worked out from: the number is looked up from where the quote was found, so a
// model can't give a finding a clause it doesn't belong to. Every clause lies inside one page,
// so a citation inside it is a citation on that page: a clause that runs over a page break is
// two clauses with the same number.
//
// A contract without usable numbering is cut into pieces of a page's lines, so the model still
// reads it in order.
import { foldQuote } from '@lb/contracts'

/** A page of a contract: its number (from 1) and its text, as the extraction made it. */
export interface PageInput {
  page: number
  text: string
}

/** One clause, or the part of it that lies on one page. */
export interface Clause {
  // `k1`, `k2`, ... in the order the clauses come.
  id: string
  // The number as printed ("9.2", or "Schedule 1"); null for text before the first heading and for pieces of an unnumbered contract.
  number: string | null
  // The heading of the article it belongs to ("TERMINATION"), when there is one.
  heading: string | null
  // True when this is the rest of a clause that began on an earlier page.
  continued: boolean
  page: number
  // Where it lies in the page's text: `text.slice(start, end)`.
  start: number
  end: number
  text: string
}

/** A line of a page, with where it lies in the page's text. */
interface Line {
  page: number
  start: number
  end: number
  text: string
}

/** Where the splitter is in a contract: the number it has reached (as a list, [9, 2] for 9.2), the label to print and the heading it is under. */
interface Position {
  parts: number[]
  label: string | null
  heading: string | null
  // The number of the last schedule seen, so the next one must be the one after it.
  schedule: number
}

/** What a line starts, when it starts a clause. */
interface Start {
  // The numbers of a numbered clause; empty for a schedule or a heading.
  parts: number[]
  // The label to print: "9.2", "Schedule 1", or null for a heading with no number.
  label: string | null
  heading: string | null
  // The number of a schedule, or 0.
  schedule: number
}

/** The clause being built. */
interface OpenClause {
  page: number
  start: number
  end: number
  number: string | null
  heading: string | null
  continued: boolean
}

// The most characters of a piece when a contract has no numbering to split by.
const PIECE_CHARS = 1_400
// A contract needs this many numbered clauses before its numbering is believed.
const MIN_NUMBERED = 3

// A page number on its own: "7", "Page 7", "Page 7 of 30", "7 / 30".
const PAGE_NUMBER = /^(?:page\s+)?\d{1,3}(?:\s*(?:of|\/)\s*\d{1,3})?$/i
// "9." followed by text: a top-level clause. The full stop is required, so "1 October" is a date and not a clause.
// The patterns match only the number, and what follows it is read from the rest of the line.
const TOP_LEVEL = /^(\d{1,2})\.\s+(?=\S)/
// "9.2" and "9.2.1" followed by text: a sub-clause.
const SUB_CLAUSE = /^(\d{1,2}(?:\.\d{1,3}){1,3})\.?\s+(?=\S)/
// "Article 9", "Section 9.2", "Clause 9".
const NAMED = /^(?:article|section|clause)\s+(\d{1,2}(?:\.\d{1,3}){0,2})\b/i
// The marks between a clause's name and its title: "Article 9 - Payment", "Section 9: Payment".
const LEADING_MARKS = /^[.:\s-]+/
// "Schedule 1", "Annex 2", "Appendix 3" followed by nothing, or by a title that starts with a capital letter or a figure.
const SCHEDULE = /^(?:[Ss]chedule|[Aa]nnex|[Aa]ppendix|[Ee]xhibit|SCHEDULE|ANNEX|APPENDIX|EXHIBIT)\s+(\d{1,2})\b[.:\s-]*([A-Z0-9].*)?$/

/** Splits a page's text into lines, each with where it lies in the text. */
function linesOf(page: PageInput): Line[] {
  const lines: Line[] = []
  let offset = 0
  for (const text of page.text.split('\n')) {
    lines.push({ page: page.page, start: offset, end: offset + text.length, text })
    offset += text.length + 1
  }
  return lines
}

/** Names a line by its page and where it starts, so it can be put in a set. */
function lineKey(line: Line): string {
  return `${line.page}:${line.start}`
}

/** The first two and the last two lines of a page: where a running header, a footer and a page number sit. */
function edgeLines(lines: readonly Line[]): Line[] {
  return [...new Set([...lines.slice(0, 2), ...lines.slice(-2)])]
}

/**
 * Finds the lines that are not clauses: page numbers, and lines that begin or end many pages
 * (a running header or footer). They stay in the pages' text, so every offset is still right, but
 * they are left out of the clauses.
 */
function furnitureOf(pages: readonly (readonly Line[])[]): Set<string> {
  const furniture = new Set<string>()
  const edges = new Map<string, number>()
  for (const lines of pages) {
    for (const line of edgeLines(lines)) {
      if (PAGE_NUMBER.test(line.text.trim())) furniture.add(lineKey(line))
      const key = foldQuote(line.text)
      if (key.length > 0) edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }
  // A line that sits at the edge of at least this many pages is furniture. Fewer than three is chance, in a short contract.
  const threshold = Math.max(3, Math.ceil(pages.length * 0.4))
  for (const lines of pages) {
    for (const line of edgeLines(lines)) {
      if ((edges.get(foldQuote(line.text)) ?? 0) >= threshold) furniture.add(lineKey(line))
    }
  }
  return furniture
}

/** Reads the number of a label such as "9.2" as a list: [9, 2]. */
function partsOf(label: string): number[] {
  return label.split('.').map(Number)
}

/** Tells whether two lists of numbers are equal over their first `length` entries. */
function samePrefix(a: readonly number[], b: readonly number[], length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

/**
 * Tells whether a number follows the one the splitter is at: the next sibling (9.3 after 9.2), the
 * first child (9.1 after 9), or the next sibling of an ancestor (10 after 9.4). Anything else is
 * not the next clause, whatever it looks like.
 */
function followsOn(next: readonly number[], current: readonly number[]): boolean {
  const last = next[next.length - 1] ?? 0
  if (current.length === 0) return next.length === 1 && last <= 2
  if (next.length === current.length + 1) return samePrefix(next, current, current.length) && last === 1
  if (next.length <= current.length) {
    const level = next.length - 1
    return samePrefix(next, current, level) && last === (current[level] ?? 0) + 1
  }
  return false
}

/** Tells whether a line is a heading in capital letters: at least three letters, short, and no small letters. */
function isCapitalHeading(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 3 || trimmed.length > 70 || PAGE_NUMBER.test(trimmed)) return false
  const letters = trimmed.replaceAll(/[^a-z]/gi, '')
  return letters.length >= 3 && letters === letters.toUpperCase()
}

/** Reads a line as the start of a numbered clause, or returns undefined when it is not one that follows the numbering so far. */
function numberedStart(text: string, at: Position): Start | undefined {
  const match = SUB_CLAUSE.exec(text) ?? TOP_LEVEL.exec(text) ?? NAMED.exec(text)
  if (!match) return undefined
  const label = match[1] as string
  const parts = partsOf(label)
  if (!followsOn(parts, at.parts)) return undefined
  const rest = text.slice(match[0].length).replace(LEADING_MARKS, '').trim()
  return { parts, label, heading: parts.length === 1 && isCapitalHeading(rest) ? rest : null, schedule: 0 }
}

/** Reads a line as the start of the next schedule, or returns undefined. */
function scheduleStart(text: string, at: Position): Start | undefined {
  const match = SCHEDULE.exec(text)
  if (!match || Number(match[1]) !== at.schedule + 1) return undefined
  const word = text.split(/\s+/)[0] as string
  const label = `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()} ${match[1] as string}`
  return { parts: [], label, heading: (match[2] ?? '').trim() || null, schedule: Number(match[1]) }
}

/** Reads a line in capital letters as a heading with no number. */
function capitalStart(text: string): Start | undefined {
  return isCapitalHeading(text) ? { parts: [], label: null, heading: text, schedule: 0 } : undefined
}

/** Works out where the splitter is after a line that starts a clause. */
function positionAfter(start: Start, at: Position): Position {
  if (start.schedule > 0) return { parts: [], label: start.label, heading: start.heading, schedule: start.schedule }
  if (start.label === null) return { parts: at.parts, label: null, heading: start.heading, schedule: at.schedule }
  return { parts: start.parts, label: start.label, heading: start.heading ?? (start.parts.length > 1 ? at.heading : null), schedule: at.schedule }
}

/** Splits the lines of a contract by their numbers and headings into clauses, each inside one page. */
function splitByNumbers(lines: readonly Line[], furniture: ReadonlySet<string>, texts: ReadonlyMap<number, string>): Clause[] {
  const clauses: Clause[] = []
  let at: Position = { parts: [], label: null, heading: null, schedule: 0 }
  let open: OpenClause | undefined
  let seenText = false

  /** Closes the clause being built, if any, and adds it. */
  const close = (): void => {
    if (!open) return
    clauses.push({ id: `k${clauses.length + 1}`, number: open.number, heading: open.heading, continued: open.continued, page: open.page, start: open.start, end: open.end, text: (texts.get(open.page) ?? '').slice(open.start, open.end) })
    open = undefined
  }

  for (const line of lines) {
    const trimmed = line.text.trim()
    if (furniture.has(lineKey(line)) || trimmed === '') continue
    const started = scheduleStart(trimmed, at) ?? numberedStart(trimmed, at) ?? capitalStart(trimmed)
    if (started) {
      close()
      at = positionAfter(started, at)
      open = { page: line.page, start: line.start, end: line.end, number: at.label, heading: at.heading, continued: false }
    }
    else if (open?.page === line.page) {
      open.end = line.end
    }
    else {
      // The first text of a page, with a clause still open from an earlier one: the rest of that clause.
      close()
      open = { page: line.page, start: line.start, end: line.end, number: at.label, heading: at.heading, continued: seenText }
    }
    seenText = true
  }
  close()
  return clauses
}

/** Cuts a contract with no usable numbering into pieces of about a thousand characters, at the ends of lines, each inside one page. */
function splitIntoPieces(lines: readonly Line[], furniture: ReadonlySet<string>, texts: ReadonlyMap<number, string>): Clause[] {
  const clauses: Clause[] = []
  let open: { page: number, start: number, end: number } | undefined
  const close = (): void => {
    if (!open) return
    clauses.push({ id: `k${clauses.length + 1}`, number: null, heading: null, continued: false, page: open.page, start: open.start, end: open.end, text: (texts.get(open.page) ?? '').slice(open.start, open.end) })
    open = undefined
  }
  for (const line of lines) {
    if (furniture.has(lineKey(line)) || line.text.trim() === '') continue
    if (open && (open.page !== line.page || line.end - open.start > PIECE_CHARS)) close()
    if (open) open.end = line.end
    else open = { page: line.page, start: line.start, end: line.end }
  }
  close()
  return clauses
}

/**
 * Splits a contract into clauses, in document order. Page numbers and running headers are left out
 * of the clauses (but stay in the pages' text). A contract whose numbering can't be followed is cut
 * into pieces instead, with no numbers, so nothing a model reads is out of order.
 */
export function splitClauses(pages: readonly PageInput[]): Clause[] {
  const byPage = pages.map(linesOf)
  const furniture = furnitureOf(byPage)
  const lines = byPage.flat()
  const texts = new Map(pages.map(page => [page.page, page.text] as const))
  const clauses = splitByNumbers(lines, furniture, texts)
  const numbered = clauses.filter(clause => clause.number !== null && !clause.continued).length
  return numbered >= MIN_NUMBERED ? clauses : splitIntoPieces(lines, furniture, texts)
}

/** Returns the clause that holds a place in a page's text, or undefined when none does. */
export function clauseAt(clauses: readonly Clause[], page: number, offset: number): Clause | undefined {
  return clauses.find(clause => clause.page === page && offset >= clause.start && offset < clause.end)
}
