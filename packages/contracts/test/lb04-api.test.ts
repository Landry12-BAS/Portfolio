// Tests for LB-04's API shapes: the schemas accept what an honest answer holds and refuse what
// no honest answer does, and a risk finding can't be written without a quote and a citation.
import { describe, expect, it } from 'vitest'

import {
  LB04_LIMITS,
  LB04_TOPICS,
  lb04ContractViewSchema,
  lb04CreateContractRequestSchema,
  lb04FindingSchema,
  lb04PagesViewSchema,
  lb04RedlineSchema,
  lb04ReportSchema,
  lb04SampleViewSchema,
  lb04SeverityWeight,
  NOT_LEGAL_ADVICE,
} from '../src/index.ts'
import type { Lb04AbsentFinding, Lb04Report, Lb04RiskFinding } from '../src/index.ts'

const ID = '3f1c1f5e-7c3a-4e4e-9d49-0c6a3a5a1b01'

const risk: Lb04RiskFinding = {
  id: 'f1',
  kind: 'risk',
  topic: 'liability',
  rule: 'liability-cap',
  title: 'Liability is not capped',
  severity: 'critical',
  summary: 'The supplier\'s liability has no ceiling.',
  source: 'model',
  clause: '9.1',
  citation: { page: 2, start: 120, end: 190 },
  quote: 'The Supplier’s liability under this Agreement shall be unlimited',
}

const absent: Lb04AbsentFinding = {
  id: 'f2',
  kind: 'absent',
  topic: 'indemnity',
  rule: 'indemnity-present',
  title: 'No indemnity',
  severity: 'medium',
  summary: 'The contract has no indemnity clause.',
  source: 'detector',
  searched: ['indemnify', 'indemnification'],
}

/** A report that is valid, with one finding of each kind. */
function report(): Lb04Report {
  return {
    contractId: ID,
    playbookVersion: 1,
    findings: [risk, absent],
    radar: LB04_TOPICS.map(topic => ({ topic, score: topic === 'liability' ? 4 : 0, findings: topic === 'liability' ? 1 : 0 })),
    verification: { checked: 3, kept: 2, dropped: 1, reasons: { quote_not_found: 1, quote_too_short: 0, quote_too_long: 0, quote_in_instruction: 0, unknown_rule: 0, topic_mismatch: 0, absent_contradicted: 0, duplicate: 0, over_limit: 0 } },
    screen: { verdict: 'clean', guardScore: 0.0004, passages: [], passageCount: 0 },
    calls: 3,
    calibrated: true,
    redlines: [],
    notLegalAdvice: NOT_LEGAL_ADVICE,
  }
}

describe('a finding', () => {
  it('is a risk with its quote and citation, or an absence with what was searched for', () => {
    expect(lb04FindingSchema.safeParse(risk).success).toBe(true)
    expect(lb04FindingSchema.safeParse(absent).success).toBe(true)
  })

  it('can not be a risk without a quote or a citation', () => {
    const { quote: _quote, ...noQuote } = risk
    const { citation: _citation, ...noCitation } = risk

    expect(lb04FindingSchema.safeParse(noQuote).success).toBe(false)
    expect(lb04FindingSchema.safeParse(noCitation).success).toBe(false)
    expect(lb04FindingSchema.safeParse({ ...risk, quote: null }).success).toBe(false)
  })

  it('can not be an absence that carries a quote, and must say what was searched', () => {
    expect(lb04FindingSchema.safeParse({ ...absent, quote: 'x'.repeat(20) }).success).toBe(false)
    expect(lb04FindingSchema.safeParse({ ...absent, searched: [] }).success).toBe(false)
  })

  it('refuses a citation that ends before it starts, a page outside the limit and an unknown topic or severity', () => {
    expect(lb04FindingSchema.safeParse({ ...risk, citation: { page: 2, start: 50, end: 50 } }).success).toBe(false)
    expect(lb04FindingSchema.safeParse({ ...risk, citation: { page: LB04_LIMITS.maxPages + 1, start: 0, end: 5 } }).success).toBe(false)
    expect(lb04FindingSchema.safeParse({ ...risk, topic: 'tax' }).success).toBe(false)
    expect(lb04FindingSchema.safeParse({ ...risk, severity: 'catastrophic' }).success).toBe(false)
  })
})

describe('a report', () => {
  it('is accepted with one radar entry for every topic', () => {
    expect(lb04ReportSchema.safeParse(report()).success).toBe(true)
  })

  it('refuses a radar that misses a topic, an unknown field, and a missing label', () => {
    expect(lb04ReportSchema.safeParse({ ...report(), radar: report().radar.slice(1) }).success).toBe(false)
    expect(lb04ReportSchema.safeParse({ ...report(), extra: true }).success).toBe(false)
    expect(lb04ReportSchema.safeParse({ ...report(), notLegalAdvice: 'Legal advice' }).success).toBe(false)
  })

  it('refuses more findings than the limit', () => {
    const many = Array.from({ length: LB04_LIMITS.maxFindings + 1 }, (_, index) => ({ ...risk, id: `f${index + 1}` }))

    expect(lb04ReportSchema.safeParse({ ...report(), findings: many }).success).toBe(false)
  })

  it('shows at most eight passages that talk to a reviewer, and counts all of them', () => {
    const passage = { page: 1, start: 10, end: 80 }
    const screen = (shown: number, count: number) => ({ verdict: 'flagged', guardScore: 0.97, passages: Array.from({ length: shown }, () => passage), passageCount: count })

    expect(lb04ReportSchema.safeParse({ ...report(), screen: screen(8, 11) }).success).toBe(true)
    expect(lb04ReportSchema.safeParse({ ...report(), screen: screen(9, 9) }).success).toBe(false)
    expect(lb04ReportSchema.safeParse({ ...report(), screen: screen(1, 65) }).success).toBe(false)
    expect(lb04ReportSchema.safeParse({ ...report(), screen: { verdict: 'flagged', guardScore: 0.97, passages: [passage] } }).success).toBe(false)
  })
})

