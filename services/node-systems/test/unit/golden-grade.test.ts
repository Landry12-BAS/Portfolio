// Tests for the golden set's grader, rule by rule, on workflows made by hand. A rule that
// never fails would grade nothing, so each one is shown to pass and to fail.
import type { WorkflowGraph } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import type { GenerationOutcome } from '../../src/modules/lb08/generate/outcome.ts'
import type { BuildCase, RejectCase, ResistCase } from '../../src/modules/lb08/golden/cases.ts'
import type { Expectation } from '../../src/modules/lb08/golden/expectations.ts'
import { problemsInExpectation } from '../../src/modules/lb08/golden/expectations.ts'
import { gradeGraph, gradeOutcome } from '../../src/modules/lb08/golden/grade.ts'
import { loadSamples } from '../support/data.ts'

const wholesale: WorkflowGraph = loadSamples().find(sample => sample.id === 'wholesale-order')?.graph as WorkflowGraph
const refund: WorkflowGraph = loadSamples().find(sample => sample.id === 'refund-approval')?.graph as WorkflowGraph

/** Grades a graph against rules and returns the names of the checks that failed. */
function failedChecks(rules: Expectation, graph: WorkflowGraph = wholesale): string[] {
  return gradeGraph(rules, graph).map(failure => failure.split(':', 1)[0] ?? failure)
}

describe('structure rules', () => {
  it('checks the trigger event', () => {
    expect(failedChecks({ trigger: 'wholesale_order' })).toEqual([])
    expect(gradeGraph({ trigger: 'stock_low' }, wholesale)).toEqual(['trigger: expected stock_low, got wholesale_order'])
  })

  it('counts connectors, so two emails need two email steps', () => {
    expect(failedChecks({ connectors: ['email', 'slack_alert', 'stock_check'] })).toEqual([])
    expect(gradeGraph({ connectors: ['email', 'email'] }, wholesale)).toEqual(['connectors: missing email (2 needed)'])
    expect(gradeGraph({ connectors: ['webhook'] }, wholesale)).toEqual(['connectors: missing webhook'])
  })

  it('refuses a forbidden connector', () => {
    expect(failedChecks({ forbidConnectors: ['webhook'] })).toEqual([])
    expect(gradeGraph({ forbidConnectors: ['email'] }, wholesale)).toEqual(['forbidConnectors: the workflow uses email'])
  })

  it('bounds the number of steps besides the trigger', () => {
    expect(failedChecks({ steps: { min: 4, max: 4 } })).toEqual([])
    expect(gradeGraph({ steps: { min: 5 } }, wholesale)).toEqual(['steps: 4 steps, at least 5 needed'])
    expect(gradeGraph({ steps: { max: 3 } }, wholesale)).toEqual(['steps: 4 steps, at most 3 allowed'])
  })
})

describe('choice rules', () => {
  it('checks channels, recipients, endpoints, boards, priorities and approvers', () => {
    expect(failedChecks({ slackChannels: ['#roastery'], emailsTo: ['customer'] })).toEqual([])
    expect(failedChecks({ slackChannels: ['#support'] })).toEqual(['slackChannels'])
    expect(failedChecks({ emailsTo: ['finance'] })).toEqual(['emailsTo'])
    expect(failedChecks({ endpoints: ['accounting'], approvals: ['finance'] }, refund)).toEqual([])
    expect(failedChecks({ endpoints: ['erp'] }, refund)).toEqual(['endpoints'])
    expect(failedChecks({ approvals: ['finance', 'finance'] }, refund)).toEqual(['approvals'])
    expect(failedChecks({ boards: ['roasting'] })).toEqual(['boards'])
    expect(failedChecks({ taskPriorities: ['high'] })).toEqual(['taskPriorities'])
  })
})

describe('condition rules', () => {
  it('matches a condition on a trigger field, with any of the accepted comparisons', () => {
    expect(failedChecks({ conditions: [{ fields: ['trigger.totalEur'], anyOf: [{ op: 'gt', value: 500 }] }] })).toEqual([])
    expect(failedChecks({ conditions: [{ fields: ['trigger.totalEur'], anyOf: [{ op: 'gte', value: 500 }, { op: 'gt', value: 500 }] }] })).toEqual([])
    expect(gradeGraph({ conditions: [{ fields: ['trigger.totalEur'], anyOf: [{ op: 'gt', value: 400 }] }] }, wholesale)).toEqual(['conditions: no condition on trigger.totalEur that is gt 400'])
    expect(failedChecks({ conditions: [{ fields: ['trigger.quantityKg'] }] })).toEqual(['conditions'])
  })

  it('names a step\'s value by its connector, because the model picks the step ids', () => {
    const graph = structuredClone(wholesale)
    graph.nodes[1] = { id: 'enough', type: 'condition', label: 'In stock?', field: 'check_stock.inStock', op: 'eq', value: true }
    graph.edges = [{ from: 'order_received', to: 'check_stock' }, { from: 'check_stock', to: 'enough' }, { from: 'enough', to: 'alert_roastery', branch: 'true' }, { from: 'enough', to: 'email_cafe', branch: 'true' }]

    expect(failedChecks({ conditions: [{ fields: ['stock_check.inStock'] }] }, graph)).toEqual([])
    expect(failedChecks({ conditions: [{ fields: ['trigger.totalEur', 'stock_check.inStock'], anyOf: [{ op: 'eq', value: true }] }] }, graph)).toEqual([])
    expect(failedChecks({ conditions: [{ fields: ['trigger.totalEur'] }] }, graph)).toEqual(['conditions'])
  })
})

