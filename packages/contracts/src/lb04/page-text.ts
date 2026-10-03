// The text of a PDF page, and a table that maps any range of that text back to the pieces
// of the page it came from. This is the one place a page's text is made: the server's pdf.js
// (the legacy build, in a worker thread) and the browser's pdf.js (the viewer) both hand their
// text items to `buildPageText`, so for the same file they produce the same text, and a
// citation, `{ page, start, end }`, names the same characters on both sides. The server checks
// each quote against this text, and the viewer highlights exactly those characters.
//
// The module is pure: no pdf.js import, no Node API, no clock and no randomness. pdf.js is
// reached only through the small `TextContentSource` shape, so the function can be tested
// with hand-made items and run anywhere.

// pdf.js's own call for the text of a page, and the two options both sides must pass the same,
// since they change what the items hold (normalisation turns ligatures into letters).
/** The options both the server and the browser pass to pdf.js's `getTextContent`. */
export const PDF_TEXT_OPTIONS = { includeMarkedContent: false, disableNormalization: false } as const

/** What the text needs from a pdf.js page: its text content. Both pdf.js builds' page proxies have this method. */
export interface TextContentSource {
  getTextContent: (options: { includeMarkedContent: boolean, disableNormalization: boolean }) => Promise<{ items: readonly unknown[] }>
}

/** One piece of text pdf.js found on a page, reduced to the numbers the page's text needs. */
export interface PageItem {
  // The characters, as pdf.js read them. It may be empty: pdf.js uses an empty item to mark the end of a line.
  str: string
  // pdf.js's transform, six numbers: (e, f) is where the text's baseline starts, in page units, and (a, b) is its direction.
  transform: readonly number[]
  // How far the text runs along its baseline, and how tall its font is, in page units.
  width: number
  height: number
  // pdf.js's own mark that a line ends after this item.
  hasEOL: boolean
}

/** Where one item's characters lie in the page's text, and where the item sits on the page. */
export interface TextRun {
  // The item's index in the list `buildPageText` was given.
  item: number
  // The characters it contributes: `text.slice(start, end)`, the end excluded.
  start: number
  end: number
  // Where its baseline starts, in page units.
  x: number
  y: number
  // The baseline's direction, as a unit vector: (1, 0) for ordinary left-to-right text.
  dx: number
  dy: number
  // How far it runs along its baseline, and how tall its font is.
  width: number
  height: number
}

/** A page's text, and the table that says which item each stretch of it came from. */
export interface PageText {
  text: string
  runs: TextRun[]
  // True when the text was cut at `maxChars`: the rest of the page's items were not read.
  truncated: boolean
}

/** A rectangle on the page, in page units with the origin at the bottom left, as pdf.js reports them. */
export interface PageBox {
  left: number
  bottom: number
  right: number
  top: number
}

/** Choices for `buildPageText`. */
export interface BuildOptions {
  // Stop reading items once the text is this long, so a page crafted to hold millions of items costs a bounded amount.
  maxChars?: number
}

// A line is a new line when the baseline moves by more than this share of the taller font, so a superscript stays on its line.
const LINE_CHANGE = 0.5
// Two pieces on one line are separated by a space when the gap between them is wider than this share of the font's height.
const WORD_GAP = 0.25
// How far a font's letters reach below and above the baseline, as shares of its height, for the boxes the viewer draws.
const DESCENT = 0.22
const ASCENT = 0.82
// A transform that turns text further than this from horizontal is "turned", and then only pdf.js's own line marks count.
const TURNED = 0.5
// What the table of widths below gives a character it doesn't list.
const DEFAULT_WIDTH = 556

/**
 * Replaces what has no place in a stored, shown text, one character for one so no offset moves: a
 * control character or a bidirectional control becomes a space, and a lone surrogate becomes U+FFFD.
 */
function cleanText(text: string): string {
  let cleaned = ''
  for (const character of text.toWellFormed()) {
    const code = character.codePointAt(0) ?? 0
    const isControl = code < 0x20 || (code >= 0x7F && code <= 0x9F)
    const isBidi = (code >= 0x202A && code <= 0x202E) || (code >= 0x2066 && code <= 0x2069)
    cleaned += isControl || isBidi ? ' ' : character
  }
  return cleaned
}

