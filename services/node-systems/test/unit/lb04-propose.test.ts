// Tests for proposing a redline (analysis/propose.ts): the fast model writes replacement wording in one
// call and never gets a repair, the server computes the difference with code, a proposal that is
// unusable or changes nothing is replaced by the playbook's own wording, a missing clause has no words to
// replace, and a model that can not be reached is an error and not a silent fallback.
import { Tracer } from '@lb/common'
import type { Lb04Finding } from '@lb/contracts'
import { lb04RedlineSchema } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { proposeRedline } from '../../src/modules/lb04/analysis/propose.ts'
import { inTestRun, loadPlaybook, Recorder } from '../support/lb04.ts'
import { ScriptedModel } from '../support/fake-model.ts'
import type { ReviewModels } from '../../src/modules/lb04/analysis/model.ts'

const playbook = loadPlaybook()

const payment: Lb04Finding = {
  id: 'f2',
  kind: 'risk',
  topic: 'payment',
  rule: 'payment-slow',
  title: 'Payment more than 45 days after the invoice',
  severity: 'medium',
  summary: 'Ninety days strains the cash.',
  source: 'model',
  clause: '5.3',
  citation: { page: 3, start: 1105, end: 1155 },
  quote: 'within ninety (90) days of the date of the invoice',
}

const indemnity: Lb04Finding = {
  id: 'f5',
  kind: 'absent',
  topic: 'indemnity',
  rule: 'indemnity-present',
  title: 'No indemnity clause',
  severity: 'medium',
  summary: 'There is no indemnity.',
  source: 'detector',
  searched: ['indemnify'],
}

/** Proposes a redline with the models given, inside a run, and returns what was proposed and the spans written. */
async function propose(fast: ScriptedModel, finding: Lb04Finding) {
  const recorder = new Recorder()
  const models: ReviewModels = { long: fast, reason: fast, fast }
  const proposal = await inTestRun(() => proposeRedline({ models, playbook, tracer: new Tracer(recorder) }, finding))
  return { ...proposal, recorder }
}

describe('a redline for a passage of the contract', () => {
  it('shows the contract\'s words, the model\'s proposal and the difference the server computed', async () => {
    const fast = new ScriptedModel(() => ({ kind: 'json', value: { replacement: 'within thirty (30) days of the date of the invoice' } }))

    const { redline, calls } = await propose(fast, payment)

    expect(calls).toBe(1)
    expect(redline).toEqual({
      findingId: 'f2',
      original: 'within ninety (90) days of the date of the invoice',
      proposal: 'within thirty (30) days of the date of the invoice',
      diff: [
        { op: 'equal', text: 'within' },
        { op: 'delete', text: 'ninety (90)' },
        { op: 'insert', text: 'thirty (30)' },
        { op: 'equal', text: 'days of the date of the invoice' },
      ],
      source: 'model',
      notLegalAdvice: 'Not legal advice',
    })
    expect(lb04RedlineSchema.safeParse(redline).success).toBe(true)
  })

  it('shows the model the rule, the playbook\'s own wording and the passage, in one request with no repair', async () => {
    const fast = new ScriptedModel(() => ({ kind: 'json', value: { replacement: 'within thirty (30) days of the date of the invoice' } }))

    await propose(fast, payment)

    expect(fast.conversations).toHaveLength(1)
    const user = fast.conversations[0]?.[1]?.content ?? ''
    expect(user).toContain('Rule payment-slow (payment)')
    expect(user).toContain(`Suggested wording: ${playbook.rules.get('payment-slow')?.fallback}`)
    expect(user).toContain('<passage>\nwithin ninety (90) days of the date of the invoice\n</passage>')
  })

  it('uses the playbook\'s own wording when the answer is not in the right form, and does not ask again', async () => {
    const fast = new ScriptedModel(() => ({ kind: 'text', text: 'I would rather not.' }))

    const { redline, calls } = await propose(fast, payment)

    expect(fast.conversations).toHaveLength(1)
    expect(calls).toBe(1)
    expect(redline.source).toBe('playbook')
    expect(redline.proposal).toBe(playbook.rules.get('payment-slow')?.fallback)
    expect(redline.diff.filter(part => part.op !== 'insert').map(part => part.text).join(' ')).toBe(payment.kind === 'risk' ? payment.quote : '')
  })

  it('uses the playbook\'s own wording when the model proposes the passage as it is, since that is no redline', async () => {
    const fast = new ScriptedModel(() => ({ kind: 'json', value: { replacement: 'within  ninety (90) days\nof the date of the invoice' } }))

    const { redline } = await propose(fast, payment)

    expect(redline.source).toBe('playbook')
  })

  it('uses the playbook\'s own wording when the wording is longer than a redline may be, or holds a control character', async () => {
    const long = await propose(new ScriptedModel(() => ({ kind: 'json', value: { replacement: 'x '.repeat(1_000) } })), payment)
    const control = await propose(new ScriptedModel(() => ({ kind: 'json', value: { replacement: 'pay now\u0000' } })), payment)

    expect(long.redline.source).toBe('playbook')
    expect(control.redline.source).toBe('playbook')
  })

  it('shows markup in a proposal as the words it is, for the board shows text and nothing else', async () => {
    const fast = new ScriptedModel(() => ({ kind: 'json', value: { replacement: '<img src=x onerror=alert(1)> within thirty (30) days' } }))

    const { redline } = await propose(fast, payment)

    expect(redline.proposal).toBe('<img src=x onerror=alert(1)> within thirty (30) days')
    expect(redline.diff.map(part => part.text).join(' ')).toContain('<img src=x onerror=alert(1)>')
  })
})