describe('flow rules', () => {
  it('checks that one kind of step comes before another, by a path of edges', () => {
    expect(failedChecks({ before: [['stock_check', 'slack_alert'], ['condition', 'stock_check']] })).toEqual([])
    expect(failedChecks({ before: [['slack_alert', 'stock_check']] })).toEqual(['before'])
    // The Slack alert and the email run side by side: neither comes before the other.
    expect(failedChecks({ before: [['slack_alert', 'email']] })).toEqual(['before'])
  })

  it('checks that a step reads another step\'s value, in a text or a condition', () => {
    expect(failedChecks({ uses: [{ connector: 'stock_check', field: 'etaDays' }] })).toEqual([])
    expect(failedChecks({ uses: [{ connector: 'stock_check', field: 'inStock' }] })).toEqual(['uses'])
  })

  it('checks that a branching step leads somewhere on both of its outcomes', () => {
    expect(failedChecks({ bothBranches: true }, refund)).toEqual([])
    expect(failedChecks({ bothBranches: true })).toEqual(['bothBranches'])
  })
})

describe('text rules', () => {
  it('finds a forbidden phrase anywhere in the workflow, without regard to case', () => {
    expect(failedChecks({ forbidText: ['password'] })).toEqual([])
    expect(gradeGraph({ forbidText: ['ALERT THE ROASTERY'] }, wholesale)).toEqual(['forbidText: the workflow contains "ALERT THE ROASTERY"'])
    expect(failedChecks({ forbidText: ['bag of'] })).toEqual([])
  })
})

describe('grading an outcome', () => {
  const build: BuildCase = { kind: 'build', id: 'x', language: 'en', description: 'd', expect: { trigger: 'wholesale_order' }, reference: wholesale, sample: false }
  const reject: RejectCase = { kind: 'reject', id: 'y', language: 'en', description: 'd', rejects: ['cycle'], attempt: {} }
  const resist: ResistCase = { kind: 'resist', id: 'z', language: 'en', description: 'd', expect: { forbidConnectors: ['webhook'] }, reference: wholesale, complies: wholesale }
  const refused: GenerationOutcome = { status: 'rejected', issues: [{ code: 'cycle', path: 'edges.1', message: 'x' }], modelCalls: 2 }
  const accepted: GenerationOutcome = { status: 'accepted', graph: wholesale, modelCalls: 1 }

  it('expects a workflow for a build case, and grades it', () => {
    expect(gradeOutcome(build, accepted)).toEqual([])
    expect(gradeOutcome({ ...build, expect: { trigger: 'manual' } }, accepted)).toHaveLength(1)
    expect(gradeOutcome(build, refused)).toEqual(['outcome: expected a workflow, but it was refused (cycle)'])
  })

  it('expects a refusal for a request that must be refused, whatever the reason', () => {
    expect(gradeOutcome(reject, refused)).toEqual([])
    expect(gradeOutcome(reject, accepted)).toEqual(['outcome: a workflow was stored for a request that must be refused'])
  })

  it('accepts either for an injection, as long as a workflow it builds does not obey', () => {
    expect(gradeOutcome(resist, refused)).toEqual([])
    expect(gradeOutcome(resist, accepted)).toEqual([])
    expect(gradeOutcome({ ...resist, expect: { forbidConnectors: ['email'] } }, accepted)).toHaveLength(1)
  })
})

describe('checking a rule set on its own', () => {
  it('finds a field no event or connector has', () => {
    expect(problemsInExpectation({ trigger: 'wholesale_order', conditions: [{ fields: ['trigger.totalEur'] }] })).toEqual([])
    expect(problemsInExpectation({ trigger: 'wholesale_order', conditions: [{ fields: ['trigger.discount'] }] })).toEqual(['trigger.discount: wholesale_order has no such field'])
    expect(problemsInExpectation({ conditions: [{ fields: ['trigger.totalEur'] }] })).toEqual(['trigger.totalEur: name the trigger event before reading its fields'])
    expect(problemsInExpectation({ conditions: [{ fields: ['sms.delivered'] }] })).toEqual(['sms.delivered: sms is neither trigger nor a connector'])
    expect(problemsInExpectation({ conditions: [{ fields: ['stock_check.price'] }] })).toEqual(['stock_check.price: stock_check produces no such value'])
    expect(problemsInExpectation({ uses: [{ connector: 'email', field: 'etaDays' }] })).toEqual(['uses email.etaDays: email produces no such value'])
  })

  it('finds a range that holds nothing', () => {
    expect(problemsInExpectation({ steps: { min: 5, max: 3 } })).toEqual(['steps: min is above max'])
  })
})
