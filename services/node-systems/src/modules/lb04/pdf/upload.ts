// What is checked about an uploaded file before anything is stored or any thread is started: it must
// be base64 (the site forwards JSON only, so a PDF arrives as text), within the size limit once
// decoded, and a PDF by its first bytes. These checks cost nothing, so a file that fails them
// takes no place from the visitor's day. Everything that needs a PDF reader (the page count,
// encryption, XFA, attachments, the text) happens later, in the worker thread.
import { LB04_LIMITS } from '@lb/contracts'

import { AppError } from '../../../core/errors.ts'

// Standard base64 with padding, and nothing else: no line breaks, no spaces, no URL-safe letters.
const BASE64 = /^[a-z0-9+/]+={0,2}$/i
// What every PDF begins with.
const PDF_MAGIC = '%PDF-'
// The name given to a file whose own name is empty once cleaned.
const FALLBACK_TITLE = 'contract.pdf'

/** The error for a file that is not a PDF, or is not sent as base64 at all. */
function notAPdf(): AppError {
  return new AppError(415, 'not_a_pdf', 'The file is not a PDF.')
}

/**
 * Decodes an uploaded file and checks it: base64 of a size within the limit, beginning with the bytes
 * every PDF begins with. Answers 415 for what is not a PDF and 413 for what is too large.
 */
export function decodeUpload(contentBase64: string): Buffer {
  if (contentBase64.length % 4 !== 0 || !BASE64.test(contentBase64)) throw notAPdf()
  const bytes = Buffer.from(contentBase64, 'base64')
  if (bytes.length > LB04_LIMITS.maxFileBytes) throw new AppError(413, 'file_too_large', `The file is larger than ${LB04_LIMITS.maxFileBytes / (1_024 * 1_024)} MB.`)
  if (bytes.subarray(0, PDF_MAGIC.length).toString('latin1') !== PDF_MAGIC) throw notAPdf()
  return bytes
}

/** Cuts a text to at most `limit` UTF-16 units (what the response schemas count), never in the middle of a character. */
function cutTo(text: string, limit: number): string {
  let result = ''
  for (const character of text) {
    if (result.length + character.length > limit) break
    result += character
  }
  return result
}

/**
 * Turns the name of an uploaded file into the title shown in the visitor's list: the last part of a path,
 * without invisible formatting characters (a zero-width space or a byte-order mark), with white space made
 * single, cut to the limit in whole characters. The name is only ever a label: it is never used as a path.
 */
export function titleOf(filename: string): string {
  const last = filename.split(/[\\/]/).at(-1) ?? ''
  const visible = last.replaceAll(/\p{Cf}/gu, '')
  const cleaned = cutTo(visible.replaceAll(/\s+/g, ' ').trim(), LB04_LIMITS.maxTitleLength).trim()
  return cleaned === '' ? FALLBACK_TITLE : cleaned
}
