// Tests for LB-08's golden set: it follows its own rules, every case can be met, and the
// rules it grades with catch what they are meant to catch. The set grades the live model,
// so a mistake in it would pass a wrong answer or fail a right one.
import { connectorIds, issueCodes, triggerEventIds, validateWorkflow } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { goldenFileSchema } from '../../src/modules/lb08/golden/cases.ts'
import type { GoldenCase } from '../../src/modules/lb08/golden/cases.ts'
import { evaluate, failuresByCheck, passRate, totalModelCalls } from '../../src/modules/lb08/golden/evaluate.ts'
import { gradeGraph } from '../../src/modules/lb08/golden/grade.ts'
import type { DescribeWorkflow } from '../../src/modules/lb08/generate/outcome.ts'
import { loadGolden, loadSamples, loadStock } from '../support/data.ts'

const golden = loadGolden()

/** Returns the cases of one kind. */
function casesOf<Kind extends GoldenCase['kind']>(kind: Kind): Extract<GoldenCase, { kind: Kind }>[] {
  return golden.filter((entry): entry is Extract<GoldenCase, { kind: Kind }> => entry.kind === kind)
}

describe('the golden set', () => {
  it('holds between 20 and 50 cases, as the playbook asks', () => {
    expect(golden.length).toBeGreaterThanOrEqual(20)
    expect(golden.length).toBeLessThanOrEqual(50)
  })

  it('has cases of every kind, in English and in Czech', () => {
    expect(new Set(golden.map(entry => entry.kind))).toEqual(new Set(['build', 'reject', 'resist']))
    expect(new Set(golden.map(entry => entry.language))).toEqual(new Set(['en', 'cs']))
    expect(casesOf('reject').length).toBeGreaterThanOrEqual(8)
    expect(casesOf('resist').length).toBeGreaterThanOrEqual(3)
  })

  it('has unique ids', () => {
    expect(new Set(golden.map(entry => entry.id)).size).toBe(golden.length)
  })

  it('covers every connector and every trigger event in a case that builds', () => {
    const connectors = new Set(casesOf('build').flatMap(entry => entry.expect.connectors ?? []))
    const triggers = new Set(casesOf('build').map(entry => entry.expect.trigger))

    expect(connectors).toEqual(new Set(connectorIds))
    expect(triggers).toEqual(new Set(triggerEventIds))
  })

  it('has a curated sample in each language, and each sample is a case', () => {
    const samples = casesOf('build').filter(entry => entry.sample)

    expect(new Set(samples.map(entry => entry.language))).toEqual(new Set(['en', 'cs']))
    expect(samples.map(entry => entry.description).sort()).toEqual(loadSamples().map(sample => sample.description).sort())
  })

  it('asks for the failures a validator must refuse: a missing connector, a loop, a fan-out, a URL, a script', () => {
    const reasons = new Set(casesOf('reject').flatMap(entry => entry.rejects))

    for (const reason of ['unknown_connector', 'unknown_trigger', 'cycle', 'too_many_nodes', 'fan_out', 'invalid_param', 'unknown_node_type', 'multiple_triggers', 'unknown_reference'] as const) {
      expect(reasons, reason).toContain(reason)
    }
  })

  it('writes every description in the language it says', () => {
    for (const entry of golden.filter(item => item.language === 'cs')) {
      expect(entry.description, entry.id).toMatch(/[áčďéěíňóřšťúůýž]/i)
    }
    for (const entry of golden.filter(item => item.language === 'en')) {
      expect(entry.description, entry.id).not.toMatch(/[ěščřžýů]/i)
    }
  })
})

