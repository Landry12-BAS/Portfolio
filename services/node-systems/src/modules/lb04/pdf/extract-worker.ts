// The worker thread that opens a visitor's PDF. A PDF is untrusted, complicated input, so it is
// opened here, in a thread of its own that the service gives a memory limit and a time limit and
// kills when either runs out (extract.ts), and with pdf.js set to do as little as it can:
//
//   - no scripts and no XFA forms (`enableXfa: false`; this pdf.js has no eval to switch off),
//   - no fonts: no system fonts, no font faces, no font data (`useSystemFonts`, `disableFontFace`),
//   - no network (`useWorkerFetch: false`), no WebAssembly image decoders (`useWasm: false`), and
//   - no rendering at all: it reads text, never draws a page.
//
// The file is refused, before any text is read, for the things that make its text unreliable or
// that hide content: more pages than the limit (read from the page count), encryption, XFA, and
// embedded files or file attachments. Text is read page by page with the shared function that the
// browser's viewer also uses (`extractPageText` in @lb/contracts), and refused if there is too much of
// it or none at all (a scan has no text layer). The answer goes back to the service as plain data.
import { parentPort, workerData } from 'node:worker_threads'

import { extractPageText, foldQuote } from '@lb/contracts'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

import type { WorkerInput, WorkerOutput } from './messages.ts'

// A document whose text has fewer letters and digits than this has no text layer worth reading: a scan, or an image.
const MIN_TEXT_KEY_CHARS = 20

/** The facts a document's metadata holds that this checks. */
interface DocumentFacts {
  EncryptFilterName?: unknown
  IsXFAPresent?: unknown
  IsCollectionPresent?: unknown
}

/** A refusal, in the form the worker answers with. */
function refuse(code: Extract<WorkerOutput, { ok: false }>['code'], detail?: string): WorkerOutput {
  return detail === undefined ? { ok: false, code } : { ok: false, code, detail }
}

/** A document that was opened, and the loading task that owns it: destroying the task frees the document. */
interface Opened {
  doc: pdfjs.PDFDocumentProxy
  task: pdfjs.PDFDocumentLoadingTask
}

/** Opens the file with pdf.js, set to read text and nothing else. A file that needs a password, or can't be read, is refused. */
async function openDocument(data: Uint8Array): Promise<Opened | WorkerOutput> {
  const task = pdfjs.getDocument({
    data,
    useSystemFonts: false,
    disableFontFace: true,
    fontExtraProperties: false,
    enableXfa: false,
    useWorkerFetch: false,
    useWasm: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    maxImageSize: 1_000_000,
    verbosity: 0,
  })
  try {
    return { doc: await task.promise, task }
  }
  catch (error) {
    await task.destroy()
    const name = error instanceof Error ? error.name.slice(0, 60) : 'unknown'
    return name === 'PasswordException' ? refuse('pdf_encrypted') : refuse('pdf_unreadable', name)
  }
}

/** Tells whether a value is a refusal and not an opened document. */
function isRefusal(value: Opened | WorkerOutput): value is WorkerOutput {
  return 'ok' in value
}

/** Counts the embedded files pdf.js lists: none when it lists none (null), and one for each entry of what it returns (a Map in this version; an object in older ones). */
function countOf(attachments: unknown): number {
  if (attachments === null || attachments === undefined) return 0
  if (attachments instanceof Map) return attachments.size
  return typeof attachments === 'object' ? Object.keys(attachments).length : 0
}

/** Refuses a document that is encrypted, has an XFA form, or carries embedded files, by what its own metadata and catalogue say. */
async function refusalFromStructure(doc: pdfjs.PDFDocumentProxy): Promise<WorkerOutput | undefined> {
  const { info } = await doc.getMetadata()
  const facts = info as DocumentFacts
  if (typeof facts.EncryptFilterName === 'string' || (await doc.getPermissions()) !== null) return refuse('pdf_encrypted')
  if (facts.IsXFAPresent === true || doc.isPureXfa) return refuse('pdf_xfa')
  if (facts.IsCollectionPresent === true || countOf(await doc.getAttachments()) > 0) return refuse('pdf_embedded_files')
  return undefined
}

/** Refuses a document with a file attached to one of its pages, which is an embedded file the catalogue doesn't list. */
async function refusalFromAnnotations(doc: pdfjs.PDFDocumentProxy): Promise<WorkerOutput | undefined> {
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number)
    const annotations = await page.getAnnotations()
    page.cleanup()
    if (annotations.some(annotation => (annotation as { subtype?: unknown }).subtype === 'FileAttachment')) return refuse('pdf_embedded_files')
  }
  return undefined
}

/** Reads the text of every page, or refuses the file when it has too much text or none. */
async function readPages(doc: pdfjs.PDFDocumentProxy, maxChars: number): Promise<WorkerOutput> {
  const pages: { page: number, text: string }[] = []
  let total = 0
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number)
    const { text, truncated } = await extractPageText(page, { maxChars: maxChars - total })
    page.cleanup()
    total += text.length
    if (truncated || total > maxChars) return refuse('too_much_text')
    pages.push({ page: number, text })
  }
  if (foldQuote(pages.map(page => page.text).join('')).length < MIN_TEXT_KEY_CHARS) return refuse('no_text_layer')
  return { ok: true, pages }
}

/** Does the whole job on one file: open it, check it before reading any text, then read it. */
async function extract(input: WorkerInput): Promise<WorkerOutput> {
  const opened = await openDocument(input.data)
  if (isRefusal(opened)) return opened
  const { doc, task } = opened
  try {
    if (doc.numPages > input.maxPages) return refuse('too_many_pages')
    return (await refusalFromStructure(doc)) ?? (await refusalFromAnnotations(doc)) ?? await readPages(doc, input.maxChars)
  }
  finally {
    await task.destroy()
  }
}

/** Answers the service with the result, and a file that makes pdf.js throw is one that can't be read. */
async function run(): Promise<void> {
  let output: WorkerOutput
  try {
    output = await extract(workerData as WorkerInput)
  }
  catch (error) {
    output = refuse('pdf_unreadable', error instanceof Error ? error.name.slice(0, 60) : 'unknown')
  }
  parentPort?.postMessage(output)
}

await run()
