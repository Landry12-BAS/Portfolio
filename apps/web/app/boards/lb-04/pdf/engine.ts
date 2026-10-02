// The PDF engine of the viewer: pdf.js, loaded only when a visitor first looks at a contract's pages, so a
// visitor who reads the report never downloads it (the build leaves this module out of the page's
// prefetch hints, nuxt.config.ts). It opens the bytes of the contract the board already holds, draws a
// page on a canvas, and reads a page's text with the one function the server reads it with
// (`extractPageText` in @lb/contracts), so the browser's text can be compared with the server's and a
// citation's characters can be found in it. pdf.js runs in a worker the page starts under the site's
// Content Security Policy (worker.ts). pdf.js 6 evaluates no code, so the page's policy needs no
// allowance for it, and it loads nothing from anywhere: the page's fonts are the system's, and nothing a
// PDF contains is fetched.
import { boxesForRange, extractPageText } from '@lb/contracts'
import type { PageBox, PageText } from '@lb/contracts'
import { getDocument, PDFWorker } from 'pdfjs-dist'
import type { PDFDocumentProxy, PageViewport, RenderTask } from 'pdfjs-dist'
// The worker the build puts in the site's own origin. Vite turns this import into the address of that file.
import workerAddress from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

import { startPdfWorker } from './worker'
import type { PolicyFactory, WorkerConstructor } from './worker'

/** A rectangle on the drawn page, in CSS pixels from the page's top left corner. */
export interface PixelBox {
  left: number
  top: number
  width: number
  height: number
}

/** A page that has been drawn: its size, and how to place a range of its text on it. */
export interface DrawnPage {
  width: number
  height: number
  // The boxes that cover a range of the page's text, as CSS pixels on the drawn page.
  boxesFor: (text: PageText, start: number, end: number) => PixelBox[]
}

/** A contract's PDF, open for drawing and for reading its text. */
export interface PdfDocument {
  readonly pageCount: number
  // Reads a page's text the way the server does.
  textOf: (page: number) => Promise<PageText>
  // Draws a page, `width` CSS pixels wide, into the canvas; a newer call for the same canvas cancels the older.
  draw: (page: number, canvas: HTMLCanvasElement, width: number) => Promise<DrawnPage | undefined>
  // Ends the worker and frees the document.
  destroy: () => Promise<void>
}

/** What the browser has that the engine uses: its Trusted Types factory and its Worker constructor. */
export interface Host {
  trustedTypes?: PolicyFactory
  Worker: WorkerConstructor
  devicePixelRatio: number
}

/** The browser's own host. */
function browserHost(): Host {
  const trusted = (globalThis as { trustedTypes?: PolicyFactory }).trustedTypes
  return { ...(trusted ? { trustedTypes: trusted } : {}), Worker, devicePixelRatio: globalThis.devicePixelRatio || 1 }
}

/** Turns a rectangle of the page's own units into one of CSS pixels, with the viewport that was drawn. */
function pixelBox(viewport: PageViewport, box: PageBox): PixelBox {
  const [x1 = 0, y1 = 0] = viewport.convertToViewportPoint(box.left, box.bottom) as number[]
  const [x2 = 0, y2 = 0] = viewport.convertToViewportPoint(box.right, box.top) as number[]
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
}

/** Tells whether an error is pdf.js saying that a drawing was cancelled, which is nothing to report. */
function wasCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException'
}

/**
 * What is known of the drawing on one canvas. pdf.js refuses a second render on a canvas that a first has
 * not let go of, even one it was told to cancel, so the drawings on a canvas are made one after another:
 * a newer request cancels the render in progress, waits for it to end, and is skipped itself if a newer
 * one has come in by the time its turn is up.
 */
interface CanvasState {
  // The render in progress on the canvas, if there is one.
  task: RenderTask | undefined
  // The end of everything asked of the canvas so far.
  last: Promise<unknown>
  // The number of the newest request.
  latest: number
}

/** Opens a contract's PDF. The bytes are copied, because pdf.js hands what it is given to its worker. */
export async function openPdf(bytes: Uint8Array, host: Host = browserHost()): Promise<PdfDocument> {
  const worker = startPdfWorker(workerAddress, host)
  const loading = getDocument({
    data: bytes.slice(),
    worker: PDFWorker.create({ port: worker }),
    // A form is not rendered: this viewer draws pages and reads their text, nothing a PDF can run.
    enableXfa: false,
  })
  let document: PDFDocumentProxy
  try {
    document = await loading.promise
  }
  catch (error) {
    worker.terminate()
    throw error
  }
  const canvases = new WeakMap<HTMLCanvasElement, CanvasState>()

  /** Draws a page on a canvas that nothing else is drawing on, unless a newer request has come in meanwhile. */
  async function drawNow(page: number, canvas: HTMLCanvasElement, width: number, state: CanvasState, ticket: number): Promise<DrawnPage | undefined> {
    const proxy = await document.getPage(page)
    if (ticket !== state.latest) return undefined
    const unit = proxy.getViewport({ scale: 1 })
    const viewport = proxy.getViewport({ scale: width / unit.width })
    const ratio = host.devicePixelRatio
    canvas.width = Math.floor(viewport.width * ratio)
    canvas.height = Math.floor(viewport.height * ratio)
    canvas.style.width = `${Math.floor(viewport.width)}px`
    canvas.style.height = `${Math.floor(viewport.height)}px`
    const task = proxy.render({ canvas, viewport, ...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] }) })
    state.task = task
    try {
      await task.promise
    }
    catch (error) {
      if (wasCancelled(error)) return undefined
      throw error
    }
    finally {
      if (state.task === task) state.task = undefined
    }
    return {
      width: viewport.width,
      height: viewport.height,
      boxesFor: (text, start, end) => boxesForRange(text, start, end).map(box => pixelBox(viewport, box)),
    }
  }

  return {
    pageCount: document.numPages,
    async textOf(page) {
      return extractPageText(await document.getPage(page))
    },
    draw(page, canvas, width) {
      const state = canvases.get(canvas) ?? { task: undefined, last: Promise.resolve(), latest: 0 }
      canvases.set(canvas, state)
      state.latest += 1
      const ticket = state.latest
      // A newer request ends the render in progress; this one then waits its turn on the canvas.
      state.task?.cancel()
      const mine = state.last.then(() => (ticket === state.latest ? drawNow(page, canvas, width, state, ticket) : undefined))
      state.last = mine.catch(() => undefined)
      return mine
    },
    async destroy() {
      await loading.destroy()
      worker.terminate()
    },
  }
}
