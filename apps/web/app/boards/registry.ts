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
  'lb-05': async () => (await import('./lb-05/Lb05Board.vue')).default,
}

/** Tells whether a system has an evaluation board. */
export function hasBoard(slug: string): boolean {
  return Object.hasOwn(BOARDS, slug)
}

/** Returns the loader for a system's board, or undefined when it has none. */
export function boardLoader(slug: string): BoardLoader | undefined {
  return hasBoard(slug) ? BOARDS[slug] : undefined
}
