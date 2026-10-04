// LB-04 Contract Radar's shared code: the limits and closed lists, the one function that makes a
// PDF page's text and its offset table, the folding that makes a quote comparable to it, and the
// API's schemas. The service and the board both import this folder, so a citation means the same
// characters on both sides.
export * from './api.ts'
export * from './fold.ts'
export * from './limits.ts'
export * from './page-text.ts'
