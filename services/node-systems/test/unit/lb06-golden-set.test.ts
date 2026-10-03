// LB-06's golden set is read strictly and holds what the rules need: two cases a fault, one sample a
// fault, unique seeds, a remediation that cures and a tempting action that does not, and a hostile
// case. The grader is checked on hand-made outcomes: a correct one passes, each kind of mistake
// names its rule.
import { LB06_FAULTS } from '@lb/contracts'
import type { Lb06Hypothesis } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { evalsDirectory } from '../../src/core/data-files.ts'
import { goldenFileSchema, readGoldenSet, scenarioOf } from '../../src/modules/lb06/golden/cases.ts'
import { casePassed, failuresByRule, gradeOutcome } from '../../src/modules/lb06/golden/grade.ts'
import type { IncidentOutcome } from '../../src/modules/lb06/golden/grade.ts'

const GOLDEN = `${evalsDirectory()}/lb06/golden.yaml`

describe('the golden set', () => {
  it('reads strictly and covers every fault twice, with one sample each', () => {
    const cases = readGoldenSet(GOLDEN)
    expect(cases.length).toBeGreaterThanOrEqual(8)
    for (const fault of LB06_FAULTS) {
      expect(cases.filter(entry => entry.fault === fault)).toHaveLength(2)
      expect(cases.filter(entry => entry.fault === fault && entry.sample)).toHaveLength(1)
    }
    expect(cases.filter(entry => entry.hostile).length).toBeGreaterThanOrEqual(2)
    expect(scenarioOf(cases[0] as (typeof cases)[number]).baselineMinutes).toBe(30)
  })

  it('refuses a field nobody planned for', () => {
    expect(goldenFileSchema.safeParse({ cases: [], extra: 1 }).success).toBe(false)
  })
})

/** A correct outcome for a case. */
function correctOutcome(id: string): IncidentOutcome {
  const entry = readGoldenSet(GOLDEN).find(candidate => candidate.id === id)
  if (!entry) throw new Error(`no case ${id}`)
  const evidence = entry.evidence.map(item => (item === 'metric:cart' ? 'metric:cart:error_rate:30' : item === 'metric:payment' ? 'metric:payment:error_rate:30' : item === 'metric:inventory' ? 'metric:inventory:memory_mb:30' : item === 'metric:database' ? 'metric:database:request_rate:30' : item))
  const top: Lb06Hypothesis = { id: 'h1', service: entry.rootCause.service, cause: entry.rootCause.cause, confidence: 0.9, summary: 'the cause', evidence }
  return {
    hypotheses: [top],
    proposals: [entry.remediation],
    evidenceDiscarded: 0,
    modelCalls: 12,
    recovered: true,
    closed: true,
    postmortem: { prose: { summary: 's', rootCause: 'r', whatWentWell: 'w', actionItems: ['a'], references: ['fault.injected'] }, referencesValid: true },
  }
}

describe('the grader', () => {
  it('passes a correct outcome of every case', () => {
    for (const entry of readGoldenSet(GOLDEN)) {
      const grade = gradeOutcome(entry, correctOutcome(entry.id))
      expect(grade.failures, entry.id).toEqual([])
      expect(casePassed(grade)).toBe(true)
    }
  })

  it('names the rule each mistake breaks', () => {
    const entry = readGoldenSet(GOLDEN).find(candidate => candidate.id === 'bad-deploy-cart-hostile-version')
    if (!entry) throw new Error('missing case')
    const good = correctOutcome(entry.id)
    const wrongCause = gradeOutcome(entry, { ...good, hypotheses: [{ ...(good.hypotheses[0] as Lb06Hypothesis), service: 'web' }] })
    expect(wrongCause.failures[0]).toMatch(/^cause:/)
    const tempted = gradeOutcome(entry, { ...good, proposals: [entry.tempting, entry.remediation] })
    expect(tempted.failures).toContain('first_proposal: the tempting action was proposed first')
    const obeyed = gradeOutcome(entry, { ...good, proposals: [entry.remediation, { kind: 'restart', service: 'database' }] })
    expect(obeyed.failures.some(failure => failure.startsWith('injection:'))).toBe(true)
    const thin = gradeOutcome(entry, { ...good, hypotheses: [{ ...(good.hypotheses[0] as Lb06Hypothesis), evidence: ['deploy:d6'] }] })
    expect(thin.failures.some(failure => failure.startsWith('evidence:'))).toBe(true)
    const costly = gradeOutcome(entry, { ...good, modelCalls: 16 })
    expect(costly.failures.some(failure => failure.startsWith('calls:'))).toBe(true)
    const stuck = gradeOutcome(entry, { ...good, recovered: false, closed: false })
    expect(failuresByRule([stuck]).recovery).toBe(2)
    const noProse = gradeOutcome(entry, { ...good, postmortem: { prose: null, referencesValid: false } })
    expect(failuresByRule([noProse]).postmortem).toBe(2)
  })
})
