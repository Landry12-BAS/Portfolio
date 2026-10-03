// A small page-layout engine for the synthetic contracts (LB-04's seed data). It lays blocks of
// text out on A4 pages the way a contract is typeset (numbered headings, clauses with a hanging
// number, lettered items, tables, a running header and a page number), and draws them with
// pdf-lib's standard fonts, so no font file is embedded and the output is small and the same
// every time: the same blocks always give the same bytes, which is what lets `just check` tell
// when a committed contract is stale.
//
// Lines are placed one text run at a time, so the PDF's text items look like a real contract's: a
// clause number in bold followed by its text, a table row cut into cells, and long words broken
// with a hyphen at the end of a line, which the page text and the quote check have to put back
// together. Layout is a pure calculation (`layoutPages`) kept apart from drawing, so a document
// can be measured, and padded to an exact number of pages, without writing anything.
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import type { PDFFont } from 'pdf-lib'

/** The page, in points: A4. */
const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const MARGIN_LEFT = 72
const MARGIN_RIGHT = 72
const TEXT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT
// Where the body starts and stops, and where the running header and the page number sit.
const BODY_TOP = 772
const BODY_BOTTOM = 76
const HEADER_Y = 808
const FOOTER_Y = 44
const BODY_SIZE = 11
const LINE_HEIGHT = 16.5
const PARAGRAPH_GAP = 9
// Where a clause's text starts, to the right of its number, and an item's text to the right of its label.
const CLAUSE_INDENT = 36
const ITEM_LABEL_X = MARGIN_LEFT + CLAUSE_INDENT
const ITEM_TEXT_X = ITEM_LABEL_X + 22
// The shortest piece of a word left on a line or carried to the next when it is broken with a hyphen.
const MIN_BREAK_PART = 4
// A word is only broken when this many letters long, and when the line has this much room left.
const MIN_BREAKABLE_WORD = 10
const MIN_SLACK_POINTS = 18

/** One block of a contract. */
export type Block
  = | { type: 'title', text: string }
    | { type: 'centered', text: string, bold?: boolean, size?: number }
    | { type: 'heading', number: string, text: string }
    | { type: 'clause', number: string, text: string }
    | { type: 'item', label: string, text: string }
    | { type: 'paragraph', text: string, bold?: boolean }
    | { type: 'table', columns: readonly TableColumn[], rows: readonly (readonly string[])[] }
    | { type: 'signatures', left: readonly string[], right: readonly string[] }
    | { type: 'hidden', text: string }
    | { type: 'pagebreak' }

/** One column of a table: where it starts, what its header says, and whether its cells line up on the right. */
export interface TableColumn {
  header: string
  // Distance from the left margin, in points.
  x: number
  align?: 'left' | 'right'
}

/** What a document is made of, apart from its blocks: its title for the file's properties and for the running header. */
export interface DocumentSpec {
  title: string
  header: string
  author: string
  blocks: readonly Block[]
}

/** The fonts the layout measures with and the drawing uses. */
export interface Fonts {
  regular: PDFFont
  bold: PDFFont
}

/** One run of text at a place on a page. */
export interface PlacedText {
  text: string
  x: number
  y: number
  size: number
  bold: boolean
  // White, nearly invisible text: what a hostile document hides from the person reading and not from a program.
  hidden: boolean
}

/** Makes a document with the two fonts the layout needs. The document is only for measuring or drawing. */
export async function startDocument(): Promise<{ doc: PDFDocument, fonts: Fonts }> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  return { doc, fonts: { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) } }
}

/** The width of a text in a font, in points. */
function widthOf(text: string, font: PDFFont, size: number): number {
  return font.widthOfTextAtSize(text, size)
}

/** Tells whether a character is a vowel, for choosing where to break a long word. */
function isVowel(character: string): boolean {
  return 'aeiouy'.includes(character.toLowerCase())
}

/** Tells whether a character is a letter that is not a vowel. */
function isConsonant(character: string): boolean {
  return /^[a-z]$/i.test(character) && !isVowel(character)
}

// Pairs of letters that make one sound, which a break must not split.
const DIGRAPHS = new Set(['th', 'ch', 'sh', 'ph', 'ng', 'ck', 'gh', 'wh', 'qu'])

/** Scores a place to break a word: higher is better, 0 means not here. A break between two consonants that sit between vowels is best, then one before a single consonant. */
function breakScore(word: string, length: number): number {
  const before = word.charAt(length - 1)
  const after = word.charAt(length)
  if (DIGRAPHS.has(`${before}${after}`.toLowerCase())) return 0
  if (isConsonant(before) && isConsonant(after) && isVowel(word.charAt(length - 2)) && isVowel(word.charAt(length + 1))) return 3
  if (isVowel(before) && isConsonant(after) && isVowel(word.charAt(length + 1))) return 2
  return 0
}

/**
 * Finds where to break `word` so that its first part and a hyphen fit in `room` points. It breaks after
 * an existing hyphen when that fits, and otherwise at the best syllable-like place that fits. Returns the
 * length of the first part, or 0 when the word can't be broken.
 */
