// Reading the multipart body of an upload, as far as the mock needs: exactly one part, named `file`, with a
// file name. The real service has Werkzeug do this and refuses anything else with a 422, so this refuses the
// same things: no boundary, a form that is not closed, more or fewer parts than one, another name.
import type { Lb03Upload } from './lb03.ts'

/** Cuts a multipart body into its parts, or returns undefined when it is not a closed form that opens with its boundary. */
function splitParts(raw: Buffer, boundary: string): Buffer[] | undefined {
  const delimiter = Buffer.from(`--${boundary}`)
  const separator = Buffer.from(`\r\n--${boundary}`)
  const parts: Buffer[] = []
  let start = raw.indexOf(delimiter)
  if (start !== 0) return undefined
  for (;;) {
    const after = start + delimiter.length
    const marker = raw.subarray(after, after + 2).toString('latin1')
    if (marker === '--') return parts
    if (marker !== '\r\n') return undefined
    const next = raw.indexOf(separator, after + 2)
    if (next < 0) return undefined
    parts.push(raw.subarray(after + 2, next))
    start = next + 2
  }
}

/** Reads the upload out of a multipart body: its one file part, or undefined when the form is not that. */
export function parseUpload(raw: Buffer, contentType: string | undefined): Lb03Upload | undefined {
  const boundary = /^multipart\/form-data;\s*boundary=([\w'()+,./:=?-]{1,70})$/i.exec(contentType ?? '')?.[1]
  if (boundary === undefined) return undefined
  const parts = splitParts(raw, boundary)
  if (parts?.length !== 1) return undefined
  const [part] = parts
  const split = part?.indexOf(Buffer.from('\r\n\r\n')) ?? -1
  if (part === undefined || split < 0) return undefined
  const head = part.subarray(0, split).toString('latin1')
  const disposition = /^content-disposition:\s*form-data;(.*)$/im.exec(head)?.[1] ?? ''
  const name = /\bname="([^"]*)"/.exec(disposition)?.[1]
  const filename = /\bfilename="([^"]*)"/.exec(disposition)?.[1]
  if (name !== 'file' || filename === undefined) return undefined
  return { filename, data: part.subarray(split + 4) }
}
