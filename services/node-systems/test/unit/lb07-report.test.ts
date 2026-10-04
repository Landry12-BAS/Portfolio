// The report's rules: findings get their ids in order and are kept once, bug reports that name findings the
// run does not have (or repeat one) are dropped, and the verdict follows red-then-green.
import { describe, expect, it } from 'vitest'

import { checkReports, FindingLedger, verdictOf } from '../../src/modules/lb07/agent/report.ts'
import type { RunnerFinding } from '../../src/modules/lb07/runner/protocol.ts'

/** A runner finding to order. */
function made(overrides: Partial<RunnerFinding> = {}): RunnerFinding {
  return { kind: 'expectation_failed', engine: 'chromium', stepIndex: 2, title: 'The page does not say what was expected', detail: 'expected "Total €26.10"; the page says "Total €23.20"', rule: null, path: '/cart', ...overrides }
}

describe('the finding ledger', () => {
  it('numbers findings in order, keeps each once whatever the engine, and counts what is over the limit', () => {
    const ledger = new FindingLedger()
    expect(ledger.add(made(), ['e1'])).toMatchObject({ id: 'f1', evidenceIds: ['e1'] })
    expect(ledger.add(made({ engine: 'firefox-ua' }))).toBeUndefined()
    expect(ledger.add(made({ kind: 'console_error', detail: 'TypeError' }))).toMatchObject({ id: 'f2' })
    for (let index = 0; index < 50; index += 1) ledger.add(made({ detail: `other ${index}` }))
    expect(ledger.findings).toHaveLength(40)
    expect(ledger.dropped).toBe(12)
    expect(ledger.bugFindings).toBe(40)
    ledger.add(made({ kind: 'blocked_navigation', detail: 'A link to http://evil' }))
    expect(ledger.dropped).toBe(13)
  })
})

describe('the bug reports', () => {
  const findings = (() => {
    const ledger = new FindingLedger()
    ledger.add(made())
    ledger.add(made({ kind: 'console_error', detail: 'TypeError' }))
    ledger.add(made({ kind: 'blocked_navigation', detail: 'blocked' }))
    return ledger.findings
  })()
  const report = { title: 'The coupon applies twice', steps: ['Add two bags.', 'Apply WELCOME10.'], expected: 'Total €26.10', actual: 'Total €23.20', severity: 'high' as const }

  it('keeps a report that rests on known bug findings, once per finding, and drops the rest', () => {
    const checked = checkReports([
      { ...report, findingIds: ['f1'] },
      { ...report, findingIds: ['f1'] },
      { ...report, findingIds: ['f9'] },
      { ...report, findingIds: ['f3'] },
      { ...report, findingIds: ['f2', 'f2'] },
    ], findings)
    expect(checked.kept.map(entry => entry.findingIds)).toEqual([['f1'], ['f2']])
    expect(checked.dropped).toBe(3)
  })
})

describe('the verdict', () => {
  const pass = (bugsOn: boolean, stepsPassed: boolean, findings: number) => ({ engine: 'chromium' as const, bugsOn, stepsPassed, findings, durationMs: 1 })

  it('is kept when red with the bugs on and green with them off, and discarded otherwise', () => {
    expect(verdictOf(true, pass(true, true, 1), null, pass(false, true, 0))).toBe('kept')
    expect(verdictOf(true, pass(true, false, 0), null, pass(false, true, 0))).toBe('kept')
    expect(verdictOf(true, pass(true, true, 0), null, pass(false, true, 0))).toBe('discarded_not_red')
    expect(verdictOf(true, pass(true, true, 1), null, pass(false, false, 0))).toBe('discarded_not_green')
    expect(verdictOf(true, pass(true, true, 1), null, pass(false, true, 1))).toBe('discarded_not_green')
  })

  it('counts a bug the second engine alone found as red', () => {
    expect(verdictOf(true, pass(true, true, 0), pass(true, true, 1), pass(false, true, 0))).toBe('kept')
    expect(verdictOf(true, pass(true, true, 0), pass(true, true, 0), pass(false, true, 0))).toBe('discarded_not_red')
  })

  it('is passing on a clean shop when the test is green, and not verified without a green pass', () => {
    expect(verdictOf(false, null, null, pass(false, true, 0))).toBe('passing')
    expect(verdictOf(false, null, null, pass(false, false, 0))).toBe('discarded_not_green')
    expect(verdictOf(false, null, null, null)).toBe('not_verified')
    expect(verdictOf(true, null, null, pass(false, true, 0))).toBe('not_verified')
  })
})
