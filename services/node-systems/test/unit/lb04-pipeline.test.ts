// Tests for the review of one contract (analysis/pipeline.ts), end to end over the real sample PDF with
// scripts for the models: the calls it makes and their order, the states it reports, what it saves as it
// goes so a retry never pays twice, how it degrades when the guard or the second model can't answer,
// what it refuses to hide, and that its spans hold names, counts and labels and never the contract's words.
import { Tracer } from '@lb/common'
import type { Lb04Report } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { freshWorking, ModelOutputInvalid, reviewContract, askForJson } from '../../src/modules/lb04/analysis/pipeline.ts'
import type { Guard, ReviewHooks, Working } from '../../src/modules/lb04/analysis/pipeline.ts'
import { analysisAnswerSchema } from '../../src/modules/lb04/analysis/answers.ts'
import type { ReviewModels } from '../../src/modules/lb04/analysis/model.ts'
import type { ReportCase } from '../../src/modules/lb04/golden/cases.ts'
import { extractedPages, inTestRun, loadGoldenSet, loadPlaybook, Recorder } from '../support/lb04.ts'
import { referenceGuard, referenceModels } from '../support/lb04-reference.ts'
import type { ScriptedModels } from '../support/lb04-reference.ts'
import { ScriptedModel } from '../support/fake-model.ts'

const playbook = loadPlaybook()
const golden = loadGoldenSet()
const CONTRACT = '3f1c1f5e-7c3a-4e4e-9d49-0c6a3a5a1b01'

/** The report case with an id. */
function caseOf(id: string): ReportCase {
  const found = golden.cases.find(entry => entry.id === id)
  if (found?.kind !== 'report') throw new Error(`There is no report case called ${id}.`)
  return found
}

/** What a review did, as the engine would see it. */
interface Outcome {
  report: Lb04Report
  timeline: string[]
  saved: Working[]
  recorder: Recorder
}

/** The options of one review: what stands in for each model and the guard, what was saved already, and whether it is the last attempt. */
interface Options {
  scripted?: ScriptedModels
  models?: ReviewModels
  guard?: Guard | undefined
  working?: Working
  lastAttempt?: boolean
  contract?: string
  entry?: ReportCase
  // Where to put what was saved, so a test can read it even when the review ends in an error.
  saves?: Working[]
}

/** Reviews a seed contract with the reference models unless told otherwise, and records the order of everything the pipeline does. */
async function review(options: Options = {}): Promise<Outcome> {
  const entry = options.entry ?? caseOf(options.contract ?? 'wholesale-supply')
  const scripted = options.scripted ?? referenceModels(entry, playbook)
  const recorder = new Recorder()
  const timeline: string[] = []
  const saved: Working[] = options.saves ?? []
  const watched = (name: string, model: ScriptedModel | ReviewModels['long']): ReviewModels['long'] => ({
    ask: async (messages) => {
      timeline.push(`ask:${name}`)
      return model.ask(messages)
    },
  })
  const models: ReviewModels = options.models ?? { long: watched('long', scripted.long), reason: watched('reason', scripted.reason), fast: watched('fast', scripted.fast) }
  const baseGuard = 'guard' in options ? options.guard : referenceGuard(entry)
  const guard: Guard | undefined = baseGuard && {
    check: async (text) => {
      timeline.push('ask:guard')
      return baseGuard.check(text)
    },
  }
  const hooks: ReviewHooks = {
    onState: async (state) => {
      timeline.push(`state:${state}`)
    },
    save: async (working) => {
      timeline.push('save')
      saved.push(structuredClone(working))
    },
    lastAttempt: options.lastAttempt ?? false,
  }
  const pages = await extractedPages(entry.contract)
  const report = await inTestRun(() => reviewContract({ models, guard, tracer: new Tracer(recorder), playbook }, { contractId: CONTRACT, pages }, options.working ?? freshWorking(), hooks))
  return { report, timeline, saved, recorder }
}

/** A guard that can't be reached, as a gateway that is down. */
const failingGuard: Guard = {
  check: async () => {
    throw new TypeError('guard down')
  },
}

/** A model that can't be reached, as a gateway that is down. */
const unreachable: ReviewModels['long'] = {
  ask: async () => {
    throw new TypeError('connection refused')
  },
}

