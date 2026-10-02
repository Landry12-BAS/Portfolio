// The addresses LB-03's board puts in a page: the picture of a document's page, the files a visitor can
// download, and the files of the curated samples. A picture and a download are not calls the board makes
// with `fetch`: they are the address of an `<img>` or an `<a download>`, which the browser fetches with
// the visitor's session cookie like any page of the site, and the site's server forwards only the routes
// the back end documents, and passes a file on only if it is one of the media types the document lists.
// Every part of an address is checked or encoded here, so no text a document holds can change where it points.

/** The kinds of export the service makes: the invoice's lines, the journal entry, and the whole reading as JSON. */
export type ExportFormat = 'csv' | 'journal' | 'json'

/** What each export is called when it is saved, which is what the service names it (`Content-Disposition`). */
export const EXPORT_FILE_NAMES: Readonly<Record<ExportFormat, string>> = {
  csv: 'invoice-lines.csv',
  journal: 'journal-entry.csv',
  json: 'invoice.json',
}

// What a document's ID and a sample's name look like: plain word characters and dashes.
const SAFE_NAME = /^[\w-]{1,64}$/
// What a sample's file is called: word characters, dashes and dots.
const SAFE_FILE = /^\w[\w.-]{0,79}$/

/** Refuses a part of an address that is not a plain name, since an address is never built from anything else. */
function plain(name: string, pattern: RegExp): string {
  if (!pattern.test(name)) throw new Error('This is not a name the board puts in an address.')
  return name
}

/** The address of the picture of one page of a visitor's document, which the service draws and serves to its owner alone. */
export function pageUrl(documentId: string, page: number): string {
  return `/api/lb03/documents/${plain(documentId, SAFE_NAME)}/pages/${Math.trunc(page)}`
}

/** The address of the picture of one page of a sample, which a replay shows (it has no document at the service). */
export function samplePageUrl(sample: string, page: number): string {
  return `/lb03/pages/${plain(sample, SAFE_NAME)}-${Math.trunc(page)}.jpg`
}

/** The address of a sample's file, which the board sends as an upload when the visitor runs the sample live. */
export function sampleFileUrl(file: string): string {
  return `/lb03/samples/${plain(file, SAFE_FILE)}`
}

/** The address of an export of a visitor's document. */
export function exportUrl(documentId: string, format: ExportFormat): string {
  return `/api/lb03/documents/${plain(documentId, SAFE_NAME)}/export?format=${format}`
}
