// Running the extraction in a worker thread with a time limit and a memory limit. pdf.js parses a
// stranger's file, which is the riskiest thing this service does with visitor input, so it is done
// in a thread of its own: the thread gets a copy of the bytes and an empty environment, a ceiling on
// the memory it may use, and a deadline. When either is passed, or the thread dies for any reason, it
// is terminated and the file is refused with a plain reason, and the service goes on. Nothing the
// thread does can reach a visitor except the text it hands back, which is checked with a schema.
import { Worker } from 'node:worker_threads'

import { LB04_LIMITS } from '@lb/contracts'
import type { Lb04FailureCode } from '@lb/contracts'

import { workerOutputSchema } from './messages.ts'
import type { WorkerInput } from './messages.ts'

/** How a worker thread is limited. */
export interface ExtractionLimits {
  // How long it may run, in milliseconds.
  timeoutMs: number
  // The most memory its heap may use, in megabytes: the long-lived part, and the young part.
  maxOldGenerationMb: number
  maxYoungGenerationMb: number
  // The most stack it may use, in megabytes.
  stackMb: number
}

/** One page of an extracted contract. */
export interface ExtractedPage {
  page: number
  text: string
}

/** A file the extraction refused, and why. The reason is one of the failure codes the board words itself. */
export class ExtractionRefused extends Error {
  readonly code: Lb04FailureCode
  // The name of the error that made the file unreadable, when there was one: for the log, and never the error's message.
  readonly detail: string | undefined

  constructor(code: Lb04FailureCode, detail?: string) {
    super(`The file was refused: ${code}.`)
    this.name = 'ExtractionRefused'
    this.code = code
    this.detail = detail
  }
}

// The worker's script, beside this file. Tests may name another to prove the limits with a script that misbehaves.
const DEFAULT_SCRIPT = new URL('./extract-worker.ts', import.meta.url)

/** Which script to run and what to refuse at; the defaults are the limits the system promises. */
export interface ExtractionOptions {
  script?: URL
  maxPages?: number
  maxChars?: number
}

/** Makes a copy of the bytes that the thread can own, so nothing the thread does can touch the caller's buffer. */
function copyOf(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

/**
 * Extracts the text of every page of a PDF in a worker thread, within `limits`. Resolves with the pages,
 * or rejects with an `ExtractionRefused` that says why the file was refused: the thread's own reasons,
 * `extraction_timeout` when the deadline passed, and `extraction_failed` when the thread ran out of memory or died.
 */
export function extractPdf(bytes: Uint8Array, limits: ExtractionLimits, options: ExtractionOptions = {}): Promise<ExtractedPage[]> {
  const input: WorkerInput = { data: copyOf(bytes), maxPages: options.maxPages ?? LB04_LIMITS.maxPages, maxChars: options.maxChars ?? LB04_LIMITS.maxTextChars }
  return new Promise((resolve, reject) => {
    const worker = new Worker(options.script ?? DEFAULT_SCRIPT, {
      workerData: input,
      transferList: [input.data.buffer as ArrayBuffer],
      // An empty environment: nothing the thread reads can be a setting or a secret of this process.
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenerationMb, maxYoungGenerationSizeMb: limits.maxYoungGenerationMb, stackSizeMb: limits.stackMb },
    })
    let settled = false
    /** Ends the thread and settles the promise, once: whichever of the answer, the error, the exit and the deadline comes first wins. */
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      action()
    }
    const timer = setTimeout(() => settle(() => reject(new ExtractionRefused('extraction_timeout'))), limits.timeoutMs)
    worker.once('message', (message: unknown) => settle(() => {
      const output = workerOutputSchema.safeParse(message)
      if (!output.success) reject(new ExtractionRefused('extraction_failed'))
      else if (output.data.ok) resolve(output.data.pages)
      else reject(new ExtractionRefused(output.data.code, output.data.detail))
    }))
    worker.once('error', () => settle(() => reject(new ExtractionRefused('extraction_failed'))))
    worker.once('exit', () => settle(() => reject(new ExtractionRefused('extraction_failed'))))
  })
}