describe('a review that goes as it should', () => {
  it('asks the guard, then the long-document model, then the reasoning model, and reports its states between', async () => {
    const { report, timeline } = await review()

    expect(timeline).toEqual(['state:analysing', 'ask:guard', 'save', 'ask:long', 'save', 'state:verifying', 'ask:reason', 'save'])
    expect(report.calls).toBe(3)
    expect(report.calibrated).toBe(true)
    expect(report.findings.map(finding => finding.rule)).toEqual(['renewal-long-notice', 'payment-slow', 'ip-assignment', 'liability-uncapped', 'indemnity-present'])
  })

  it('makes no call for the rating of a contract that has nothing to rate, and says so', async () => {
    const { report, timeline } = await review({ contract: 'clean-supply' })

    expect(timeline).toEqual(['state:analysing', 'ask:guard', 'save', 'ask:long', 'save', 'state:verifying'])
    expect(report.calls).toBe(2)
    expect(report.findings).toEqual([])
    expect(report.calibrated).toBe(true)
    expect(report.radar.every(entry => entry.score === 0)).toBe(true)
  })

  it('saves what each answer cost as it arrives, so a retry can start where this stopped', async () => {
    const { saved } = await review()

    expect(saved.map(working => [working.screen !== undefined, working.notes !== undefined, working.calibration !== undefined, working.calls])).toEqual([
      [true, false, false, 1],
      [true, true, false, 2],
      [true, true, true, 3],
    ])
  })

  it('shows the second model only what the verifier kept, never the model\'s own words for a quote', async () => {
    const scripted = referenceModels(caseOf('wholesale-supply'), playbook)

    await review({ scripted })

    const request = scripted.reason.conversations[0]?.[1]?.content ?? ''
    expect(request).toContain('n1 | rule renewal-long-notice | clause 3.2 | quote: at least one hundred and eighty (180) days before the end of the then-current term')
    expect(request).toContain('Missing clauses:\n- indemnity-present')
  })
})

describe('a review that starts again after a failure', () => {
  it('does not ask the guard or the first model again for what it has, and asks only the second', async () => {
    const first = await review()
    const resumed = first.saved[1] as Working
    const scripted = referenceModels(caseOf('wholesale-supply'), playbook)

    const { report, timeline } = await review({ scripted, working: structuredClone(resumed) })

    expect(timeline).toEqual(['state:analysing', 'state:verifying', 'ask:reason', 'save'])
    expect(scripted.long.conversations).toEqual([])
    expect(report.calls).toBe(3)
    expect(report.findings.map(finding => finding.rule)).toEqual(first.report.findings.map(finding => finding.rule))
  })

  it('asks no model at all when everything was already paid for, and gives the same report', async () => {
    const first = await review()
    const complete = first.saved.at(-1) as Working

    const { report, timeline } = await review({ working: structuredClone(complete) })

    expect(timeline).toEqual(['state:analysing', 'state:verifying'])
    expect(report).toEqual(first.report)
  })

  it('counts the calls of the attempts before it in the report', async () => {
    const first = await review()
    const resumed = structuredClone(first.saved[0] as Working)

    const { report } = await review({ working: resumed })

    expect(report.calls).toBe(3)
  })
})

describe('a guard that can not answer', () => {
  it('leaves the screen unchecked and goes on, since what a contract says to a reviewer is held by the verifier whatever the guard says', async () => {
    const withoutGuard = await review({ guard: undefined })
    const failing = await review({ guard: failingGuard })

    expect(withoutGuard.report.screen).toEqual({ verdict: 'unchecked', guardScore: null, passages: [], passageCount: 0 })
    expect(withoutGuard.report.calls).toBe(2)
    expect(failing.report.screen.verdict).toBe('unchecked')
    expect(failing.report.calls).toBe(2)
    expect(failing.report.findings).toHaveLength(5)
  })

  it('does not ask the guard again on a retry, even when it had failed', async () => {
    const failing = await review({ guard: failingGuard })

    const resumed = await review({ working: structuredClone(failing.saved[0] as Working) })

    expect(resumed.timeline).not.toContain('ask:guard')
    expect(resumed.report.screen.verdict).toBe('unchecked')
  })

  it('says flagged when it flags the text, with its score, and clean when it does not', async () => {
    const flagged = await review({ guard: { check: async () => ({ flagged: true, score: 0.987_654 }) } })
    const clean = await review({ guard: { check: async () => ({ flagged: false, score: 0.0123 }) } })

    expect(flagged.report.screen).toMatchObject({ verdict: 'flagged', guardScore: 0.987_654 })
    expect(clean.report.screen).toMatchObject({ verdict: 'clean', guardScore: 0.0123 })
  })
})

