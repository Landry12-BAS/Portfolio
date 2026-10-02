// Reading a request's body with a hard size limit. A proxy that reads a body of any size is a
// way to make a serverless function spend memory and time, so every route that takes a body
// names its limit, the Content-Length header is checked before a byte is read, and a body with
// no length (chunked) is counted as it arrives and stopped at the limit. The body must be JSON,
// and what is forwarded is the JSON read back and written again, never the bytes as they came.
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

/**
 * Reads a JSON request body of at most `maxBytes`. Answers 415 for a body that isn't declared
 * as JSON, 413 for one that is too big, and 400 for one that doesn't parse or is empty.
 */
export async function readJsonBody(event: H3Event, maxBytes: number): Promise<JsonBody> {
  if (!/^application\/json(?:\s*;.*)?$/i.test(getRequestHeader(event, 'content-type') ?? '')) throw problems.unsupportedMedia()
  const declared = getRequestHeader(event, 'content-length')
  if (declared !== undefined && (!/^\d{1,9}$/.test(declared) || Number(declared) > maxBytes)) throw problems.tooLarge()
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
