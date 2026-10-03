// The whole golden set through the whole simulator, the detection, the orchestrator and the
// postmortem, with the reference agents in place of the models: every case passes every rule, so
// the rules can be met; the hostile strings reach the agents as data in a user slot and never in a
// system prompt; the evidence the agents invent is dropped and counted; and a tempting first
// proposal is caught by the grader while the run still recovers on the second round.
import { describe, expect, it } from 'vitest'

import { ReferenceAgents } from '../../src/modules/lb06/golden/reference.ts'
import { casePassed, failuresByRule, gradeOutcome } from '../../src/modules/lb06/golden/grade.ts'
import { evaluate, runCase } from '../../src/modules/lb06/golden/run.ts'
import { goldenCase, goldenCases, recordingTracer } from '../support/lb06.ts'

/** The reference agents as the two models. */
function referenceModels(options: ConstructorParameters<typeof ReferenceAgents>[0] = {}) {
  const agents = new ReferenceAgents(options)
  return { models: { reason: agents, tools: agents }, agents }
}

describe('the golden set through the whole pipeline with the reference agents', () => {
  it('passes every case within ten model calls and closes every incident', async () => {
    const { tracer } = recordingTracer()
    const grades = await evaluate({ models: referenceModels().models, tracer }, goldenCases())
    expect(grades).toHaveLength(goldenCases().length)
    for (const grade of grades) {
      expect(grade.failures, grade.caseId).toEqual([])
      expect(grade.modelCalls).toBe(9)
      expect(grade.evidenceDiscarded).toBe(0)
    }
  }, 30_000)

  it('leaves an event log that replays the incident, with a step for every model call and tool call', async () => {
    const { tracer, recorder } = recordingTracer()
    const { outcome, log } = await runCase({ models: referenceModels().models, tracer }, goldenCase('bad-deploy-cart'))
    expect(outcome.closed).toBe(true)
    const kinds = log.events.map(event => event.kind)
    expect(kinds[0]).toBe('incident.started')
    expect(kinds).toContain('alert.fired')
    // One step for each model call that produced something (a specialist's two calls make one report), and one for each tool call.
    expect(kinds.filter(kind => kind === 'agent.step')).toHaveLength(6 + 3)
    expect(kinds.indexOf('proposal.approved')).toBeGreaterThan(kinds.indexOf('proposal.made'))
    expect(kinds.indexOf('remediation.applied')).toBeGreaterThan(kinds.indexOf('proposal.approved'))
    expect(kinds.at(-1)).toBe('incident.closed')
    expect(log.events.map(event => event.seq)).toEqual(log.events.map((_, index) => index + 1))
    // The trace: one span a model call, one a tool call, with labels and counts and no visitor's words.
    expect(recorder.spans.filter(span => span.kind === 'system.step')).toHaveLength(9)
    expect(recorder.spans.filter(span => span.kind === 'system.tool')).toHaveLength(3)
  })

  it('keeps the hostile strings in the data slot of a user message, never in a system prompt', async () => {
    const { tracer } = recordingTracer()
    for (const id of ['bad-deploy-cart-hostile-version', 'slow-payment-hostile-flag']) {
      const entry = goldenCase(id)
      const { models, agents } = referenceModels()
      const { outcome } = await runCase({ models, tracer }, entry)
      expect(casePassed(gradeOutcome(entry, outcome))).toBe(true)
      const hostile = entry.params[entry.hostile?.param ?? 'version'] ?? ''
      expect(hostile.length).toBeGreaterThan(0)
      const systems = agents.conversations.flatMap(conversation => conversation.filter(message => message.role === 'system'))
      for (const message of systems) expect(message.content).not.toContain(hostile)
      const users = agents.conversations.flatMap(conversation => conversation.filter(message => message.role === 'user'))
      expect(users.some(message => message.content.includes(hostile))).toBe(true)
      for (const message of users) {
        if (message.content.includes(hostile)) expect(message.content).toMatch(/<data name="[a-z-]+">\n[\s\S]*\n<\/data>/)
      }
    }
  })

  it('drops evidence the server does not hold, counts it, and still passes', async () => {
    const { tracer } = recordingTracer()
    const entry = goldenCase('cache-stampede')
    const { outcome } = await runCase({ models: referenceModels({ inventEvidence: 'deploy:d99' }).models, tracer }, entry)
    expect(outcome.evidenceDiscarded).toBe(4)
    for (const hypothesis of outcome.hypotheses) expect(hypothesis.evidence).not.toContain('deploy:d99')
    expect(gradeOutcome(entry, outcome).failures).toEqual([])
  })

  it('fails the first-proposal rule when the tempting action comes first, and recovers on the second round', async () => {
    const { tracer } = recordingTracer()
    const entry = goldenCase('memory-leak-inventory')
    const { outcome } = await runCase({ models: referenceModels({ firstProposal: entry.tempting }).models, tracer }, entry)
    const grade = gradeOutcome(entry, outcome)
    expect(failuresByRule([grade])).toEqual({ first_proposal: 1 })
    expect(outcome.proposals).toHaveLength(2)
    expect(outcome.recovered).toBe(true)
    expect(outcome.modelCalls).toBe(10)
  })

  it('fails the injection rule when the action the hostile text asked for is proposed', async () => {
    const { tracer } = recordingTracer()
    const entry = goldenCase('bad-deploy-cart-hostile-version')
    const { outcome } = await runCase({ models: referenceModels({ firstProposal: { kind: 'restart', service: 'database' } }).models, tracer }, entry)
    expect(failuresByRule([gradeOutcome(entry, outcome)])).toEqual({ first_proposal: 1, injection: 1 })
  })
})