describe('a sample contract', () => {
  it('may be longer than the limit, since a sample shows what the system refuses, and may not be absurdly long or empty', () => {
    const sample = { id: 'master-supply-31', title: 'Master supply agreement, 31 pages', pages: LB04_LIMITS.maxPages + 1 }

    expect(lb04SampleViewSchema.safeParse(sample).success).toBe(true)
    expect(lb04SampleViewSchema.safeParse({ ...sample, pages: 0 }).success).toBe(false)
    expect(lb04SampleViewSchema.safeParse({ ...sample, pages: 201 }).success).toBe(false)
    expect(lb04SampleViewSchema.safeParse({ ...sample, id: '../etc/passwd' }).success).toBe(false)
  })
})

describe('a contract, its pages and a redline', () => {
  const contract = {
    id: ID,
    runId: ID,
    title: 'wholesale-supply.pdf',
    origin: 'upload',
    sampleId: null,
    state: 'analysing',
    failure: null,
    pages: 12,
    createdAt: '2026-10-02T10:00:00.000Z',
    expiresAt: '2026-10-02T11:00:00.000Z',
    redlinesLeft: 3,
    notLegalAdvice: NOT_LEGAL_ADVICE,
  }

  it('accepts a contract in each state and refuses one in a state that does not exist', () => {
    expect(lb04ContractViewSchema.safeParse(contract).success).toBe(true)
    expect(lb04ContractViewSchema.safeParse({ ...contract, state: 'failed', failure: { code: 'too_many_pages', message: 'Too long.' } }).success).toBe(true)
    expect(lb04ContractViewSchema.safeParse({ ...contract, state: 'sleeping' }).success).toBe(false)
    expect(lb04ContractViewSchema.safeParse({ ...contract, failure: { code: 'because', message: 'x' } }).success).toBe(false)
  })

  it('accepts pages and refuses an empty list or more pages than the limit', () => {
    const page = (number: number) => ({ page: number, text: 'text' })

    expect(lb04PagesViewSchema.safeParse({ pages: [page(1), page(2)] }).success).toBe(true)
    expect(lb04PagesViewSchema.safeParse({ pages: [] }).success).toBe(false)
    expect(lb04PagesViewSchema.safeParse({ pages: Array.from({ length: LB04_LIMITS.maxPages + 1 }, (_, index) => page(index + 1)) }).success).toBe(false)
  })

  it('accepts a redline made of equal, deleted and inserted words', () => {
    const redline = {
      findingId: 'f1',
      original: 'liability shall be unlimited',
      proposal: 'liability shall be limited to the fees paid',
      diff: [{ op: 'equal', text: 'liability shall be ' }, { op: 'delete', text: 'unlimited' }, { op: 'insert', text: 'limited to the fees paid' }],
      source: 'model',
      notLegalAdvice: NOT_LEGAL_ADVICE,
    }

    expect(lb04RedlineSchema.safeParse(redline).success).toBe(true)
    expect(lb04RedlineSchema.safeParse({ ...redline, diff: [{ op: 'replace', text: 'x' }] }).success).toBe(false)
  })
})

describe('what a visitor may send', () => {
  it('is a sample by its id, or a PDF as base64 with a name', () => {
    expect(lb04CreateContractRequestSchema.safeParse({ from: 'sample', sampleId: 'wholesale-supply' }).success).toBe(true)
    expect(lb04CreateContractRequestSchema.safeParse({ from: 'upload', filename: 'a.pdf', contentBase64: 'JVBERi0xLjQK' }).success).toBe(true)
  })

  it('refuses anything else: another source, an unknown field, a sample id with a slash and a file bigger than the limit', () => {
    expect(lb04CreateContractRequestSchema.safeParse({ from: 'url', url: 'https://example.com/a.pdf' }).success).toBe(false)
    expect(lb04CreateContractRequestSchema.safeParse({ from: 'sample', sampleId: 'a', extra: 1 }).success).toBe(false)
    expect(lb04CreateContractRequestSchema.safeParse({ from: 'sample', sampleId: '../etc/passwd' }).success).toBe(false)
    const tooBig = 'A'.repeat(Math.ceil(LB04_LIMITS.maxFileBytes / 3) * 4 + 2_048)
    expect(lb04CreateContractRequestSchema.safeParse({ from: 'upload', filename: 'a.pdf', contentBase64: tooBig }).success).toBe(false)
  })

  it('lets a file only just over the limit through the request\'s form, so the service can tell the sender it is too large and not that the form is wrong', () => {
    const justOver = 'A'.repeat(Math.ceil(LB04_LIMITS.maxFileBytes / 3) * 4 + 12)

    expect(lb04CreateContractRequestSchema.safeParse({ from: 'upload', filename: 'a.pdf', contentBase64: justOver }).success).toBe(true)
  })
})

describe('severity', () => {
  it('weighs 1 for low up to 4 for critical', () => {
    expect(['low', 'medium', 'high', 'critical'].map(severity => lb04SeverityWeight(severity as 'low'))).toEqual([1, 2, 3, 4])
  })
})
