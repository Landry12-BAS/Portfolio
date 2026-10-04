// What the board does with a citation, apart from drawing it: cutting a page's text into the stretches
// that are cited and the stretches that are not, so the page can be read as text with the cited
// characters marked; and saying whether the browser's reading of a page is the server's, which is the
// condition for drawing a highlight on the PDF at all. A citation is a page and a range of the text the
// server extracted, and the browser's pdf.js reads the same text with the same function; if it ever does
// not (another version, a font it reads differently), the highlight is left off that page, and the
// passage is still there as text, rather than drawn on characters that are not the ones the server checked.
import type { Lb04Citation, Lb04Finding } from '@lb/contracts'

/** A range of a page's text: `text.slice(start, end)`. */
export interface TextRange {
  start: number
  end: number
}

/** A stretch of a page's text, and whether a finding cites it. */
export interface Segment {
  text: string
  marked: boolean
}

/** Cuts a page's text at the edges of the ranges, which may overlap one another and may reach past the text. The segments, joined, are the text. */
export function segmentsOf(text: string, ranges: readonly TextRange[]): Segment[] {
  const sorted = ranges
    .map(range => ({ start: Math.max(0, Math.min(range.start, text.length)), end: Math.max(0, Math.min(range.end, text.length)) }))
    .filter(range => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: TextRange[] = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  const segments: Segment[] = []
  let at = 0
  for (const range of merged) {
    if (range.start > at) segments.push({ text: text.slice(at, range.start), marked: false })
    segments.push({ text: text.slice(range.start, range.end), marked: true })
    at = range.end
  }
  if (at < text.length) segments.push({ text: text.slice(at), marked: false })
  return segments
}

/** The citations of the risk findings that fall on one page. */
export function citationsOnPage(findings: readonly Lb04Finding[], page: number): Lb04Citation[] {
  return findings.flatMap(finding => (finding.kind === 'risk' && finding.citation.page === page ? [finding.citation] : []))
}

/** What the browser's reading of the pages came to, by page: `match` where it read the server's text exactly, `differs` where it did not. */
export type PageAgreement = 'match' | 'differs'

/** Tells whether the browser's text of a page is the server's, to the character. */
export function agreementOf(serverText: string | undefined, browserText: string | undefined): PageAgreement {
  return serverText !== undefined && browserText !== undefined && serverText === browserText ? 'match' : 'differs'
}
