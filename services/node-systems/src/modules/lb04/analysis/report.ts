// Assembling the report. What the models contribute is limited here, by code, in three ways:
//
//   - A finding's rule, title, topic and quote come from the playbook and the contract, never from a
//     model's wording. The second model only offers a severity and a sentence for each.
//   - A severity is held to within one step of the rule's own: a model that was told to rate
//     everything "low" can lower a critical finding to high, and no further.
//   - A sentence that says the passage is harmless, or that the contract has no risks, is replaced
//     by the playbook's own sentence for the rule. Every finding is a finding against the playbook.
//
// The radar is worked out from the findings by code and by nothing else, so no model's say-so can
// make it greener than the verified findings are.
import { foldQuote, LB04_LIMITS, LB04_SEVERITIES, LB04_TOPICS, lb04SeverityWeight, NOT_LEGAL_ADVICE } from '@lb/contracts'
import type { Lb04Finding, Lb04RadarScore, Lb04Report, Lb04Screen, Lb04Severity } from '@lb/contracts'

import type { Playbook, PlaybookRule } from '../playbook/playbook.ts'
import type { ReportAnswer } from './answers.ts'
import type { DropCounts, MissingClause, VerifiedNote } from './verify.ts'

// The longest summary a finding carries.
const SUMMARY_LIMIT = 500
// Phrases that call a passage harmless or the contract free of risk. A summary with one of them, ignoring spaces, hyphens and capitals, is not used.
const DENIALS = ['no risk', 'not a risk', 'no real risk', 'safe to sign', 'nothing to flag', 'no issues', 'no findings', 'is harmless', 'is fine', 'ignore all', 'ignore previous']

/** Holds a proposed severity to within one step of the rule's own, and uses the rule's own when none is proposed. */
export function clampSeverity(base: Lb04Severity, proposed: Lb04Severity | undefined): Lb04Severity {
  if (proposed === undefined) return base
  const baseIndex = LB04_SEVERITIES.indexOf(base)
  const proposedIndex = LB04_SEVERITIES.indexOf(proposed)
  const clamped = Math.min(Math.max(proposedIndex, baseIndex - 1), baseIndex + 1)
  return LB04_SEVERITIES[Math.min(Math.max(clamped, 0), LB04_SEVERITIES.length - 1)] as Lb04Severity
}

/** Returns a model's summary when it can be used, and the playbook's own sentence for the rule when it can't. */
export function chooseSummary(proposed: string | undefined, rule: PlaybookRule): string {
  const cleaned = (proposed ?? '').replaceAll(/\s+/g, ' ').trim()
  if (cleaned === '') return rule.summary
  const key = foldQuote(cleaned)
  if (DENIALS.some(denial => key.includes(foldQuote(denial)))) return rule.summary
  return cleaned.slice(0, SUMMARY_LIMIT)
}

/** One topic's place on the radar for each of the playbook's topics, worked out from the findings: the weight of its worst finding. */
export function radarOf(findings: readonly Lb04Finding[]): Lb04RadarScore[] {
  return LB04_TOPICS.map((topic) => {
    const ofTopic = findings.filter(finding => finding.topic === topic)
    return { topic, score: Math.max(0, ...ofTopic.map(finding => lb04SeverityWeight(finding.severity))), findings: ofTopic.length }
  })
}

/** What the report is made from. */
export interface ReportParts {
  contractId: string
  playbook: Playbook
  // The notes that were found in the contract, in the order they come in it.
  notes: readonly VerifiedNote[]
  // The clauses that are missing.
  missing: readonly MissingClause[]
  // What the second model said about them, or undefined when its answer could not be used.
  calibration: ReportAnswer | undefined
  screen: Lb04Screen
  drops: DropCounts
  // The model calls the review made.
  calls: number
}

/** Builds one risk finding. `index` is the note's place in the list the second model was shown, which names it `n1`, `n2`, and so on. */
function riskFinding(note: VerifiedNote, index: number, calibration: ReportAnswer | undefined): Lb04Finding {
  const said = calibration?.findings.find(entry => entry.note === `n${index + 1}`)
  return {
    id: '',
    kind: 'risk',
    topic: note.rule.topic,
    rule: note.rule.id,
    title: note.rule.title,
    severity: clampSeverity(note.rule.severity, said?.severity),
    summary: chooseSummary(said?.summary, note.rule),
    source: 'model',
    clause: note.clause,
    citation: note.citation,
    quote: note.quote,
  }
}

/** Builds one finding about a missing clause. */
function absentFinding(entry: MissingClause, calibration: ReportAnswer | undefined): Lb04Finding {
  const said = calibration?.missing.find(candidate => candidate.rule === entry.rule.id)
  return {
    id: '',
    kind: 'absent',
    topic: entry.rule.topic,
    rule: entry.rule.id,
    title: entry.rule.title,
    severity: clampSeverity(entry.rule.severity, said?.severity),
    summary: chooseSummary(said?.summary, entry.rule),
    source: entry.source,
    searched: [...entry.rule.phrases],
  }
}

/** Counts how many findings were dropped in all. */
function totalDropped(drops: DropCounts): number {
  return Object.values(drops).reduce((total, count) => total + count, 0)
}

/** Keeps at most the limit of findings: the most serious ones, with ties going to the ones that come first, and in the order they came. */
function mostSerious(all: readonly Lb04Finding[]): Lb04Finding[] {
  if (all.length <= LB04_LIMITS.maxFindings) return [...all]
  const ranked = all.map((finding, position) => ({ finding, position })).sort((a, b) => lb04SeverityWeight(b.finding.severity) - lb04SeverityWeight(a.finding.severity) || a.position - b.position)
  return ranked.slice(0, LB04_LIMITS.maxFindings).sort((a, b) => a.position - b.position).map(entry => entry.finding)
}

/**
 * Builds the report from what the checks kept and what the second model said. Findings come in the
 * order of the contract, then the missing clauses in the playbook's order, with ids f1, f2, and so on.
 * A review has at most 24 findings: the most serious are kept, and the rest are counted as dropped.
 */
export function buildReport(parts: ReportParts): Lb04Report {
  const risks = parts.notes.map((note, index) => riskFinding(note, index, parts.calibration))
  const absences = parts.missing.map(entry => absentFinding(entry, parts.calibration))
  const drops = { ...parts.drops }
  const all = [...risks, ...absences]
  const findings = mostSerious(all).map((finding, index) => ({ ...finding, id: `f${index + 1}` }) as Lb04Finding)
  drops.over_limit += all.length - findings.length
  return {
    contractId: parts.contractId,
    playbookVersion: parts.playbook.version,
    findings,
    radar: radarOf(findings),
    verification: { checked: findings.length + totalDropped(drops), kept: findings.length, dropped: totalDropped(drops), reasons: drops },
    screen: parts.screen,
    calls: parts.calls,
    // A report with nothing to rate counts as calibrated: there is no severity or sentence the playbook had to stand in for.
    calibrated: parts.calibration !== undefined || findings.length === 0,
    redlines: [],
    notLegalAdvice: NOT_LEGAL_ADVICE,
  }
}