describe('a redline for a clause the contract is missing', () => {
  it('has no words to replace, so the whole proposal is new text', async () => {
    const fast = new ScriptedModel(() => ({ kind: 'json', value: { replacement: 'Each party shall indemnify the other against third-party claims arising from its own breach.' } }))

    const { redline } = await propose(fast, indemnity)

    expect(redline.original).toBe('')
    expect(redline.diff).toEqual([{ op: 'insert', text: 'Each party shall indemnify the other against third-party claims arising from its own breach.' }])
    expect(fast.conversations[0]?.[1]?.content).toContain('(none: the clause is missing)')
  })

  it('falls back to the playbook\'s wording for the clause when the model gives none', async () => {
    const { redline } = await propose(new ScriptedModel(() => ({ kind: 'text', text: '' })), indemnity)

    expect(redline.source).toBe('playbook')
    expect(redline.proposal).toBe(playbook.rules.get('indemnity-present')?.fallback)
    expect(redline.diff).toEqual([{ op: 'insert', text: redline.proposal.split(/\s+/).join(' ') }])
  })
})

describe('what can go wrong around a redline', () => {
  it('is an error for a model that can not be reached, and not a silent fallback, so the visitor\'s redline is not spent on nothing', async () => {
    const fast = new ScriptedModel(() => {
      throw new TypeError('connection refused')
    })

    await expect(propose(fast, payment)).rejects.toBeInstanceOf(TypeError)
  })

  it('refuses a finding that names a rule the playbook does not have, before any model is asked', async () => {
    const fast = new ScriptedModel(() => ({ kind: 'json', value: { replacement: 'x' } }))

    await expect(propose(fast, { ...payment, rule: 'payment-instant' })).rejects.toBeInstanceOf(RangeError)
    expect(fast.conversations).toEqual([])
  })

  it('writes one span, named for the step, with the rule and where the wording came from and never the contract\'s words', async () => {
    const fast = new ScriptedModel(() => ({ kind: 'json', value: { replacement: 'within thirty (30) days of the date of the invoice' } }))

    const { recorder } = await propose(fast, payment)

    expect(recorder.spans.map(span => span.name)).toEqual(['propose redline'])
    expect(recorder.spans[0]?.attrs).toEqual({ alias: 'lb-fast', rule: 'payment-slow', source: 'model' })
  })
})