/** Returns a number when it is finite, and zero otherwise, so one hostile figure can't spread through the boxes. */
function finiteOr0(value: number): number {
  return Number.isFinite(value) ? value : 0
}

/** The item's baseline start, direction and size, with every figure made finite. */
function placement(item: PageItem): Omit<TextRun, 'item' | 'start' | 'end'> {
  const [a = 1, b = 0, , , e = 0, f = 0] = item.transform
  const length = Math.hypot(finiteOr0(a), finiteOr0(b))
  const unit = length > 0 ? { dx: finiteOr0(a) / length, dy: finiteOr0(b) / length } : { dx: 1, dy: 0 }
  return { x: finiteOr0(e), y: finiteOr0(f), ...unit, width: Math.max(0, finiteOr0(item.width)), height: Math.max(0, finiteOr0(item.height)) }
}

/** Tells whether text runs more or less sideways, where a change of baseline says nothing about lines. */
function isTurned(run: Pick<TextRun, 'dx' | 'dy'>): boolean {
  return Math.abs(run.dy) > TURNED
}

/** The distance from the previous run's baseline to this one's, across the line (zero for turned text, which has no usable lines). */
function lineShift(previous: TextRun, current: TextRun): number {
  return isTurned(previous) || isTurned(current) ? 0 : Math.abs(current.y - previous.y)
}

/** Tells whether the current run starts a new line: pdf.js said so, or the baseline moved more than a line's share of the font. */
function startsLine(previous: TextRun, current: TextRun, breakPending: boolean): boolean {
  if (breakPending) return true
  const tallest = Math.max(previous.height, current.height, 1)
  return lineShift(previous, current) > LINE_CHANGE * tallest
}

/** Tells whether the current run starts a new word on the same line: there is a gap wider than a space between it and the previous run. */
function startsWord(previous: TextRun, current: TextRun): boolean {
  if (isTurned(previous) || isTurned(current)) return false
  const gap = current.x - (previous.x + previous.width)
  return gap > WORD_GAP * Math.max(current.height, 1)
}

// One character that is white space.
const WHITESPACE = /^\s$/u

/**
 * Chooses what goes between two pieces of text: a line break, a space, or nothing at all.
 * `last` is the last character of the text so far and `first` the first of the next piece:
 * a space already there is not doubled.
 */
function separator(previous: TextRun, current: TextRun, breakPending: boolean, last: string, first: string): string {
  if (startsLine(previous, current, breakPending)) return '\n'
  const alreadySpaced = WHITESPACE.test(last) || WHITESPACE.test(first)
  return startsWord(previous, current) && !alreadySpaced ? ' ' : ''
}

/**
 * Makes a page's text from the items pdf.js found, in the order it found them, and the table that
 * maps each stretch of the text back to its item. Items are joined by what the page shows between
 * them: a line break where pdf.js marked one or the baseline moved, a space where a gap is wide
 * enough for one, and nothing where letters touch. The text has no leading or trailing separator.
 */
export function buildPageText(items: readonly PageItem[], options: BuildOptions = {}): PageText {
  const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY
  let text = ''
  const runs: TextRun[] = []
  let previous: TextRun | undefined
  let breakPending = false
  let truncated = false
  for (const [index, item] of items.entries()) {
    const characters = cleanText(item.str)
    if (characters.length === 0) {
      breakPending ||= item.hasEOL
      continue
    }
    const place = placement(item)
    const gap = previous === undefined ? '' : separator(previous, { item: index, start: 0, end: 0, ...place }, breakPending, text.at(-1) ?? '', characters.at(0) ?? '')
    if (text.length + gap.length + characters.length > maxChars) {
      truncated = true
      break
    }
    text += gap
    const run: TextRun = { item: index, start: text.length, end: text.length + characters.length, ...place }
    text += characters
    runs.push(run)
    previous = run
    breakPending = item.hasEOL
  }
  return { text, runs, truncated }
}

// The widths of Helvetica's characters, per thousand of the font size, which is what the
// viewer needs to place the edge of a highlight inside a run: the item says how wide the whole
// run is, and these say how that width divides between its letters. Grouped by width.
const WIDTH_GROUPS: readonly (readonly [number, string])[] = [
  [191, '\''], [222, 'ijl‘’'], [260, '|'], [278, ' !,./:;I[\\]ft'], [333, '()-`r“”'], [334, '{}'], [355, '"'], [389, '*'],
  [469, '^'], [500, 'Jckszvxy'], [556, '0123456789#$?_abdeghnopquL–§€'], [584, '+<=>~'], [611, 'FTZ'],
  [667, 'ABEKPSVXY&'], [722, 'CDHNRUw'], [778, 'GOQ'], [833, 'Mm'], [889, '%'], [944, 'W'], [1000, '—'], [1015, '@'],
]

