// PDFs for LB-04's tests of what the extraction refuses, made with pdf-lib (a development dependency): a
// plain text document, and the same with one thing that must get it refused: encryption (one that needs a
// password, and one that opens with an empty password and holds restrictions), an XFA form, an embedded
// file, a file attached to a page, and a file that is not a PDF at all. They are made at the time of the
// test, so no binary fixture sits in the repository.
import { createHash } from 'node:crypto'

import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib'

/** What can be added to a plain document to get it refused. */
export interface PdfTraps {
  // Encrypt the document: with a password the empty one doesn't open, or with an empty password and restrictions on what a reader may do.
  encrypt?: 'password' | 'restricted'
  // Add an XFA form to the document's form.
  xfa?: boolean
  // Embed a file in the document.
  attachment?: boolean
  // Attach a file to the first page as an annotation, which no list of embedded files shows.
  attachedToPage?: boolean
}

// The padding the PDF standard adds to a password.
const PADDING = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex')

/** The RC4 stream cipher, which the PDF standard's oldest encryption uses and the platform's crypto may not offer. */
function rc4(key: Buffer, data: Buffer): Buffer {
  const state = Array.from({ length: 256 }, (_, index) => index)
  let j = 0
  for (let i = 0; i < 256; i += 1) {
    j = (j + (state[i] as number) + (key[i % key.length] as number)) % 256
    ;[state[i], state[j]] = [state[j] as number, state[i] as number]
  }
  const output = Buffer.alloc(data.length)
  let a = 0
  let b = 0
  for (let index = 0; index < data.length; index += 1) {
    a = (a + 1) % 256
    b = (b + (state[a] as number)) % 256
    ;[state[a], state[b]] = [state[b] as number, state[a] as number]
    output[index] = (data[index] as number) ^ (state[((state[a] as number) + (state[b] as number)) % 256] as number)
  }
  return output
}

/** MD5 of the parts joined. */
function md5(...parts: Buffer[]): Buffer {
  const hash = createHash('md5')
  for (const part of parts) hash.update(part)
  return hash.digest()
}

/** Adds the encryption dictionary of a standard 40-bit RC4 document (revision 2) to a document that has not been saved. */
function encrypt(doc: PDFDocument, mode: 'password' | 'restricted'): void {
  const id = Buffer.from('0123456789abcdef0123456789abcdef', 'hex')
  const permissions = Buffer.alloc(4)
  permissions.writeInt32LE(-44)
  const owner = rc4(md5(PADDING).subarray(0, 5), PADDING)
  const key = md5(PADDING, owner, permissions, id).subarray(0, 5)
  // A user password the empty one is not: the entry that checks it is not the one the empty password makes.
  const user = mode === 'restricted' ? rc4(key, PADDING) : Buffer.alloc(32, 7)
  const dictionary = doc.context.obj({ Filter: 'Standard', V: 1, R: 2, O: PDFHexString.of(owner.toString('hex')), U: PDFHexString.of(user.toString('hex')), P: -44 })
  doc.context.trailerInfo.Encrypt = doc.context.register(dictionary)
  doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of(id.toString('hex')), PDFHexString.of(id.toString('hex'))])
}

/** Adds an XFA form to the document's catalogue. */
function addXfa(doc: PDFDocument): void {
  const template = doc.context.register(doc.context.stream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template/></xdp:xdp>'))
  const data = doc.context.register(doc.context.stream('<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"/>'))
  const form = doc.context.obj({ Fields: [], XFA: [PDFString.of('template'), template, PDFString.of('datasets'), data] })
  doc.catalog.set(PDFName.of('AcroForm'), form)
}

/** Attaches a file to the first page as an annotation. */
function attachToPage(doc: PDFDocument): void {
  const stream = doc.context.register(doc.context.stream('hidden words'))
  const specification = doc.context.register(doc.context.obj({ Type: 'Filespec', F: PDFString.of('notes.txt'), EF: { F: stream } }))
  const annotation = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: [10, 10, 30, 30], Contents: PDFString.of('Notes'), FS: specification, Name: 'PushPin' }))
  doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([annotation]))
}

/** The lines of one page of plain prose, enough to count as a text layer. */
export function prose(page: number): string[] {
  return [
    `Agreement page ${page}`,
    'The Supplier shall deliver the Products to the Customer on the dates agreed.',
    'The Customer shall pay each invoice within thirty days of the date of the invoice.',
    'Each party shall keep the other\'s confidential information confidential.',
  ]
}

/** Makes a PDF of `pageCount` pages of prose, or of the lines given, with the traps asked for. */
export async function makePdf(pageCount: number, traps: PdfTraps = {}, lines: (page: number) => string[] = prose): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= pageCount; number += 1) {
    const page = doc.addPage([595, 842])
    lines(number).forEach((line, index) => page.drawText(line, { x: 56, y: 780 - index * 18, size: 11, font }))
  }
  if (traps.xfa) addXfa(doc)
  if (traps.attachment) await doc.attach(Buffer.from('an embedded file'), 'notes.txt', { mimeType: 'text/plain', creationDate: new Date(0), modificationDate: new Date(0) })
  if (traps.attachedToPage) attachToPage(doc)
  if (traps.encrypt) encrypt(doc, traps.encrypt)
  return doc.save({ useObjectStreams: false })
}
