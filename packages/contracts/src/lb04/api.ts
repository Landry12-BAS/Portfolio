// What the site may send to LB-04's API, and what it gets back: the contract and its state, the
// pages' text, the report with its findings, citations and radar, and a redline. Every schema is
// strict and bounded, so a field nobody planned for, or an answer larger than any honest one, is
// refused by the board as it is by the service. A risk finding cannot be written without a quote
// and a citation: the type is where "no finding without a verified quote" is first stated.
import { z } from 'zod'

import { LB04_DROP_REASONS, LB04_FAILURE_CODES, LB04_LIMITS, LB04_SEVERITIES, LB04_STATES, LB04_TOPICS, NOT_LEGAL_ADVICE } from './limits.ts'

const topic = z.enum(LB04_TOPICS)
const severity = z.enum(LB04_SEVERITIES)
// A rule's id in the playbook, such as `liability-cap`, and a sample's id, such as `wholesale-supply`.
const ruleId = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/)
const sampleId = z.string().regex(/^[a-z0-9-]{1,60}$/)
const label = z.literal(NOT_LEGAL_ADVICE)
// The size of a PDF as base64: four characters for every three bytes, rounded up.
const MAX_BASE64_CHARS = Math.ceil(LB04_LIMITS.maxFileBytes / 3) * 4

/** A range of one page's text: `text.slice(start, end)` of the page `page` (counted from 1). The characters are the ones the server checked. */
export const lb04CitationSchema = z.strictObject({
  page: z.int().min(1).max(LB04_LIMITS.maxPages),
  start: z.int().min(0).max(LB04_LIMITS.maxTextChars),
  end: z.int().min(1).max(LB04_LIMITS.maxTextChars),
}).refine(citation => citation.end > citation.start, 'a citation ends after it starts')

/** Makes a contract review: from one of the curated samples, or from a PDF the visitor sends as base64 (the site forwards JSON only). */
export const lb04CreateContractRequestSchema = z.discriminatedUnion('from', [
  z.strictObject({ from: z.literal('sample'), sampleId }),
  z.strictObject({
    from: z.literal('upload'),
    // The file's name, kept (cut to 80 characters) only to label the visitor's list. It is never used as a path.
    filename: z.string().trim().min(1).max(200),
    contentBase64: z.string().min(8).max(MAX_BASE64_CHARS),
  }),
])

/** Why a review failed: a stable code the board words itself, and a plain sentence. */
export const lb04FailureSchema = z.strictObject({
  code: z.enum(LB04_FAILURE_CODES),
  message: z.string().min(1).max(300),
})

/** A contract under review, or reviewed: its state, and when it will be deleted. */
export const lb04ContractViewSchema = z.strictObject({
  id: z.uuid(),
  // The run its trace is under: the contract's own id, named from the first answer so the Scope can follow it live.
  runId: z.uuid(),
  title: z.string().min(1).max(LB04_LIMITS.maxTitleLength),
  origin: z.enum(['upload', 'sample']),
  sampleId: sampleId.nullable(),
  state: z.enum(LB04_STATES),
  failure: lb04FailureSchema.nullable(),
  // The page count, once the file has been opened.
  pages: z.int().min(1).max(LB04_LIMITS.maxPages).nullable(),
  createdAt: z.iso.datetime(),
  // When the file, its text and its report are deleted.
  expiresAt: z.iso.datetime(),
  redlinesLeft: z.int().min(0).max(LB04_LIMITS.redlinesPerContract),
  notLegalAdvice: label,
})

/** The text of every page of a contract, as the server extracted it: what the citations count characters in. */
export const lb04PagesViewSchema = z.strictObject({
  pages: z.array(z.strictObject({
    page: z.int().min(1).max(LB04_LIMITS.maxPages),
    text: z.string().max(LB04_LIMITS.maxTextChars),
  })).min(1).max(LB04_LIMITS.maxPages),
})

/** The PDF itself, for the viewer, as base64 inside JSON because the site's server forwards nothing else. */
export const lb04FileViewSchema = z.strictObject({
  contentType: z.literal('application/pdf'),
  size: z.int().min(1).max(LB04_LIMITS.maxFileBytes),
  base64: z.string().min(8).max(MAX_BASE64_CHARS),
})