describe('every case can be met', () => {
  it.each(casesOf('build').map(entry => [entry.id, entry] as const))('%s: its reference passes validation and its own rules', (_id, entry) => {
    const checked = validateWorkflow(entry.reference)

    expect(checked.issues, 'validation').toEqual([])
    expect(gradeGraph(entry.expect, entry.reference), 'rules').toEqual([])
  })

  it.each(casesOf('reject').map(entry => [entry.id, entry] as const))('%s: validation refuses its attempt, for the reasons listed', (_id, entry) => {
    const checked = validateWorkflow(entry.attempt)

    expect(checked.ok).toBe(false)
    const codes = checked.issues.map(issue => issue.code)
    for (const reason of entry.rejects) expect(codes).toContain(reason)
  })

  it.each(casesOf('resist').map(entry => [entry.id, entry] as const))('%s: the reference resists, and a workflow that obeys the injection is caught', (_id, entry) => {
    expect(validateWorkflow(entry.reference).issues, 'reference validation').toEqual([])
    expect(gradeGraph(entry.expect, entry.reference), 'reference rules').toEqual([])
    // The injection's own workflow is valid, so only the rules can stop it.
    expect(validateWorkflow(entry.complies).issues, 'complying graph validation').toEqual([])
    expect(gradeGraph(entry.expect, entry.complies).length, 'complying graph rules').toBeGreaterThan(0)
  })

  it('knows only issue codes the validator can report', () => {
    for (const entry of casesOf('reject')) {
      for (const reason of entry.rejects) expect(issueCodes).toContain(reason)
    }
  })
})

describe('the data the cases refer to', () => {
  it('uses only products that are in stock.yaml, in samples and in literal product codes', () => {
    const skus = new Set(loadStock().map(product => product.sku))
    const used = new Set<string>()
    for (const sample of loadSamples()) {
      const sku = sample.input.sku
      if (typeof sku === 'string') used.add(sku)
    }
    for (const entry of [...casesOf('build'), ...casesOf('resist')]) {
      for (const node of entry.reference.nodes) {
        if (node.type === 'action' && node.connector === 'stock_check' && !node.params.sku.includes('{{')) used.add(node.params.sku)
      }
    }

    expect(used.size).toBeGreaterThan(0)
    for (const sku of used) expect(skus, sku).toContain(sku)
  })

  it('has a product in stock, a low one and one with nothing left, so every branch can be shown', () => {
    const stock = loadStock()

    expect(stock.some(product => product.availableKg >= 100)).toBe(true)
    expect(stock.some(product => product.availableKg > 0 && product.availableKg < 30)).toBe(true)
    expect(stock.some(product => product.availableKg === 0)).toBe(true)
  })
})

describe('the file is read strictly', () => {
  const raw = {
    cases: golden.slice(0, 20).map(entry => (entry.kind === 'reject'
      ? { id: entry.id, kind: 'reject', language: entry.language, description: entry.description, expect: { rejects: entry.rejects }, attempt: entry.attempt }
      : { id: entry.id, kind: 'build', language: entry.language, description: entry.description, expect: { trigger: 'manual' }, reference: entry.reference })),
  }

  it('accepts a file that follows its schema', () => {
    expect(goldenFileSchema.safeParse(raw).success).toBe(true)
  })

  it('refuses an unknown field in a case, in its rules and in a comparison', () => {
    const withExtra = structuredClone(raw)
    ;(withExtra.cases[0] as Record<string, unknown>).hint = 'try harder'
    const withBadRule = structuredClone(raw)
    ;(withBadRule.cases[1] as { expect: Record<string, unknown> }).expect = { trigger: 'manual', mustBeNice: true }
    const withBadComparison = structuredClone(raw)
    ;(withBadComparison.cases[1] as { expect: Record<string, unknown> }).expect = { conditions: [{ fields: ['trigger.x'], anyOf: [{ op: 'gt', value: 1, extra: 1 }] }] }

    expect(goldenFileSchema.safeParse(withExtra).success).toBe(false)
    expect(goldenFileSchema.safeParse(withBadRule).success).toBe(false)
    expect(goldenFileSchema.safeParse(withBadComparison).success).toBe(false)
  })

  it('refuses fewer than 20 cases, and a case that grades nothing', () => {
    expect(goldenFileSchema.safeParse({ cases: raw.cases.slice(0, 5) }).success).toBe(false)
    const nothing = structuredClone(raw)
    ;(nothing.cases[1] as { expect: Record<string, unknown> }).expect = {}
    expect(goldenFileSchema.safeParse(nothing).success).toBe(false)
  })

  it('refuses a case that is neither a sample nor complete, and one that is both', () => {
    const incomplete = structuredClone(raw)
    delete (incomplete.cases[1] as Record<string, unknown>).reference
    const both = structuredClone(raw)
    ;(both.cases[1] as Record<string, unknown>).sample = 'wholesale-order'

    expect(goldenFileSchema.safeParse(incomplete).success).toBe(false)
    expect(goldenFileSchema.safeParse(both).success).toBe(false)
  })

  it('refuses a case about an injection that forbids nothing', () => {
    const resist = golden.find(entry => entry.kind === 'resist')
    if (resist?.kind !== 'resist') throw new Error('the set has no injection case')
    const cases = [...raw.cases]
    cases[0] = { id: 'lenient', kind: 'resist', language: 'en', description: resist.description, expect: { trigger: 'wholesale_order' }, reference: resist.reference, complies: resist.complies } as unknown as (typeof raw.cases)[number]

    expect(goldenFileSchema.safeParse({ cases }).success).toBe(false)
  })
})

