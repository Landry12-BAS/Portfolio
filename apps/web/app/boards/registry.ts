// The systems that have an evaluation board, and how to load each one. A board is one folder under
// `app/boards/` with a board component (`Lb01Board.vue`), and it is listed here, which is the only place that says a
// system has a board: the datasheet shows its "open the evaluation board" link and the board
// page (/systems/<slug>/board) renders it only for a system listed here. A board is loaded on
// demand, so a visitor who reads the catalog never downloads a demo. The recipe for adding the
// next one is in apps/web/README.md.
import type { Component } from 'vue'

/** Loads a board's component. */
export type BoardLoader = () => Promise<Component>

// Keyed by the system's slug, the part number in lower case.
const BOARDS: Readonly<Record<string, BoardLoader>> = {
  'lb-01': async () => (await import('./lb-01/Lb01Board.vue')).default,
  'lb-02': async () => (await import('./lb-02/Lb02Board.vue')).default,
  'lb-05': async () => (await import('./lb-05/Lb05Board.vue')).default,
  'lb-08': async () => (await import('./lb-08/Lb08Board.vue')).default,
  'lb-03': async () => (await import('./lb-03/Lb03Board.vue')).default,
  'lb-04': async () => (await import('./lb-04/Lb04Board.vue')).default,
  'lb-06': async () => (await import('./lb-06/Lb06Board.vue')).default,
  'lb-07': async () => (await import('./lb-07/Lb07Board.vue')).default,
}

// What a board adds to the head of its page, by the system's slug and the language: today the web app
// manifest of the one board that can be installed (public/lb02.<language>.webmanifest, generated).
const BOARD_LINKS: Readonly<Record<string, (code: 'en' | 'cs') => BoardLink[]>> = {
  'lb-02': code => [{ rel: 'manifest', href: `/lb02.${code}.webmanifest` }],
}

/** A link a board adds to its page's head. A type alias, not an interface, so it fits the head's link type with its `data-` attributes. */
export type BoardLink = {
  rel: 'manifest'
  href: string
}

/** Tells whether a system has an evaluation board. */
export function hasBoard(slug: string): boolean {
  return Object.hasOwn(BOARDS, slug)
}

/** Returns the links a system's board adds to its page's head in a language: none for most boards. */
export function boardLinks(slug: string, code: 'en' | 'cs'): BoardLink[] {
  return Object.hasOwn(BOARD_LINKS, slug) ? (BOARD_LINKS[slug]?.(code) ?? []) : []
}

/** Returns the loader for a system's board, or undefined when it has none. */
export function boardLoader(slug: string): BoardLoader | undefined {
  return hasBoard(slug) ? BOARDS[slug] : undefined
}