// What every finding has, risk or absence.
const findingBase = {
  id: z.string().regex(/^f\d{1,3}$/),
  topic,
  // The playbook's rule it rests on, and that rule's title, which the playbook writes and the model does not.
  rule: ruleId,
  title: z.string().min(1).max(80),
  severity,
  // A plain sentence or two on why it matters, written by the model (or by the playbook for a detector's finding).
  summary: z.string().min(1).max(500),
  source: z.enum(['model', 'detector']),
}

/** A passage that conflicts with the playbook. The quote is the contract's own text at the citation, checked by the server, never the model's wording. */
export const lb04RiskFindingSchema = z.strictObject({
  ...findingBase,
  kind: z.literal('risk'),
  // The clause number as printed ("9.1"), when the passage has one.
  clause: z.string().min(1).max(20).nullable(),
  citation: lb04CitationSchema,
  quote: z.string().min(1).max(LB04_LIMITS.maxQuoteChars),
})

/** A clause the playbook expects and the contract does not have. It has no quote, and says what the server searched the whole text for. */
export const lb04AbsentFindingSchema = z.strictObject({
  ...findingBase,
  kind: z.literal('absent'),
  searched: z.array(z.string().min(1).max(60)).min(1).max(24),
})

/** One finding of a report: a risk with its quote, or a missing clause. */
export const lb04FindingSchema = z.discriminatedUnion('kind', [lb04RiskFindingSchema, lb04AbsentFindingSchema])

/** One topic's place on the radar: its worst verified finding, from 0 (none) to 4 (critical), and how many findings it has. */
export const lb04RadarScoreSchema = z.strictObject({
  topic,
  score: z.int().min(0).max(4),
  findings: z.int().min(0).max(LB04_LIMITS.maxFindings),
})

/** What the verifier did: how many findings it checked, kept and dropped, and why. Dropped findings are counted, never shown. */
export const lb04VerificationSchema = z.strictObject({
  checked: z.int().min(0).max(1_000),
  kept: z.int().min(0).max(LB04_LIMITS.maxFindings),
  dropped: z.int().min(0).max(1_000),
  reasons: z.record(z.enum(LB04_DROP_REASONS), z.int().min(0).max(1_000)),
})

/** What the injection screen found: whether the contract talks to its reviewer, and where. */
export const lb04ScreenSchema = z.strictObject({
  verdict: z.enum(['clean', 'flagged', 'unchecked']),
  // The guard model's highest injection probability over what it read, or null when it could not be asked.
  guardScore: z.number().min(0).max(1).nullable(),
  // Passages that address an AI reviewer. The review treats them as contract text, and no finding may rest on one.
  passages: z.array(lb04CitationSchema).max(8),
})

/** One piece of a redline: text both versions share, text only the contract has (deleted), or text only the proposal has (inserted). */
export const lb04DiffPartSchema = z.strictObject({
  op: z.enum(['equal', 'delete', 'insert']),
  text: z.string().min(1).max(2_000),
})

/** A proposed change to one finding's passage: the contract's words, the proposal and the word-level difference the server computed. */
export const lb04RedlineSchema = z.strictObject({
  findingId: z.string().regex(/^f\d{1,3}$/),
  // The contract's own words (empty for a missing clause, where the whole proposal is new text).
  original: z.string().max(LB04_LIMITS.maxQuoteChars),
  proposal: z.string().min(1).max(1_500),
  diff: z.array(lb04DiffPartSchema).max(1_000),
  // `model` when the model adapted the playbook's fallback wording to this clause, `playbook` when the wording is the playbook's own.
  source: z.enum(['model', 'playbook']),
  notLegalAdvice: label,
})

/** The review of one contract. Everything in it that cites the contract was checked against the contract's text. */
export const lb04ReportSchema = z.strictObject({
  contractId: z.uuid(),
  // The playbook's version, so a report says which rules it was read against.
  playbookVersion: z.int().min(1),
  findings: z.array(lb04FindingSchema).max(LB04_LIMITS.maxFindings),
  // One entry for each topic, in the playbook's order, worked out from the verified findings by code and by nothing else.
  radar: z.array(lb04RadarScoreSchema).length(LB04_TOPICS.length),
  verification: lb04VerificationSchema,
  screen: lb04ScreenSchema,
  // The model calls the review made, the injection check included.
  calls: z.int().min(0).max(8),
  redlines: z.array(lb04RedlineSchema).max(LB04_LIMITS.redlinesPerContract),
  notLegalAdvice: label,
})

