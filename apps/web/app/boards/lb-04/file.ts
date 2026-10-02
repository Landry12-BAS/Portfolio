// A PDF the visitor picks, as the board takes it in: checked in the browser against the same rules the
// service applies (not empty, within the size limit, and a PDF by its first bytes), so a file that
// would be refused is never sent, and written as base64, because the site's server forwards JSON only.
// The checks cost the visitor nothing: a file that fails them takes no place from the day, here or there.
import { LB04_LIMITS } from '@lb/contracts'

/** Why a file cannot be reviewed, found before it is sent. */
export type FileProblem = 'empty' | 'tooLarge' | 'notPdf'

// What every PDF begins with.
const PDF_MAGIC = '%PDF-'
// How many bytes are turned into text at a time: `String.fromCharCode` takes its arguments on the stack, so a whole file would overflow it.
const CHUNK = 0x8000

/** Says what is wrong with a file of this size that begins with these bytes, or nothing when it may be sent. */
export function fileProblemOf(size: number, head: Uint8Array): FileProblem | undefined {
  if (size === 0) return 'empty'
  if (size > LB04_LIMITS.maxFileBytes) return 'tooLarge'
  const start = String.fromCharCode(...head.subarray(0, PDF_MAGIC.length))
  return start === PDF_MAGIC ? undefined : 'notPdf'
}

/** Writes bytes as base64, a chunk at a time. */
export function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(text)
}

/** Reads base64 back into bytes, or undefined when the text is not base64. */
export function fromBase64(text: string): Uint8Array | undefined {
  try {
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  }
  catch {
    return undefined
  }
}

/** A file ready to send: its bytes, and the same as base64. */
export interface PreparedFile {
  bytes: Uint8Array
  base64: string
}

/** Reads a chosen file and checks it. A file too large is refused from its size alone, without reading it. */
export async function prepareFile(file: Blob): Promise<{ problem: FileProblem } | { file: PreparedFile }> {
  if (file.size > LB04_LIMITS.maxFileBytes) return { problem: 'tooLarge' }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const problem = fileProblemOf(bytes.length, bytes)
  return problem === undefined ? { file: { bytes, base64: toBase64(bytes) } } : { problem }
}

/** Writes a size for a visitor: whole kilobytes under a megabyte, and megabytes with one decimal above. */
export function formatSize(bytes: number, locale: string): string {
  if (bytes < 1_048_576) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.max(1, Math.round(bytes / 1_024)))}\u00A0kB`
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(bytes / 1_048_576)}\u00A0MB`
}
