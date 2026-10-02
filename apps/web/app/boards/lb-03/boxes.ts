// The arithmetic of showing a field's box on its page. A box comes as four corners, clockwise from the
// top left, each a share of the page's width and height, so it can be drawn over a picture of any size
// as an SVG whose view box is the page itself (0 to 1 on both sides). Boxes of a photograph are
// crooked, so a box is a polygon and not a rectangle. How sure the service is of a box comes as a
// number and a word (high, medium, low); the board always says it in words and never by colour alone,
// and draws each band with its own line so it can be told apart in black and white too.
import type { Box, Field } from './schemas'

/** How a band of confidence is drawn: a solid, a dashed or a dotted outline. */
export type BandLine = 'solid' | 'dashed' | 'dotted'

/** The outline each band is drawn with, so the band can be read without colour. */
export const BAND_LINES: Readonly<Record<Box['band'], BandLine>> = {
  high: 'solid',
  medium: 'dashed',
  low: 'dotted',
}

/** How many of the three meter segments a band fills: the same information as the word, as a shape. */
export const BAND_SEGMENTS: Readonly<Record<Box['band'], number>> = {
  high: 3,
  medium: 2,
  low: 1,
}

/** Keeps a corner on the page: a box that strays a little outside it is drawn clipped to the page. */
function onPage(value: number): number {
  return Math.min(Math.max(value, 0), 1)
}

/** Writes a box's corners as the `points` of an SVG polygon on a page that is 1 wide and 1 high. */
export function polygonPoints(quad: readonly number[]): string {
  const points: string[] = []
  for (let corner = 0; corner + 1 < quad.length; corner += 2) {
    points.push(`${onPage(quad[corner] ?? 0).toFixed(5)},${onPage(quad[corner + 1] ?? 0).toFixed(5)}`)
  }
  return points.join(' ')
}

/** A field that was found on a page, with where. */
export interface PlacedField {
  path: string
  box: Box
}

/** Lists the fields that were found on a page, in the order the service gave them. */
export function placedOnPage(fields: readonly Field[] | null, page: number): PlacedField[] {
  if (fields === null) return []
  return fields.flatMap(field => (field.box !== null && field.box.page === page ? [{ path: field.path, box: field.box }] : []))
}

/** Writes a confidence from 0 to 1 as a whole percentage, such as 97. */
export function confidencePercent(box: Box): number {
  return Math.round(box.confidence * 100)
}

/** Says how many pages a document shows: what the service counted, or one for a document it has not counted yet. */
export function pageCount(pages: number | null): number {
  return pages === null || pages < 1 ? 1 : pages
}

/** Keeps a page number between the first page and the last. */
export function clampPage(page: number, pages: number): number {
  return Math.min(Math.max(Math.trunc(page), 1), Math.max(pages, 1))
}