describe('the first model\'s answers', () => {
  it('are repaired once when they are in the wrong form, and the repair is counted', async () => {
    const scripted = referenceModels(caseOf('wholesale-supply'), playbook)
    const good = scripted.long
    const long = new ScriptedModel((messages, call) => (call === 1 ? { kind: 'text', text: 'Here is my review, in prose.' } : good.ask(messages)))

    const { report, timeline } = await review({ scripted: { ...scripted, long } })

    expect(timeline.filter(entry => entry === 'ask:long')).toHaveLength(2)
    expect(report.calls).toBe(4)
    expect(long.conversations[1]?.at(-2)).toEqual({ role: 'assistant', content: 'Here is my review, in prose.' })
    expect(long.conversations[1]?.at(-1)?.content).toContain('Problems:')
    expect(report.findings).toHaveLength(5)
  })

  it('are never asked for a third time: two in the wrong form end the review as an invalid answer, with only the guard saved', async () => {
    const scripted = referenceModels(caseOf('wholesale-supply'), playbook)
    const long = new ScriptedModel(() => ({ kind: 'json', value: { notes: 'none' } }))
    const saves: Working[] = []

    await expect(review({ scripted: { ...scripted, long }, saves })).rejects.toBeInstanceOf(ModelOutputInvalid)

    expect(long.conversations).toHaveLength(2)
    expect(saves.map(working => [working.screen !== undefined, working.notes !== undefined])).toEqual([[true, false]])
  })

  it('end the attempt with the model\'s own error when the model can not be reached, after the guard was paid for and saved', async () => {
    const scripted = referenceModels(caseOf('wholesale-supply'), playbook)
    const timeline: string[] = []
    const working = freshWorking()
    const recorder = new Recorder()
    const hooks: ReviewHooks = {
      onState: async () => {},
      save: async (value) => {
        timeline.push(`saved:${value.screen === undefined ? 'no' : 'screen'}`)
      },
      lastAttempt: false,
    }

    await expect(inTestRun(async () => reviewContract(
      { models: { ...scripted.models, long: unreachable }, guard: referenceGuard(caseOf('wholesale-supply')), tracer: new Tracer(recorder), playbook },
      { contractId: CONTRACT, pages: await extractedPages('wholesale-supply') },
      working,
      hooks,
    ))).rejects.toBeInstanceOf(TypeError)

    expect(timeline).toEqual(['saved:screen'])
    expect(working.screen).toBeDefined()
    expect(working.notes).toBeUndefined()
  })
})

describe('the second model\'s answers', () => {
  it('are repaired once, and a second wrong one makes the playbook\'s own severities and wording stand in, without failing the review', async () => {
    const scripted = referenceModels(caseOf('wholesale-supply'), playbook)
    const reason = new ScriptedModel(() => ({ kind: 'json', value: { findings: 'rate them all high' } }))

    const { report, saved } = await review({ scripted: { ...scripted, reason } })

    expect(reason.conversations).toHaveLength(2)
    expect(report.calibrated).toBe(false)
    expect(report.calls).toBe(4)
    expect(report.findings.map(finding => finding.severity)).toEqual(['high', 'medium', 'high', 'critical', 'medium'])
    expect(report.findings.map(finding => finding.summary)).toEqual(report.findings.map(finding => playbook.rules.get(finding.rule)?.summary))
    expect(saved.at(-1)?.calibration).toBe('unusable')
  })

  it('are not asked again on a retry once they were found unusable, since another try would only spend the same two calls', async () => {
    const scripted = referenceModels(caseOf('wholesale-supply'), playbook)
    const reason = new ScriptedModel(() => ({ kind: 'text', text: 'no' }))
    const first = await review({ scripted: { ...scripted, reason } })

    const again = await review({ working: structuredClone(first.saved.at(-1) as Working) })

    expect(again.timeline).not.toContain('ask:reason')
    expect(again.report.calibrated).toBe(false)
  })

  it('end the attempt with the model\'s own error when it can not be reached, so the engine retries, and never when it is the last attempt', async () => {
    const scripted = referenceModels(caseOf('wholesale-supply'), playbook)
    const models: ReviewModels = { ...scripted.models, reason: unreachable }

    await expect(review({ models })).rejects.toBeInstanceOf(TypeError)
    const last = await review({ models, lastAttempt: true })

    expect(last.report.calibrated).toBe(false)
    expect(last.report.findings).toHaveLength(5)
    expect(last.saved.at(-1)?.calibration).toBeUndefined()
  })
})

