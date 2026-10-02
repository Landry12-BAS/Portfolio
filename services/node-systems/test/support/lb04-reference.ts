// LB-04's reference models: scripts that answer each golden case the way a correct reviewer would,
// so the grader, the verifier and the pipeline can be run end to end with no provider key. They read
// the same prompts the live models read, so a change to a prompt that stops a model finding its notes
// breaks a test.
import { Tracer } from '@lb/common'

import type { ReviewModels } from '../../src/modules/lb04/analysis/model.ts'
import type { Guard } from '../../src/modules/lb04/analysis/pipeline.ts'
import type { ReportCase } from '../../src/modules/lb04/golden/cases.ts'
import type { EvalDeps } from '../../src/modules/lb04/golden/run.ts'
import type { Playbook } from '../../src/modules/lb04/playbook/playbook.ts'
import { ScriptedModel } from './fake-model.ts'
import { inTestRun, loadPlaybook, seedBytes, TEST_LIMITS } from './lb04.ts'
import type { Recorder } from './lb04.ts'

/** The models of a review and the scripts behind them, so a test can read what each was asked. */
export interface ScriptedModels {
  models: ReviewModels
  long: ScriptedModel
  reason: ScriptedModel
  fast: ScriptedModel
}

/** Reads the notes the second model is shown (`n1 | rule payment-slow | clause 5.3 | quote: ...`) and the missing clauses listed under them. */
export function readReportRequest(userMessage: string): { notes: { id: string, rule: string }[], missing: string[] } {
  const notes = [...userMessage.matchAll(/^(n\d+) \| rule ([a-z0-9-]+) \|/gm)].map(match => ({ id: match[1] as string, rule: match[2] as string }))
  const afterMissing = userMessage.split('Missing clauses:\n')[1] ?? ''
  const missing = [...afterMissing.matchAll(/^- ([a-z0-9-]+)$/gm)].map(match => match[1] as string)
  return { notes, missing }
}

/** Builds the scripts that answer a golden case the way a correct reviewer would: it finds what is planted, rates each as the case says, and proposes wording. */
export function referenceModels(entry: ReportCase, playbook: Playbook): ScriptedModels {
  const severityOf = (rule: string): string => entry.planted.find(planted => planted.rule === rule)?.severity ?? entry.absent.find(absence => absence.rule === rule)?.severity ?? playbook.rules.get(rule)?.severity ?? 'medium'
  const long = new ScriptedModel(() => ({
    kind: 'json',
    value: {
      notes: entry.planted.map(planted => ({ rule: planted.rule, topic: planted.topic, clause: planted.clause, quote: planted.passage })),
      missing: entry.absent.map(absence => absence.rule),
    },
  }))
  const reason = new ScriptedModel((messages) => {
    const request = readReportRequest(messages[1]?.content ?? '')
    return {
      kind: 'json',
      value: {
        findings: request.notes.map(note => ({ note: note.id, severity: severityOf(note.rule), summary: `This passage goes against the playbook rule ${note.rule}.` })),
        missing: request.missing.map(rule => ({ rule, severity: severityOf(rule), summary: `The contract has no clause for ${rule}.` })),
      },
    }
  })
  const fast = new ScriptedModel(messages => ({ kind: 'json', value: { replacement: `The parties agree wording that meets the playbook (${messages[1]?.content.split(' ')[1] ?? 'rule'}).` } }))
  return { models: { long, reason, fast }, long, reason, fast }
}

/** A guard that says what the case expects: it flags a contract that talks to its reviewer. */
export function referenceGuard(entry: ReportCase): Guard {
  return { check: async () => ({ flagged: entry.screen === 'flagged', score: entry.screen === 'flagged' ? 0.97 : 0.01 }) }
}

/** What a run of the golden set needs, with the reference models for every case, and the real extraction and playbook. */
export function referenceDeps(recorder: Recorder, redlines = true): EvalDeps & { scripts: Map<string, ScriptedModels> } {
  const playbook = loadPlaybook()
  const scripts = new Map<string, ScriptedModels>()
  return {
    limits: TEST_LIMITS,
    playbook,
    tracer: new Tracer(recorder),
    guardFor: referenceGuard,
    modelsFor: (entry) => {
      let scripted = scripts.get(entry.id)
      if (!scripted) {
        scripted = referenceModels(entry, playbook)
        scripts.set(entry.id, scripted)
      }
      return scripted.models
    },
    readContract: seedBytes,
    scope: inTestRun,
    redlines,
    scripts,
  }
}
