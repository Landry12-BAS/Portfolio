// The contract's text, folded once for every check that reads it. A quote is looked for on one page
// (a citation names a page), and a missing clause is looked for in the whole text, so both are
// kept: each page folded on its own, and the pages joined and folded together, so that a phrase
// split by a page break is still found.
import { foldText } from '@lb/contracts'
import type { FoldedText } from '@lb/contracts'

import type { PageInput } from './clauses.ts'

/** A page with its text folded for comparison. */
export interface SourcePage {
  page: number
  text: string
  folded: FoldedText
}

/** The whole contract, folded. */
export interface SourceIndex {
  pages: readonly SourcePage[]
  // The pages' text joined by line breaks, folded: what a phrase is looked for in when it may lie anywhere.
  whole: FoldedText
}

/** Folds each page of a contract, and all of them together. */
export function buildSourceIndex(pages: readonly PageInput[]): SourceIndex {
  return {
    pages: pages.map(page => ({ page: page.page, text: page.text, folded: foldText(page.text) })),
    whole: foldText(pages.map(page => page.text).join('\n')),
  }
}

/** Returns the text of a page, or an empty text when the page isn't there. */
export function pageText(index: SourceIndex, page: number): string {
  return index.pages.find(candidate => candidate.page === page)?.text ?? ''
}
