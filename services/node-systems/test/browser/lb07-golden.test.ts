// The offline eval: every golden case run through the whole agent (the state machine, the real runner on a
// real Chromium over the real shop, the report rules and the test generator), with the model replaced by a
// script that answers as a correct planner would, and graded by the golden set's rules. This is the proof
// that the rules can be met and that the path from plan to report works; what a live model does is for
// `just eval-lb07`, which is not run here.
import { createRun, runScope, Tracer } from '@lb/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runAgent } from '../../src/modules/lb07/agent/machine.ts'
import type { MachineHooks } from '../../src/modules/lb07/agent/machine.ts'
import { freshWorking } from '../../src/modules/lb07/agent/working.ts'
import { gradeRun } from '../../src/modules/lb07/golden/grade.ts'
import { Recorder } from '../support/lb04.ts'
import { loadCatalogue, loadGolden } from '../support/lb07.ts'
import { referenceModel } from '../support/lb07-engine.ts'
import { startRunnerHarness } from '../support/lb07-runner.ts'
import type { RunnerHarness } from '../support/lb07-runner.ts'
import { tokenFor } from '../support/lb07-shop.ts'

const catalogue = loadCatalogue()
const golden = loadGolden()
const quiet: MachineHooks = { onState: async () => {}, onSteps: async () => {}, onFinding: async () => {}, onEvidence: async () => {}, save: async () => {} }

describe('each golden case, through the whole agent on a real Chromium', () => {
  let harness: RunnerHarness
  beforeAll(async () => {
    harness = await startRunnerHarness()
  })
  afterAll(() => harness.close())

  it.each(golden.map(entry => [entry.id, entry] as const))('%s passes every rule of its case', async (_id, entry) => {
    const runId = `run-golden-${entry.id}`.slice(0, 60)
    const model = referenceModel(entry)
    const result = await runScope(createRun({ system: 'lb-07', runId, dataClass: 'synthetic' }), () => runAgent(
      { runner: harness.runner, model, guard: { check: async () => ({ flagged: false, score: 0.01 }) }, tracer: new Tracer(new Recorder()), log: { warn: () => {} }, runTimeMs: 180_000, busyWaitMs: 100, busyWaits: 10, shopOrigin: harness.shop.origin, now: () => Date.now() },
      { runId, goal: entry.goal, bugs: entry.bugs, bugToken: tokenFor(entry.bugs, runId), origin: 'custom' },
      freshWorking(),
      quiet,
    ))
    const grade = gradeRun(entry, { state: 'done', failure: null, findings: result.findings, verdict: result.verification.verdict, modelCalls: result.modelCalls, replans: result.replans, steps: result.steps, offOriginRequests: result.offOriginRequests }, catalogue)
    expect(grade.failures, JSON.stringify(result.findings.map(finding => `${finding.kind} ${finding.engine} ${finding.path} ${finding.detail}`))).toEqual([])
    expect(result.testSource).toContain('test(')
    expect(result.modelCalls).toBeLessThanOrEqual(7)
  })
})
