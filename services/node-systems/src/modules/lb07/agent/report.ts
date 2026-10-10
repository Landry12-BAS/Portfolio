// Turning what a run made into its report, by code: the findings with their ids, the bug reports the
// model wrote once code has checked them against the findings, the verdict of the red-then-green
// verification, and the counts. The model's reports are validated by schema before they get here; this
// module drops the ones that rest on a finding the run does not have, or say the same thing twice.
import { LB07_LIMITS } from '@lb/contracts'
import type { Lb07BugReport, Lb07Finding, Lb07FindingKind, Lb07Verdict, Lb07VerificationPass } from '@lb/contracts'

import type { RunnerFinding } from '../runner/protocol.ts'

/** The kinds of finding that mean the shop has a bug. A blocked navigation is the sandbox's doing. */
export const BUG_KINDS: ReadonlySet<Lb07FindingKind> = new Set(['expectation_failed', 'console_error', 'failed_request', 'accessibility'])

/** Tells whether a finding means the shop has a bug. */
export function isBugFinding(finding: Pick<Lb07Finding, 'kind'>): boolean {
  return BUG_KINDS.has(finding.kind)
}

/** Gives the runner's findings their ids in order, keeping at most the limit and counting the rest. */
export class FindingLedger {
  readonly findings: Lb07Finding[] = []
  dropped = 0
  // What has been seen, by engine too: the same finding in the second engine is not news.
  readonly #seen = new Set<string>()

  /** Adds a finding with the evidence that shows it, unless an identical one is known (in any engine) or the limit is reached. Returns the finding kept, or undefined. */
  add(finding: RunnerFinding, evidenceIds: readonly string[] = []): Lb07Finding | undefined {
    const key = `${finding.kind}|${finding.rule ?? ''}|${finding.path ?? ''}|${finding.detail}`
    if (this.#seen.has(key)) return undefined
    this.#seen.add(key)
    if (this.findings.length >= LB07_LIMITS.maxFindings) {
      this.dropped += 1
      return undefined
    }
    const kept: Lb07Finding = { id: `f${this.findings.length + 1}`, ...finding, evidenceIds: [...evidenceIds] }
    this.findings.push(kept)
    return kept
  }

  /** How many findings mean a bug. */
  get bugFindings(): number {
    return this.findings.filter(isBugFinding).length
  }
}

/** Keeps the bug reports that rest on findings the run has, once each. Returns the kept reports and how many were dropped. */
export function checkReports(reports: readonly Lb07BugReport[], findings: readonly Lb07Finding[]): { kept: Lb07BugReport[], dropped: number } {
  const known = new Set(findings.filter(isBugFinding).map(finding => finding.id))
  const kept: Lb07BugReport[] = []
  const covered = new Set<string>()
  let dropped = 0
  for (const report of reports) {
    const unique = [...new Set(report.findingIds)]
    const ids = unique.filter(id => known.has(id))
    const fresh = ids.filter(id => !covered.has(id))
    if (ids.length !== unique.length || fresh.length === 0) {
      dropped += 1
      continue
    }
    for (const id of fresh) covered.add(id)
    kept.push({ ...report, findingIds: ids })
  }
  return { kept, dropped }
}

/** Tells whether a pass is red: a bug finding, or a step that did not pass. */
function isRedPass(pass: Lb07VerificationPass | null): boolean {
  return pass !== null && (pass.findings > 0 || !pass.stepsPassed)
}

/**
 * Decides the verdict of the verification. With bugs on, the test must be red with them on (a bug finding
 * or a step that did not pass, in either engine) and green on the clean shop (every step passed, no bug
 * finding). With no bug on, there is nothing to be red about: the test is `passing` when it is green.
 * Without a green pass (the plan could not be run to its end) nothing is proved.
 */
export function verdictOf(bugsOn: boolean, red: Lb07VerificationPass | null, cross: Lb07VerificationPass | null, green: Lb07VerificationPass | null): Lb07Verdict {
  if (green === null) return 'not_verified'
  const isGreen = green.stepsPassed && green.findings === 0
  if (!bugsOn) return isGreen ? 'passing' : 'discarded_not_green'
  if (red === null) return 'not_verified'
  if (!isRedPass(red) && !isRedPass(cross)) return 'discarded_not_red'
  return isGreen ? 'kept' : 'discarded_not_green'
}