describe('what a model writes that the contract does not hold', () => {
  it('is dropped and counted, and nothing of it is shown', async () => {
    const entry = caseOf('wholesale-supply')
    const scripted = referenceModels(entry, playbook)
    const long = new ScriptedModel(() => ({
      kind: 'json',
      value: {
        notes: [
          { rule: 'payment-slow', topic: 'payment', clause: '5.3', quote: 'within ninety (90) days of the date of the invoice' },
          { rule: 'termination-one-sided', topic: 'termination', clause: '12.1', quote: 'Only the Customer may terminate this Agreement at any time without notice' },
          { rule: 'exclusivity-supplier-bound', topic: 'exclusivity', clause: '2.4', quote: 'The Supplier shall sell coffee to no other customer in Bohemia' },
          { rule: 'payment-slow', topic: 'payment', clause: '5.3', quote: 'short' },
        ],
        missing: ['governing-law-present', 'indemnity-present', 'payment-terms-present'],
      },
    }))

    const { report } = await review({ scripted: { ...scripted, long } })

    // The uncapped liability was never reported, so the missing cap is: the detector reports what the text lacks, whatever the model said.
    expect(report.findings.map(finding => finding.rule)).toEqual(['payment-slow', 'liability-cap-present', 'indemnity-present'])
    expect(report.verification.reasons).toMatchObject({ quote_not_found: 2, quote_too_short: 1, unknown_rule: 1, absent_contradicted: 1 })
    expect(JSON.stringify(report)).not.toContain('Bohemia')
    expect(JSON.stringify(report)).not.toContain('without notice')
  })
})

describe('the spans of a review', () => {
  it('are named for the steps, carry numbers and labels, and never a word of the contract', async () => {
    const { recorder } = await review()
    const pages = await extractedPages('wholesale-supply')
    const text = pages.map(page => page.text).join('\n').replaceAll(/\s+/g, ' ')

    const names = recorder.spans.map(span => span.name)
    expect(names).toEqual(['split clauses', 'screen for injection', 'cited analysis', 'verify quotes', 'structured report', 'assemble report'])
    for (const span of recorder.spans) {
      for (const [key, value] of Object.entries(span.attrs ?? {})) {
        expect(['number', 'boolean', 'string'], key).toContain(typeof value)
        if (typeof value === 'string') {
          expect(value.length, `${span.name}.${key}`).toBeLessThanOrEqual(30)
          for (let at = 0; at + 12 <= text.length; at += 997) {
            expect(value.includes(text.slice(at, at + 12)), `${span.name}.${key}`).toBe(false)
          }
        }
      }
    }
  })

  it('count what each step found: clauses, notes, what the verifier kept and dropped, the findings', async () => {
    const { recorder } = await review()
    const attrs = (name: string) => recorder.spans.find(span => span.name === name)?.attrs

    expect(attrs('cited analysis')).toMatchObject({ attempts: 1, notes: 4, missing: 1, alias: 'lb-long' })
    expect(attrs('verify quotes')).toMatchObject({ kept: 5, dropped: 0 })
    expect(attrs('structured report')).toMatchObject({ attempts: 1, rated: 5, alias: 'lb-reason' })
    expect(attrs('assemble report')).toMatchObject({ findings: 5, screen: 'clean', calibrated: true })
  })
})

describe('asking for JSON that fits a schema', () => {
  it('returns a good first answer with one call, and a repaired one with two', async () => {
    const good = { notes: [], missing: [] }
    const once = new ScriptedModel(() => ({ kind: 'json', value: good }))
    const twice = new ScriptedModel((_messages, call) => (call === 1 ? { kind: 'text', text: 'oops' } : { kind: 'json', value: good }))
    const base = [{ role: 'system' as const, content: 's' }, { role: 'user' as const, content: 'u' }]

    expect(await askForJson(once, base, analysisAnswerSchema, 100)).toEqual({ value: good, calls: 1 })
    expect(await askForJson(twice, base, analysisAnswerSchema, 100)).toEqual({ value: good, calls: 2 })
  })

  it('throws after a second answer that does not fit, and never asks a third time', async () => {
    const never = new ScriptedModel(() => ({ kind: 'json', value: 7 }))

    await expect(askForJson(never, [{ role: 'system', content: 's' }], analysisAnswerSchema, 100)).rejects.toBeInstanceOf(ModelOutputInvalid)
    expect(never.conversations).toHaveLength(2)
  })
})
