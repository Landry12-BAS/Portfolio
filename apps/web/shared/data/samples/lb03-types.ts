// The shape of one curated sample of LB-03's demo: an invoice, a receipt or a photograph the board
// opens on, taken from the golden set (evals/lb03/golden.yaml) so the demo shows what the evals check.
// A sample with a recording replays it without spending quota; one without says so and offers the
// live run, which uploads the sample's file as a visitor's own.

/** The kinds of document the six samples are: each shows a different thing the reader has to deal with. */
export type InvoiceSampleKind = 'clean_pdf' | 'euro_vat' | 'photo' | 'handwritten' | 'hostile' | 'planted_error'

/** How the golden set expects the service to end a document. */
export type InvoiceOutcome = 'valid' | 'needs_review' | 'held' | 'failed'

/** The media types of the files the samples are. */
export type InvoiceSampleMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'

/** One curated document for LB-03's demo. */
export interface InvoiceSample {
  // The sample's name in the golden set, also the name of its recording and of its page pictures.
  id: string
  // The ID of the golden set's case the sample is.
  goldenCase: string
  kind: InvoiceSampleKind
  // The file's name: it is served as `/lb03/samples/<file>` and read from data/seed/lb03/documents.
  file: string
  mime: InvoiceSampleMime
  bytes: number
  pages: number
  // What the document prints, which the demo says before the run: who sent it, its number, its currency and its total.
  documentType: 'invoice' | 'credit_note' | 'receipt'
  vendor: string
  number: string
  currency: string
  total: string
  // What the golden set expects of the reading, and which checks it expects to fail.
  outcome: InvoiceOutcome
  failingChecks: readonly string[]
  // True for a document written to give the reader orders: the injection check must flag it.
  guardFlags: boolean
}
