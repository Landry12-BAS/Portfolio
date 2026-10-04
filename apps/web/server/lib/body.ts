// Reading a request's body with a hard size limit. A proxy that reads a body of any size is a
// way to make a serverless function spend memory and time, so every route that takes a body
// names its limit, the Content-Length header is checked before a byte is read, and a body with
// no length (chunked) is counted as it arrives and stopped at the limit. A JSON body is parsed,
// and what is forwarded is the JSON read back and written again, never the bytes as they came.
// A file upload cannot be written again without decoding the file, which is the back end's job
// (in a cage, for LB-03): the proxy checks its envelope and its size and passes the bytes on.
import { getRequestHeader } from 'h3'
import type { H3Event } from 'h3'

import { problems } from './errors.ts'

/** A request body, read and parsed. */
export interface JsonBody {
  // The parsed value.
  value: unknown
  // The value written as JSON again: what to forward.
  text: string
}

/** A file upload, read whole: its bytes and the Content-Type that names the boundary between its parts. */
export interface UploadBody {
  // Plain bytes of their own (not a view of Node's shared buffer pool), which `fetch` takes as a request body.
  bytes: Uint8Array<ArrayBuffer>
  contentType: string
}

// A multipart form's Content-Type with its boundary: the characters RFC 2046 allows in one, up to 70 of them.
// A quoted boundary is legal and no browser or HTTP library sends one, so it is refused.
const UPLOAD_CONTENT_TYPE = /^multipart\/form-data;\s*boundary=([\w'()+,./:=?-]{1,70})$/i

/** Reads the whole request stream, giving up the moment it passes `maxBytes`. */
async function readLimited(event: H3Event, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of event.node.req) {
    const piece = Buffer.from(chunk as Uint8Array)
    length += piece.length
    if (length > maxBytes) throw problems.tooLarge()
    chunks.push(piece)
  }
  return Buffer.concat(chunks)
}

/** Refuses a request that declares a length over the limit, before a byte of it is read. */
function checkDeclaredLength(event: H3Event, maxBytes: number): void {
  const declared = getRequestHeader(event, 'content-length')
  if (declared !== undefined && (!/^\d{1,9}$/.test(declared) || Number(declared) > maxBytes)) throw problems.tooLarge()
}

/**
 * Reads a JSON request body of at most `maxBytes`. Answers 415 for a body that isn't declared
 * as JSON, 413 for one that is too big, and 400 for one that doesn't parse or is empty.
 */
export async function readJsonBody(event: H3Event, maxBytes: number): Promise<JsonBody> {
  if (!/^application\/json(?:\s*;.*)?$/i.test(getRequestHeader(event, 'content-type') ?? '')) throw problems.unsupportedMedia()
  checkDeclaredLength(event, maxBytes)
  const raw = await readLimited(event, maxBytes)
  if (raw.length === 0) throw problems.invalidRequest('The request has no body.')
  let value: unknown
  try {
    value = JSON.parse(raw.toString('utf8'))
  }
  catch {
    throw problems.invalidRequest('The body is not valid JSON.')
  }
  return { value, text: JSON.stringify(value) }
}

/**
 * Tells whether a body is shaped as the multipart form its Content-Type says: it opens with its
 * boundary, and it ends with the closing boundary (and perhaps a line break). Anything else is not
 * a form any parser reads the same way twice, so it is not passed on.
 */
function isWellFormedUpload(raw: Buffer, boundary: string): boolean {
  const opening = Buffer.from(`--${boundary}`)
  const closing = Buffer.from(`--${boundary}--`)
  if (!raw.subarray(0, opening.length).equals(opening)) return false
  const tail = raw.subarray(Math.max(0, raw.length - closing.length - 2)).toString('latin1')
  return tail.replace(/\r?\n$/, '').endsWith(closing.toString('latin1'))
}

/**
 * Reads a file upload of at most `maxBytes`, as the multipart form it declares itself to be. Answers
 * 415 for a body that isn't one (or whose boundary isn't a plain one), 413 for one that is too big, and
 * 400 for one that is empty or not closed. What the form holds is not read here: the back end decides
 * whether it is a file it takes.
 */
export async function readUploadBody(event: H3Event, maxBytes: number): Promise<UploadBody> {
  const contentType = getRequestHeader(event, 'content-type') ?? ''
  const boundary = UPLOAD_CONTENT_TYPE.exec(contentType)?.[1]
  if (boundary === undefined) throw problems.unsupportedMedia('Send the file as multipart/form-data.')
  checkDeclaredLength(event, maxBytes)
  const raw = await readLimited(event, maxBytes)
  if (raw.length === 0) throw problems.invalidRequest('The request has no body.')
  if (!isWellFormedUpload(raw, boundary)) throw problems.invalidRequest('The upload is not a well-formed multipart form.')
  // A copy, so the bytes are plain ones that `fetch` takes as a body and not a view of Node's shared buffer pool.
  return { bytes: new Uint8Array(raw), contentType }
}