describe('the live eval, run on a fake model', () => {
  /** A fake pipeline that answers every case as a good model would. */
  const good: DescribeWorkflow = async (description) => {
    const entry = golden.find(item => item.description === description)
    if (!entry) throw new Error('unknown description')
    if (entry.kind === 'reject') return { status: 'rejected', issues: (validateWorkflow(entry.attempt).issues), modelCalls: 2 }
    return { status: 'accepted', graph: entry.reference, modelCalls: 1 }
  }

  it('passes every case when the pipeline does what the golden set expects', async () => {
    const report = await evaluate(golden, good)

    expect(report.grades).toHaveLength(golden.length)
    expect(passRate(report)).toBe(1)
    expect(failuresByCheck(report)).toEqual([])
    expect(totalModelCalls(report)).toBe(golden.length + casesOf('reject').length)
  })

  it('fails the cases a pipeline that obeys injections and accepts everything gets wrong', async () => {
    const credulous: DescribeWorkflow = async (description) => {
      const entry = golden.find(item => item.description === description)
      if (entry?.kind === 'resist') return { status: 'accepted', graph: entry.complies, modelCalls: 1 }
      if (entry?.kind === 'reject') return { status: 'accepted', graph: casesOf('build')[0]?.reference ?? entry.attempt as never, modelCalls: 1 }
      return good(description)
    }

    const report = await evaluate(golden, credulous)

    expect(report.grades.filter(grade => grade.kind === 'build').every(grade => grade.failures.length === 0)).toBe(true)
    expect(report.grades.filter(grade => grade.kind === 'reject').every(grade => grade.failures[0]?.startsWith('outcome:'))).toBe(true)
    expect(report.grades.filter(grade => grade.kind === 'resist').every(grade => grade.failures.length > 0)).toBe(true)
  })

  it('fails a build case that is refused, and counts failures by the check that failed', async () => {
    const strict: DescribeWorkflow = async () => ({ status: 'rejected', issues: [{ code: 'cycle', path: 'edges.1', message: 'x' }], modelCalls: 2 })

    const report = await evaluate(golden, strict)

    expect(report.grades.filter(grade => grade.kind === 'build').every(grade => grade.failures[0]?.startsWith('outcome: expected a workflow'))).toBe(true)
    expect(failuresByCheck(report)[0]).toEqual(['outcome', casesOf('build').length])
    // Refusing a request that must be refused, or an injection, is right.
    expect(report.grades.filter(grade => grade.kind !== 'build').every(grade => grade.failures.length === 0)).toBe(true)
  })

  it('records a pipeline that cannot answer as that case failing, without stopping the run', async () => {
    const down: DescribeWorkflow = async () => {
      throw new Error('The gateway said: the visitor wrote something private')
    }

    const report = await evaluate(golden, down, { caseIds: new Set(['sms-to-owner', 'erp-sync']) })

    expect(report.grades.map(grade => grade.caseId)).toEqual(golden.map(entry => entry.id).filter(id => id === 'erp-sync' || id === 'sms-to-owner'))
    expect(report.grades.every(grade => grade.failures[0] === 'unavailable: Error')).toBe(true)
    expect(JSON.stringify(report)).not.toContain('private')
  })

  it('runs only the cases asked for, and reports each one as it finishes', async () => {
    const seen: string[] = []

    const report = await evaluate(golden, good, {
      caseIds: new Set(['erp-sync']),
      afterCase: async (grade) => {
        seen.push(grade.caseId)
      },
    })

    expect(report.grades.map(grade => grade.caseId)).toEqual(['erp-sync'])
    expect(seen).toEqual(['erp-sync'])
  })
})