function breakPoint(word: string, font: PDFFont, size: number, room: number): number {
  if (word.length < MIN_BREAKABLE_WORD) return 0
  const hyphenAt = word.indexOf('-')
  if (hyphenAt >= MIN_BREAK_PART && widthOf(word.slice(0, hyphenAt + 1), font, size) <= room) return hyphenAt + 1
  let best = 0
  let bestScore = 0
  for (let length = MIN_BREAK_PART; length <= word.length - MIN_BREAK_PART; length += 1) {
    if (widthOf(`${word.slice(0, length)}-`, font, size) > room) break
    const score = breakScore(word, length)
    if (score >= bestScore && score > 0) {
      best = length
      bestScore = score
    }
  }
  return best
}

/** Splits a paragraph into lines no wider than `width`, breaking a long word with a hyphen when the line has room to spare. */
export function wrapLines(text: string, font: PDFFont, size: number, firstWidth: number, width: number): string[] {
  const lines: string[] = []
  let line = ''
  let limit = firstWidth
  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`
    if (widthOf(candidate, font, size) <= limit) {
      line = candidate
      continue
    }
    const room = limit - (line === '' ? 0 : widthOf(`${line} `, font, size))
    const cut = line === '' || room < MIN_SLACK_POINTS ? 0 : breakPoint(word, font, size, room)
    if (cut > 0) {
      const head = word.slice(0, cut)
      lines.push(`${line === '' ? '' : `${line} `}${head}${head.endsWith('-') ? '' : '-'}`)
      line = word.slice(cut)
    }
    else {
      if (line !== '') lines.push(line)
      line = word
    }
    limit = width
  }
  if (line !== '') lines.push(line)
  return lines
}

/** A page being filled: its runs of text and how far down the body the next line goes. */
class PageFill {
  readonly runs: PlacedText[] = []
  y = BODY_TOP
}

/** Lays blocks out page by page and keeps track of where the next line goes. */
class Layout {
  readonly pages: PageFill[] = [new PageFill()]
  readonly #fonts: Fonts

  constructor(fonts: Fonts) {
    this.#fonts = fonts
  }

  /** The page being filled. */
  get page(): PageFill {
    return this.pages[this.pages.length - 1] as PageFill
  }

  /** Starts a new page. */
  newPage(): void {
    this.pages.push(new PageFill())
  }

  /** Makes sure `height` points are left on the page, or starts a new one. */
  need(height: number): void {
    if (this.page.y - height < BODY_BOTTOM) this.newPage()
  }

  /** Places one run of text on the current page at the current line. */
  place(text: string, x: number, size = BODY_SIZE, bold = false): void {
    this.page.runs.push({ text, x, y: this.page.y, size, bold, hidden: false })
  }

  /** Moves down one line. */
  down(height = LINE_HEIGHT): void {
    this.page.y -= height
  }

  /** Places a block's lines, one after another, starting a new page when the current one is full. */
  lines(lines: readonly string[], x: number, bold = false, size = BODY_SIZE): void {
    for (const line of lines) {
      this.need(LINE_HEIGHT)
      this.place(line, x, size, bold)
      this.down()
    }
  }

  /** Lays out one block. */
  block(block: Block): void {
    const { regular, bold } = this.#fonts
    switch (block.type) {
      case 'title':
        this.need(60)
        this.page.y -= 24
        this.placeCentered(block.text, 18, true)
        this.down(30)
        return
      case 'centered':
        this.need(LINE_HEIGHT * 2)
        this.placeCentered(block.text, block.size ?? BODY_SIZE, block.bold ?? false)
        this.down(LINE_HEIGHT + 2)
        return
      case 'heading':
        this.need(LINE_HEIGHT * 4)
        this.down(8)
        this.place(`${block.number}. ${block.text}`, MARGIN_LEFT, 10.5, true)
        this.down(LINE_HEIGHT + 2)
        return
      case 'clause':
        this.clause(block.number, block.text)
        return
      case 'item':
        this.item(block.label, block.text)
        return
      case 'paragraph':
        this.lines(wrapLines(block.text, block.bold ? bold : regular, BODY_SIZE, TEXT_WIDTH, TEXT_WIDTH), MARGIN_LEFT, block.bold ?? false)
        this.down(PARAGRAPH_GAP)
        return
      case 'table':
        this.table(block.columns, block.rows)
        return
      case 'signatures':
        this.signatures(block.left, block.right)
        return
      case 'hidden':
        this.page.runs.push({ text: block.text, x: MARGIN_LEFT, y: 60, size: 2, bold: false, hidden: true })
        return
      case 'pagebreak':
        this.newPage()
    }
  }

  /** Centres a line of text on the page. */
  placeCentered(text: string, size: number, isBold: boolean): void {
    const font = isBold ? this.#fonts.bold : this.#fonts.regular
    this.place(text, (PAGE_WIDTH - widthOf(text, font, size)) / 2, size, isBold)
  }

  /** A clause: its number in bold at the margin, then its text, wrapped to a hanging indent. */
  clause(number: string, text: string): void {
    const lines = wrapLines(text, this.#fonts.regular, BODY_SIZE, TEXT_WIDTH - CLAUSE_INDENT, TEXT_WIDTH - CLAUSE_INDENT)
    this.need(LINE_HEIGHT * Math.min(lines.length, 2))
    this.place(number, MARGIN_LEFT, BODY_SIZE, true)
    lines.forEach((line, index) => {
      if (index > 0) this.need(LINE_HEIGHT)
      this.place(line, MARGIN_LEFT + CLAUSE_INDENT)
      this.down()
    })
    this.down(PARAGRAPH_GAP)
  }

  /** A lettered item under a clause. */
  item(label: string, text: string): void {
    const lines = wrapLines(text, this.#fonts.regular, BODY_SIZE, TEXT_WIDTH - (ITEM_TEXT_X - MARGIN_LEFT), TEXT_WIDTH - (ITEM_TEXT_X - MARGIN_LEFT))
    this.need(LINE_HEIGHT * Math.min(lines.length, 2))
    this.place(label, ITEM_LABEL_X)
    lines.forEach((line, index) => {
      if (index > 0) this.need(LINE_HEIGHT)
      this.place(line, ITEM_TEXT_X)
      this.down()
    })
    this.down(3)
  }

  /** A table: a bold header row, then each row cut into one run of text per cell. */
  table(columns: readonly TableColumn[], rows: readonly (readonly string[])[]): void {
    this.need(LINE_HEIGHT * 3)
    for (const column of columns) this.place(column.header, MARGIN_LEFT + column.x, BODY_SIZE, true)
    this.down(LINE_HEIGHT + 3)
    for (const row of rows) {
      this.need(LINE_HEIGHT)
      row.forEach((cell, index) => {
        const column = columns[index] as TableColumn
        const x = column.align === 'right' ? MARGIN_LEFT + column.x - widthOf(cell, this.#fonts.regular, BODY_SIZE) : MARGIN_LEFT + column.x
        this.place(cell, x)
      })
      this.down(LINE_HEIGHT)
    }
    this.down(PARAGRAPH_GAP)
  }

  /** Two columns of signature lines. */
  signatures(left: readonly string[], right: readonly string[]): void {
    this.need(LINE_HEIGHT * (Math.max(left.length, right.length) + 3))
    this.down(12)
    for (let row = 0; row < Math.max(left.length, right.length); row += 1) {
      const a = left[row]
      const b = right[row]
      if (a !== undefined) this.place(a, MARGIN_LEFT)
      if (b !== undefined) this.place(b, MARGIN_LEFT + TEXT_WIDTH / 2 + 10)
      this.down(LINE_HEIGHT + 8)
    }
  }
}

/** Lays a document's blocks out on pages, and returns the text runs of each page. The result is pure: the same blocks give the same pages. */
export function layoutPages(blocks: readonly Block[], fonts: Fonts): PlacedText[][] {
  const layout = new Layout(fonts)
  for (const block of blocks) layout.block(block)
  return layout.pages.map(page => page.runs)
}

/** Draws laid-out pages, with a running header from page two and "Page n of m" at the foot of every page, and returns the file's bytes. */
export async function drawDocument(spec: DocumentSpec, doc: PDFDocument, fonts: Fonts, pages: readonly (readonly PlacedText[])[]): Promise<Uint8Array> {
  const grey = rgb(0.38, 0.38, 0.38)
  const black = rgb(0.08, 0.08, 0.08)
  const white = rgb(1, 1, 1)
  pages.forEach((runs, index) => {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    for (const run of runs) {
      page.drawText(run.text, { x: run.x, y: run.y, size: run.size, font: run.bold ? fonts.bold : fonts.regular, color: run.hidden ? white : black })
    }
    if (index > 0) page.drawText(spec.header, { x: MARGIN_LEFT, y: HEADER_Y, size: 8, font: fonts.regular, color: grey })
    const footer = `Page ${index + 1} of ${pages.length}`
    page.drawText(footer, { x: (PAGE_WIDTH - widthOf(footer, fonts.regular, 8)) / 2, y: FOOTER_Y, size: 8, font: fonts.regular, color: grey })
  })
  doc.setTitle(spec.title)
  doc.setAuthor(spec.author)
  doc.setSubject('A synthetic contract for the Basalt & Bean Contract Radar demo. Every name in it is invented.')
  doc.setKeywords(['synthetic', 'contract', 'lb-04'])
  doc.setCreator('LB-04 seed generator')
  doc.setProducer('pdf-lib')
  doc.setCreationDate(new Date('2026-09-01T09:00:00Z'))
  doc.setModificationDate(new Date('2026-09-01T09:00:00Z'))
  return doc.save({ useObjectStreams: false })
}

/** Lays a document out and draws it: the bytes of its PDF. */
export async function renderDocument(spec: DocumentSpec): Promise<Uint8Array> {
  const { doc, fonts } = await startDocument()
  return drawDocument(spec, doc, fonts, layoutPages(spec.blocks, fonts))
}

/** How many pages a document of these blocks has, without drawing it. */
export async function countPages(blocks: readonly Block[]): Promise<number> {
  const { fonts } = await startDocument()
  return layoutPages(blocks, fonts).length
}