/** What is left of a visitor's day, and the limits of the system. */
export const lb04LimitsViewSchema = z.strictObject({
  contracts: z.strictObject({
    limit: z.int().min(1),
    used: z.int().min(0),
    remaining: z.int().min(0),
  }),
  maxPages: z.int().min(1),
  maxFileBytes: z.int().min(1),
  keptMinutes: z.int().min(1),
  redlinesPerContract: z.int().min(1),
  // When the day's allowance starts again: the next 00:00 UTC.
  resetsAt: z.iso.datetime(),
})

/** One curated sample contract: its id, its title and its length. The board words its description from its own locale files. */
export const lb04SampleViewSchema = z.strictObject({
  id: sampleId,
  title: z.string().min(3).max(80),
  pages: z.int().min(1).max(LB04_LIMITS.maxPages),
})

/** One rule of the playbook as the board shows it: what is acceptable and what is a red flag. */
export const lb04RuleViewSchema = z.strictObject({
  id: ruleId,
  title: z.string().min(1).max(80),
  // `risk` rules flag a passage that is there; `required` rules flag a clause that is missing.
  kind: z.enum(['risk', 'required']),
  severity,
  acceptable: z.string().min(1).max(600),
  redFlag: z.string().min(1).max(600),
})

/** The playbook the reviews are read against, grouped by topic. It is data, and the owner edits it. */
export const lb04PlaybookViewSchema = z.strictObject({
  version: z.int().min(1),
  topics: z.array(z.strictObject({
    id: topic,
    title: z.string().min(1).max(60),
    summary: z.string().min(1).max(300),
    rules: z.array(lb04RuleViewSchema).min(1).max(8),
  })).length(LB04_TOPICS.length),
})

/** A request to make a contract review. */
export type Lb04CreateContractRequest = z.infer<typeof lb04CreateContractRequestSchema>
/** A range of one page's text. */
export type Lb04Citation = z.infer<typeof lb04CitationSchema>
/** A contract under review. */
export type Lb04ContractView = z.infer<typeof lb04ContractViewSchema>
/** The text of a contract's pages. */
export type Lb04PagesView = z.infer<typeof lb04PagesViewSchema>
/** The PDF of a contract. */
export type Lb04FileView = z.infer<typeof lb04FileViewSchema>
/** One finding: a risk with its quote, or a missing clause. */
export type Lb04Finding = z.infer<typeof lb04FindingSchema>
/** A finding that quotes the contract. */
export type Lb04RiskFinding = z.infer<typeof lb04RiskFindingSchema>
/** A finding about a clause that is missing. */
export type Lb04AbsentFinding = z.infer<typeof lb04AbsentFindingSchema>
/** One topic's place on the radar. */
export type Lb04RadarScore = z.infer<typeof lb04RadarScoreSchema>
/** What the verifier checked, kept and dropped. */
export type Lb04Verification = z.infer<typeof lb04VerificationSchema>
/** What the injection screen found. */
export type Lb04Screen = z.infer<typeof lb04ScreenSchema>
/** A proposed change to one finding, with its difference. */
export type Lb04Redline = z.infer<typeof lb04RedlineSchema>
/** One piece of a redline. */
export type Lb04DiffPart = z.infer<typeof lb04DiffPartSchema>
/** The review of one contract. */
export type Lb04Report = z.infer<typeof lb04ReportSchema>
/** What is left of a visitor's day. */
export type Lb04LimitsView = z.infer<typeof lb04LimitsViewSchema>
/** One curated sample. */
export type Lb04SampleView = z.infer<typeof lb04SampleViewSchema>
/** One rule of the playbook. */
export type Lb04RuleView = z.infer<typeof lb04RuleViewSchema>
/** The playbook. */
export type Lb04PlaybookView = z.infer<typeof lb04PlaybookViewSchema>
