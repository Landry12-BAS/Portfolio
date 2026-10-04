// LB-04's reference models as the tests use them: the golden set's reference reviewer
// (src/modules/lb04/golden/reference.ts) wrapped in scripted models that remember what each was
// asked, so the grader, the verifier and the pipeline can be run end to end with no provider key and
// a test can read the conversations. They read the same prompts the live models read, so a change to
// a prompt that stops a model finding its notes breaks a test.
import { Tracer } from '@lb/common'

import type { ReviewModels } from '../../src/modules/lb04/analysis/model.ts'
import type { ReportCase } from '../../src/modules/lb04/golden/cases.ts'
import { readReportRequest, referenceAnswers, referenceGuard } from '../../src/modules/lb04/golden/reference.ts'
import type { EvalDeps } from '../../src/modules/lb04/golden/run.ts'
import type { Playbook } from '../../src/modules/lb04/playbook/playbook.ts'
import { ScriptedModel } from './fake-model.ts'
import { inTestRun, loadPlaybook, seedBytes, TEST_LIMITS } from './lb04.ts'
import type { Recorder } from './lb04.ts'

export { readReportRequest, referenceGuard }

/** The models of a review and the scripts behind them, so a test can read what each was asked. */
export interface ScriptedModels {
  models: ReviewModels
  long: ScriptedModel
  reason: ScriptedModel
  fast: ScriptedModel
}

/** Builds the scripts that answer a golden case the way a correct reviewer would: it finds what is planted, rates each as the case says, and proposes the wording its prompt suggests. */
export function referenceModels(entry: ReportCase, playbook: Playbook): ScriptedModels {
  const answers = referenceAnswers(entry, playbook)
  const long = new ScriptedModel(messages => answers.long(messages))
  const reason = new ScriptedModel(messages => answers.reason(messages))
  const fast = new ScriptedModel(messages => answers.fast(messages))
  return { models: { long, reason, fast }, long, reason, fast }
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
