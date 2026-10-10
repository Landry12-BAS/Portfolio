// `just eval-lb04`: runs LB-04's golden set through the live pipeline and grades it by rules.
//
// Every seed contract is opened by the real extraction and reviewed by the real pipeline, with the
// models behind the gateway: a case costs at most five gateway calls (the guard, the cited analysis
// and the rating, each of the last two repaired at most once) and one more for its redline, so the
// set's four reviewed contracts cost at most 24. A contract the system must refuse costs none. What
// comes back is graded by the rules in src/modules/lb04/golden (quotes that are the contract's own
// words at the cited place, planted findings found, severities within a step, a hostile contract's
// instructions never obeyed, no invented clause), never by a model. Run it when prompts or routes
// change, not on every commit. Needs the gateway running with provider keys, and the settings in
// services/node-systems/.env (LB_GATEWAY_URL, LB_SERVICE_KEY_FILE).
//
//   just eval-lb04                      every case
//   just eval-lb04 --samples            only the cases marked as curated samples
//   just eval-lb04 --case wholesale-supply --case hostile-supply
//   just eval-lb04 --no-redlines        leave out the redline each reviewed case asks for
//   just eval-lb04 --pause 20           wait 20 seconds between cases (default 8)
//
// The cases run one after another with a pause, because a free provider's tokens-per-minute limit is
// lower than a whole golden set. The exit code is 1 unless every case passed and the set's recall
// reached its gate (evals/lb04/golden.yaml).
import { parseArgs } from 'node:util'

import { createRun, Gateway, newRunId, RedisSpanWriter, runScope, Tracer } from '@lb/common'

import { evalsDirectory, seedDirectory } from '../core/data-files.ts'
import { loadEnv } from '../core/env.ts'
import { createLogger } from '../core/logging.ts'
import { openRedis } from '../core/redis.ts'
import { DEFAULT_CONFIG } from '../modules/lb04/config.ts'
import { readSampleFile, readSampleList } from '../modules/lb04/data/samples.ts'
import { reviewServices } from '../modules/lb04/engine/services.ts'
import { readGoldenSet } from '../modules/lb04/golden/cases.ts'
import { casePassed, failuresByRule, recallRate, runPassed } from '../modules/lb04/golden/grade.ts'
import type { CaseGrade } from '../modules/lb04/golden/grade.ts'
import { evaluate } from '../modules/lb04/golden/run.ts'
import { readPlaybook } from '../modules/lb04/playbook/playbook.ts'

/** Waits for a number of seconds. */
function wait(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1_000))
}

/** Prints one case's grade: pass or FAIL, and each rule it broke. */
function printGrade(grade: CaseGrade): void {
  console.log(`${casePassed(grade) ? 'pass' : 'FAIL'}  ${grade.caseId}  (${grade.modelCalls} call${grade.modelCalls === 1 ? '' : 's'}, ${grade.found} of ${grade.planted} planted)`)
  for (const failure of grade.failures) console.log(`      ${failure}`)
}

const { values } = parseArgs({
  options: {
    'samples': { type: 'boolean', default: false },
    'case': { type: 'string', multiple: true, default: [] },
    'no-redlines': { type: 'boolean', default: false },
    'pause': { type: 'string', default: '8' },
  },
  strict: true,
})
const pauseSeconds = Number(values.pause)
if (!Number.isFinite(pauseSeconds) || pauseSeconds < 0 || pauseSeconds > 600) throw new RangeError('--pause is a number of seconds from 0 to 600.')

const env = loadEnv(process.env, 'api')
const log = createLogger(env.LB_NODE_LOG_LEVEL)
const seed = seedDirectory({ LB_SEED_DIR: env.LB_SEED_DIR })
const playbook = readPlaybook(seed)
const samples = readSampleList(seed)
const golden = readGoldenSet(`${evalsDirectory()}/lb04/golden.yaml`, { playbook, contracts: samples.map(sample => sample.id) })

const chosen = new Set(values.case)
if (values.samples) for (const entry of golden.cases) if (entry.sample) chosen.add(entry.id)
const unknown = [...chosen].filter(id => !golden.cases.some(entry => entry.id === id))
if (unknown.length > 0) throw new RangeError(`No golden case has the ID ${unknown.join(', ')}.`)

const redis = openRedis(env.LB_REDIS_URL, log)
const gateway = Gateway.fromEnv({ ...process.env, LB_SERVICE_NAME: env.LB_SERVICE_NAME })
const services = reviewServices(gateway)

try {
  // Each case is a run of its own, over synthetic data, so no visitor's allowance is touched.
  const grades = await evaluate(
    golden.cases,
    {
      limits: DEFAULT_CONFIG.extraction,
      playbook,
      tracer: new Tracer(new RedisSpanWriter(redis, env.LB_REDIS_PREFIX, log)),
      guardFor: () => services.guard,
      modelsFor: () => services.models,
      readContract: (id) => {
        const entry = samples.find(sample => sample.id === id)
        if (!entry) throw new RangeError(`There is no seed contract called ${id}.`)
        return readSampleFile(seed, entry).bytes
      },
      scope: work => runScope(createRun({ system: 'lb-04', runId: newRunId(), dataClass: 'synthetic' }), work),
      redlines: !values['no-redlines'],
    },
    {
      ...(chosen.size > 0 ? { caseIds: chosen } : {}),
      afterCase: async (grade) => {
        printGrade(grade)
        await wait(pauseSeconds)
      },
    },
  )
  const calls = grades.reduce((total, grade) => total + grade.modelCalls, 0)
  const recall = recallRate(grades)
  console.log(`${grades.filter(casePassed).length} of ${grades.length} cases passed, recall ${(recall * 100).toFixed(1)}% (the gate is ${(golden.gates.recall * 100).toFixed(0)}%), ${calls} gateway calls.`)
  for (const [rule, count] of failuresByRule(grades)) console.log(`  ${rule}: ${count} failure${count === 1 ? '' : 's'}`)
  if (!runPassed(grades, golden.gates.recall)) process.exitCode = 1
}
finally {
  redis.disconnect()
}
