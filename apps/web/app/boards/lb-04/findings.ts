// How the board orders and filters a report's findings: the most serious first, and, among equals, the
// ones with a passage before the missing clauses, in the order the contract has them. Pure functions of
// the report, so what the list shows is the same however the visitor filters it.
import { LB04_SEVERITIES, lb04SeverityWeight } from '@lb/contracts'
import type { Lb04Citation, Lb04Finding, Lb04Severity, Lb04Topic } from '@lb/contracts'

/** What narrows the list of findings: one topic and one severity, or either, or neither. */
export interface FindingFilter {
  topic?: Lb04Topic
  severity?: Lb04Severity
}

/** Where a finding sits in the contract: its citation, or nothing for a clause that is missing. */
export function citationOf(finding: Lb04Finding): Lb04Citation | undefined {
  return finding.kind === 'risk' ? finding.citation : undefined
}

/** Orders findings for the list: severity first, then risks before missing clauses, then by place in the contract, then by ID. */
export function sortFindings(findings: readonly Lb04Finding[]): Lb04Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = lb04SeverityWeight(b.severity) - lb04SeverityWeight(a.severity)
    if (bySeverity !== 0) return bySeverity
    if (a.kind !== b.kind) return a.kind === 'risk' ? -1 : 1
    const first = citationOf(a)
    const second = citationOf(b)
    if (first && second && (first.page !== second.page || first.start !== second.start)) return first.page - second.page || first.start - second.start
    return a.id.localeCompare(b.id, 'en', { numeric: true })
  })
}

/** Keeps the findings that match the filter. */
export function filterFindings(findings: readonly Lb04Finding[], filter: FindingFilter): Lb04Finding[] {
  return findings.filter(finding => (filter.topic === undefined || finding.topic === filter.topic) && (filter.severity === undefined || finding.severity === filter.severity))
}

/** Counts findings by severity, in the order of the severities, with a zero for each that has none. */
export function countBySeverity(findings: readonly Lb04Finding[]): { severity: Lb04Severity, count: number }[] {
  return [...LB04_SEVERITIES].reverse().map(severity => ({ severity, count: findings.filter(finding => finding.severity === severity).length }))
}

/** Finds a finding by its ID. */
export function findingById(findings: readonly Lb04Finding[], id: string | undefined): Lb04Finding | undefined {
  return id === undefined ? undefined : findings.find(finding => finding.id === id)
}