const WIDTHS: ReadonlyMap<string, number> = new Map(WIDTH_GROUPS.flatMap(([width, characters]) => [...characters].map(character => [character, width] as const)))

/** Returns the share of a run's width that lies before character number `offset` of its `length` characters, weighted by how wide each letter is. */
function widthBefore(characters: readonly string[], offset: number): number {
  let before = 0
  let total = 0
  for (const [position, character] of characters.entries()) {
    const width = WIDTHS.get(character) ?? DEFAULT_WIDTH
    if (position < offset) before += width
    total += width
  }
  return total === 0 ? 0 : before / total
}

/** The rectangle around a stretch of one run, from `from` to `to` (shares of its width), as the smallest upright box that holds it. */
function boxOfStretch(run: TextRun, from: number, to: number): PageBox {
  const upX = -run.dy
  const upY = run.dx
  const start = run.width * from
  const end = run.width * to
  const low = -DESCENT * run.height
  const high = ASCENT * run.height
  const corners = [
    [start, low], [end, low], [end, high], [start, high],
  ] as const
  const xs = corners.map(([along, up]) => run.x + run.dx * along + upX * up)
  const ys = corners.map(([along, up]) => run.y + run.dy * along + upY * up)
  return { left: Math.min(...xs), bottom: Math.min(...ys), right: Math.max(...xs), top: Math.max(...ys) }
}

/** Joins two boxes that sit side by side on one line, when the gap between them is smaller than a letter. */
function joinable(first: PageBox, second: PageBox): boolean {
  const height = Math.max(first.top - first.bottom, second.top - second.bottom, 1)
  const overlap = Math.min(first.top, second.top) - Math.max(first.bottom, second.bottom)
  return overlap > 0.5 * height && second.left - first.right < 0.5 * height && second.left >= first.left
}

/** The smallest box that holds both boxes. */
function union(first: PageBox, second: PageBox): PageBox {
  return { left: Math.min(first.left, second.left), bottom: Math.min(first.bottom, second.bottom), right: Math.max(first.right, second.right), top: Math.max(first.top, second.top) }
}

/**
 * The boxes that cover the characters from `start` to `end` of a page's text: one for each line the
 * range touches, in reading order. Inside an item the edge of a box is worked out from the widths of
 * Helvetica's letters, so it is close to the letter and not exact; the characters themselves are exact.
 */
export function boxesForRange(page: PageText, start: number, end: number): PageBox[] {
  const boxes: PageBox[] = []
  for (const run of page.runs) {
    const from = Math.max(start, run.start)
    const to = Math.min(end, run.end)
    if (from >= to) continue
    const characters = [...page.text.slice(run.start, run.end)]
    const box = boxOfStretch(run, widthBefore(characters, [...page.text.slice(run.start, from)].length), widthBefore(characters, [...page.text.slice(run.start, to)].length))
    const last = boxes.at(-1)
    if (last !== undefined && joinable(last, box)) boxes[boxes.length - 1] = union(last, box)
    else boxes.push(box)
  }
  return boxes
}

/** Tells whether something pdf.js returned is a piece of text with the numbers a `PageItem` needs (marked-content markers are not). */
export function isPageItem(value: unknown): value is PageItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.str === 'string'
    && Array.isArray(item.transform) && item.transform.length === 6 && item.transform.every(number => typeof number === 'number')
    && typeof item.width === 'number' && typeof item.height === 'number'
    && typeof item.hasEOL === 'boolean'
}

/**
 * Reads one page's text through pdf.js and builds its text and table. The server's extraction, the
 * mock back end and the browser's viewer all call this, with the same options, so for one file they
 * get the same text.
 */
export async function extractPageText(page: TextContentSource, options: BuildOptions = {}): Promise<PageText> {
  const content = await page.getTextContent({ ...PDF_TEXT_OPTIONS })
  return buildPageText(content.items.filter(isPageItem), options)
}
