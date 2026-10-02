// LB-04 Contract Radar's operating limits and its closed lists: the numbers the service
// enforces, the board shows, and the datasheet promises, kept in one place so the three
// can't drift apart. The topics and severities are closed lists because the playbook's
// rules, the model's answers and the radar all name them, and a name outside the list is
// an error everywhere.

/** The label every answer and every screen of LB-04 carries: a review is a reading aid, not legal advice. */
export const NOT_LEGAL_ADVICE = 'Not legal advice'

/** LB-04's limits. The datasheet (apps/web/shared/data/systems.ts) promises the pages, the contracts a day and the label. */
export const LB04_LIMITS = {
  // The most pages a contract may have, read from the file's page count before any text is read.
  maxPages: 30,
  // The most bytes a PDF may have. The site's server forwards JSON only, so a PDF travels as base64 (a third
  // larger), and Vercel's functions take at most 4.5 MB of request body: 2 MiB leaves room for both.
  maxFileBytes: 2 * 1_024 * 1_024,
  // The most characters of a visitor's file name that are kept, for the list of their contracts.
  maxTitleLength: 80,
  // How many contracts a visitor may have reviewed in a day (a sample counts, a refused file is given back).
  contractsPerVisitorPerDay: 3,
  // How many files a visitor may send in a day, refused ones included: what keeps the extractor from being used as a toy.
  uploadsPerVisitorPerDay: 10,
  // How many redlines one contract may have: the model calls a contract may use are the review's and these.
  redlinesPerContract: 3,
  // How long a file, its text and its report are kept.
  keptMinutes: 60,
  // The most text a contract may hold, in all. The long-document model reads it in one request, and the gateway's
  // input limit for that alias (services/gateway/routing.yaml) is the reason for this number: a test checks it.
  maxTextChars: 160_000,
  // The shortest quote the server will check, counted in the characters that are compared (letters and digits).
  // A shorter one would be found in almost any contract and prove nothing.
  minQuoteChars: 12,
  // The longest passage a finding may quote.
  maxQuoteChars: 1_200,
  // The most findings a report holds.
  maxFindings: 24,
} as const

/** The topics the playbook covers, in the order the radar draws them. */
export const LB04_TOPICS = ['liability', 'indemnity', 'termination', 'renewal', 'payment', 'ip', 'confidentiality', 'governing_law', 'exclusivity'] as const
/** One of the playbook's topics. */
export type Lb04Topic = (typeof LB04_TOPICS)[number]

/** How serious a finding is, lowest first. Both the playbook and the model use these four, and the golden set grades them within one step. */
export const LB04_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
/** One of the four severities. */
export type Lb04Severity = (typeof LB04_SEVERITIES)[number]

/** The number a severity counts for on the radar: 1 for low up to 4 for critical (a topic with no finding is 0). */
export function lb04SeverityWeight(severity: Lb04Severity): number {
  return LB04_SEVERITIES.indexOf(severity) + 1
}

/** The steps of a contract's review, in order. `failed` can follow any of them. */
export const LB04_STATES = ['queued', 'extracting', 'analysing', 'verifying', 'done', 'failed'] as const
/** One state of a contract's review. */
export type Lb04State = (typeof LB04_STATES)[number]

/** The reasons a review can end as failed. The board words each from its own locale files, never from a response. */
export const LB04_FAILURE_CODES = [
  // The file can't be read as a PDF at all.
  'pdf_unreadable',
  'pdf_encrypted',
  'pdf_xfa',
  'pdf_embedded_files',
  'too_many_pages',
  // A scan or an image: the file has no text to read, and OCR is not part of this system.
  'no_text_layer',
  'too_much_text',
  'extraction_timeout',
  'extraction_failed',
  // The model could not be reached, or its day's quota is spent: nothing the visitor did.
  'analysis_unavailable',
  // The model answered, but not in a form the server accepts, even after its one repair.
  'analysis_invalid',
  'internal',
] as const
/** One reason a review failed. */
export type Lb04FailureCode = (typeof LB04_FAILURE_CODES)[number]

/** What a failed review says in plain words: a sentence for the API, shared by the service and the mock back end. The board words each code itself, in its own language. */
export const LB04_FAILURE_MESSAGES: Readonly<Record<Lb04FailureCode, string>> = {
  pdf_unreadable: 'The file could not be read as a PDF.',
  pdf_encrypted: 'The PDF is encrypted, and encrypted files are not read.',
  pdf_xfa: 'The PDF holds an XFA form, which is not read.',
  pdf_embedded_files: 'The PDF carries embedded files, which are not read.',
  too_many_pages: `The contract has more than ${LB04_LIMITS.maxPages} pages.`,
  no_text_layer: 'The PDF has no text layer, as a scan has, and no OCR is done.',
  too_much_text: 'The PDF holds more text than a review reads.',
  extraction_timeout: 'Reading the PDF took too long.',
  extraction_failed: 'Reading the PDF failed.',
  analysis_unavailable: 'The model could not be reached, or its free quota for today is spent.',
  analysis_invalid: 'The model did not answer in a form that could be used.',
  internal: 'The review failed.',
}

/** The failures that are the file's own, so the visitor gets their place of the day back and the file is not tried again. */
export const LB04_FILE_FAILURES: readonly Lb04FailureCode[] = ['pdf_unreadable', 'pdf_encrypted', 'pdf_xfa', 'pdf_embedded_files', 'too_many_pages', 'no_text_layer', 'too_much_text', 'extraction_timeout', 'extraction_failed']

/** Why a quote or a finding the model proposed was left out of the report. Each is counted and none is shown. */
export const LB04_DROP_REASONS = [
  // The quote is not in the contract's text, even folded: an invented clause.
  'quote_not_found',
  // The quote is too short to prove anything, or too long to be one passage.
  'quote_too_short',
  'quote_too_long',
  // The quote lies in a passage that talks to the reviewer, not about the deal.
  'quote_in_instruction',
  // The finding names a rule or a topic the playbook doesn't have, or a rule of another topic.
  'unknown_rule',
  'topic_mismatch',
  // The model said a clause was missing and the whole text says it isn't.
  'absent_contradicted',
  // The same passage and rule were already reported, or the report is full.
  'duplicate',
  'over_limit',
] as const
/** One reason a finding was dropped. */
export type Lb04DropReason = (typeof LB04_DROP_REASONS)[number]
