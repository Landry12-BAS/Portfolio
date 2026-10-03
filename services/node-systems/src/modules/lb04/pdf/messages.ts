// What the extraction worker thread is given and what it answers. They are plain data that cross
// the thread boundary, and the answer is checked with a schema before the service reads it, as any
// input from outside its own control is.
import { LB04_LIMITS } from '@lb/contracts'
import { z } from 'zod'

/** What the worker is given: the file, and the limits to refuse it at. */
export interface WorkerInput {
  data: Uint8Array
  maxPages: number
  maxChars: number
}

/** The reasons the worker itself can refuse a file. The service adds a timeout and an exhausted worker. */
export const WORKER_REFUSALS = ['pdf_unreadable', 'pdf_encrypted', 'pdf_xfa', 'pdf_embedded_files', 'too_many_pages', 'no_text_layer', 'too_much_text'] as const

/** What the worker answers: the text of every page, or the reason it refused the file. */
export const workerOutputSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    pages: z.array(z.strictObject({
      page: z.int().min(1).max(LB04_LIMITS.maxPages),
      text: z.string().max(LB04_LIMITS.maxTextChars),
    })).min(1).max(LB04_LIMITS.maxPages),
  }),
  // `detail` is the name of the error that made a file unreadable, for the service's log: never its message, which could quote the file.
  z.strictObject({ ok: z.literal(false), code: z.enum(WORKER_REFUSALS), detail: z.string().max(60).optional() }),
])

/** The worker's answer. */
export type WorkerOutput = z.infer<typeof workerOutputSchema>
