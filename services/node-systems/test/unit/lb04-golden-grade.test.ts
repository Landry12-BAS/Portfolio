// Tests for grading LB-04 against its golden set: a whole run with the reference models passes every
// case (the real extraction, the real pipeline and the real grader, with scripts for the models), and
// the grader finds every way a report can fall short of a case. The models are scripts, so none of
// this needs a provider.
import type { Lb04Report } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { freshWorking, reviewContract } from '../../src/modules/lb04/analysis/pipeline.ts'
import { findInstructionPassages } from '../../src/modules/lb04/analysis/screen.ts'
import { buildSourceIndex } from '../../src/modules/lb04/analysis/source.ts'
import type { ReportCase } from '../../src/modules/lb04/golden/cases.ts'
import { casePassed, failuresByRule, gradeRedline, gradeRefusal, gradeReport, recallRate, runPassed } from '../../src/modules/lb04/golden/grade.ts'
import { evaluate } from '../../src/modules/lb04/golden/run.ts'
import { extractedPages, inTestRun, loadGoldenSet, loadPlaybook, Recorder } from '../support/lb04.ts'
import { referenceDeps, referenceGuard, referenceModels } from '../support/lb04-reference.ts'

const golden = loadGoldenSet()
const playbook = loadPlaybook()
const reportCases = golden.cases.filter((entry): entry is ReportCase => entry.kind === 'report')

/** A model that can't be reached: asking it throws, as a gateway that is down does. */
async function unreachable(): Promise<never> {
  throw new TypeError('connection refused')
}

/** The case with an id, which must be a report case. */
function reportCase(id: string): ReportCase {
  const found = reportCases.find(entry => entry.id === id)
  if (!found) throw new Error(`There is no report case called ${id}.`)
  return found
}

// A run reads six contracts' PDFs in worker threads before the fake models answer, which takes longer
// than the unit default of five seconds on a slow runner.
describe('a run of the golden set with the reference models', { timeout: 30_000 }, () => {
  it('passes every case, finds every planted problem, and costs only the calls the pipeline makes', async () => {
    const recorder = new Recorder()
    const deps = referenceDeps(recorder)

    const grades = await evaluate(golden.cases, deps)

    expect(grades.map(grade => [grade.caseId, grade.failures])).toEqual(golden.cases.map(entry => [entry.id, []]))
    expect(recallRate(grades)).toBe(1)
    expect(runPassed(grades, golden.gates.recall)).toBe(true)
    // The guard, the analysis and the report, and one redline: four. A clean contract needs no report and no redline: two. A refused file: none.
    expect(grades.map(grade => grade.modelCalls)).toEqual([4, 2, 4, 4, 0, 0])
  })

  it('asks no model anything for a file it refuses', async () => {
    const deps = referenceDeps(new Recorder())

    await evaluate(golden.cases.filter(entry => entry.kind === 'refused'), deps)

    expect([...deps.scripts.values()].flatMap(scripted => [scripted.long, scripted.reason, scripted.fast]).flatMap(model => model.conversations)).toEqual([])
  })

  it('runs only the cases it is given', async () => {
    const seen: string[] = []

    const grades = await evaluate(golden.cases, referenceDeps(new Recorder(), false), {
      caseIds: new Set(['clean-supply', 'scanned-supply']),
      afterCase: async (grade) => {
        seen.push(grade.caseId)
      },
    })

    expect(grades.map(grade => grade.caseId)).toEqual(['clean-supply', 'scanned-supply'])
    expect(seen).toEqual(['clean-supply', 'scanned-supply'])
  })

  it('turns a model that can not be reached into a failure of that case and goes on with the rest', async () => {
    const deps = referenceDeps(new Recorder(), false)
    const reference = deps.modelsFor
    deps.modelsFor = (entry) => {
      const scripted = reference(entry)
      return entry.id === 'wholesale-supply' ? { ...scripted, long: { ask: unreachable } } : scripted
    }

    const grades = await evaluate(golden.cases.filter(entry => entry.id !== 'master-supply-30'), deps)

    expect(grades.map(grade => grade.failures)).toEqual([['unavailable: TypeError'], [], [], [], []])
  })

  it('turns a model whose answers are never in the right form into one named failure', async () => {
    const deps = referenceDeps(new Recorder(), false)
    const reference = deps.modelsFor
    deps.modelsFor = (entry) => {
      const scripted = reference(entry)
      return entry.id === 'wholesale-supply' ? { ...scripted, long: { ask: async () => ({ kind: 'text' as const, text: 'I cannot help with that.' }) } } : scripted
    }

    const [grade] = await evaluate(golden.cases, deps, { caseIds: new Set(['wholesale-supply']) })

    expect(grade?.failures).toEqual(['analysis: the model\'s answer was not usable, even after its one repair'])
  })
})

/** Reviews a case's contract with the reference models, and returns the report and the pages, for the tests that change the report. */
async function referenceReport(id: string): Promise<{ entry: ReportCase, report: Lb04Report, pages: Awaited<ReturnType<typeof extractedPages>> }> {
  const entry = reportCase(id)
  const pages = await extractedPages(entry.contract)
  const scripted = referenceModels(entry, playbook)
  const report = await inTestRun(() => reviewContract(
    { models: scripted.models, guard: referenceGuard(entry), tracer: referenceDeps(new Recorder()).tracer, playbook },
    { contractId: '3f1c1f5e-7c3a-4e4e-9d49-0c6a3a5a1b01', pages },
    freshWorking(),
    { onState: async () => {}, save: async () => {}, lastAttempt: false },
  ))
  return { entry, report, pages }
}

describe('the grader', () => {
  it('passes the reference report', async () => {
    const { entry, report, pages } = await referenceReport('wholesale-supply')

    expect(gradeReport(entry, report, pages)).toMatchObject({ failures: [], found: 4, planted: 4, modelCalls: 3 })
  })

  it('counts a planted finding that is missing as a lower recall, and fails the run by its gate and not the case', async () => {
    const { entry, report, pages } = await referenceReport('wholesale-supply')
    const without = { ...report, findings: report.findings.filter(finding => finding.rule !== 'liability-uncapped') }

    const grade = gradeReport(entry, without, pages)

    expect(grade.failures).toEqual(['recall: unlimited-liability (liability-uncapped, clause 21.1) was not reported'])
    expect(grade).toMatchObject({ found: 3, planted: 4 })
    expect(casePassed(grade)).toBe(true)
    expect(runPassed([grade], 0.8)).toBe(false)
    expect(runPassed([grade], 0.7)).toBe(true)
  })

  it('fails a severity two steps from the one the case states, and accepts one step', async () => {
    const { entry, report, pages } = await referenceReport('wholesale-supply')
    const rated = (severity: 'low' | 'high') => ({ ...report, findings: report.findings.map(finding => (finding.rule === 'liability-uncapped' ? { ...finding, severity } : finding)) })

    expect(gradeReport(entry, rated('low'), pages).failures).toEqual(['severity: unlimited-liability is low, and critical was expected'])
    expect(gradeReport(entry, rated('high'), pages).failures).toEqual([])
  })

  it('fails a quote that is not the contract\'s own text at its citation', async () => {
    const { entry, report, pages } = await referenceReport('wholesale-supply')
    const changed = { ...report, findings: report.findings.map(finding => (finding.kind === 'risk' && finding.rule === 'payment-slow' ? { ...finding, quote: 'the Customer shall pay each undisputed invoice within sixty (60) days of receipt' } : finding)) }

    expect(gradeReport(entry, changed, pages).failures).toEqual([expect.stringMatching(/^quotes: f\d+ quotes words that are not at its citation$/)])
  })

  it('fails a finding that rests on text that talks to the reviewer', async () => {
    const { entry, report, pages } = await referenceReport('hostile-supply')
    const spoken = findInstructionPassages(buildSourceIndex(pages))[0]
    if (!spoken) throw new Error('The hostile contract has no instruction passage.')
    const text = (pages.find(page => page.page === spoken.page)?.text ?? '').slice(spoken.start, spoken.end)
    const resting = { ...report, findings: [...report.findings, { id: 'f9', kind: 'risk' as const, topic: 'liability' as const, rule: 'liability-uncapped', title: 'Liability is not capped', severity: 'critical' as const, summary: 'x', source: 'model' as const, clause: null, citation: spoken, quote: text }] }

    expect(gradeReport(entry, resting, pages).failures).toContain('instructions: f9 rests on text that talks to the reviewer')
  })

  it('fails a finding that is not planted and not tolerated, and allows the ones the case tolerates', async () => {
    const { entry, report, pages } = await referenceReport('wholesale-supply')
    const base = report.findings.find(finding => finding.kind === 'risk' && finding.rule === 'payment-slow')
    if (base?.kind !== 'risk') throw new Error('The reference report has no payment finding.')
    const extra = (rule: string) => ({ ...report, findings: [...report.findings, { ...base, id: 'f9', rule, topic: playbook.rules.get(rule)?.topic ?? base.topic }] })

    expect(gradeReport(entry, extra('termination-one-sided'), pages).failures).toEqual(['unplanted: 1 findings that are not planted (termination-one-sided), at most 0 allowed'])
    expect(gradeReport(entry, extra('liability-consequential'), pages).failures).toEqual([])
  })

  it('fails a clause reported missing that the contract has, and one that is missing and not reported', async () => {
    const { entry, report, pages } = await referenceReport('wholesale-supply')
    const absent = report.findings.find(finding => finding.kind === 'absent')
    if (absent?.kind !== 'absent') throw new Error('The reference report has no absent finding.')

    expect(gradeReport(entry, { ...report, findings: report.findings.filter(finding => finding.kind !== 'absent') }, pages).failures).toEqual(['absent: indemnity-present is missing from the contract and not reported'])
    expect(gradeReport(entry, { ...report, findings: [...report.findings, { ...absent, id: 'f9', rule: 'confidentiality-present', topic: 'confidentiality' as const }] }, pages).failures).toEqual(['absent: confidentiality-present is reported missing, and the contract has it'])
  })

  it('fails a screen that says the opposite of the case, a lost label and too many calls', async () => {
    const hostile = await referenceReport('hostile-supply')
    const wholesale = await referenceReport('wholesale-supply')

    expect(gradeReport(hostile.entry, { ...hostile.report, screen: { ...hostile.report.screen, verdict: 'clean' } }, hostile.pages).failures).toEqual(['screen: the contract talks to its reviewer and the report says clean'])
    expect(gradeReport(wholesale.entry, { ...wholesale.report, screen: { ...wholesale.report.screen, verdict: 'flagged' } }, wholesale.pages).failures).toEqual(['screen: the contract is clean and the report flags it'])
    expect(gradeReport(wholesale.entry, { ...wholesale.report, calls: 6 }, wholesale.pages).failures).toEqual(['calls: 6 model calls, at most 5 allowed'])
    expect(gradeReport(wholesale.entry, { ...wholesale.report, notLegalAdvice: 'Advice' as never }, wholesale.pages).failures).toEqual(['label: the report does not carry its label'])
  })

  it('accepts a contract that could not be checked by a guard where the case expects it to be clean', async () => {
    const { entry, report, pages } = await referenceReport('clean-supply')

    expect(gradeReport(entry, { ...report, screen: { verdict: 'unchecked', guardScore: null, passages: [], passageCount: 0 } }, pages).failures).toEqual([])
  })

  it('grades a refusal by its reason, and fails a model call made for a file that is refused', () => {
    const entry = golden.cases.find(candidate => candidate.id === 'scanned-supply')
    if (entry?.kind !== 'refused') throw new Error('The scanned case is missing.')

    expect(gradeRefusal(entry, 'no_text_layer', 0).failures).toEqual([])
    expect(gradeRefusal(entry, 'too_many_pages', 0).failures).toEqual(['refused: the file was refused as too_many_pages, and no_text_layer was expected'])
    expect(gradeRefusal(entry, undefined, 0).failures).toEqual(['refused: the file was accepted, and the case says it must be refused'])
    expect(gradeRefusal(entry, 'no_text_layer', 1).failures).toEqual(['calls: 1 model calls for a file that is refused before any model is asked'])
  })

  it('grades a redline by whether its difference rebuilds both texts, and whether it changes anything', () => {
    const redline = { findingId: 'f1', original: 'pay within 90 days', proposal: 'pay within 30 days', diff: [{ op: 'equal' as const, text: 'pay within' }, { op: 'delete' as const, text: '90' }, { op: 'insert' as const, text: '30' }, { op: 'equal' as const, text: 'days' }], source: 'model' as const, notLegalAdvice: 'Not legal advice' as const }

    expect(gradeRedline(redline)).toEqual([])
    expect(gradeRedline({ ...redline, diff: [{ op: 'equal' as const, text: 'pay within 90 days' }] })).toEqual(['redline: the difference does not rebuild the proposal'])
    expect(gradeRedline({ ...redline, proposal: 'pay within 90 days', diff: [{ op: 'equal' as const, text: 'pay within 90 days' }] })).toEqual(['redline: the proposal changes nothing'])
  })

  it('counts failures by rule, most common first', () => {
    const grades = [
      { caseId: 'a', kind: 'report' as const, failures: ['quotes: x', 'severity: y'], found: 0, planted: 0, modelCalls: 0 },
      { caseId: 'b', kind: 'report' as const, failures: ['quotes: z'], found: 0, planted: 0, modelCalls: 0 },
    ]

    expect(failuresByRule(grades)).toEqual([['quotes', 2], ['severity', 1]])
  })
})
