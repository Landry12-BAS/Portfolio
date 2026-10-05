// `just eval-lb06`: runs LB-06's golden set through the whole simulator, the detection and the live
// agents behind the gateway, and grades it by rules.
//
// Every case is an incident run in this process (no database, no queue): the shop ticks to the alert,
// the agents investigate the snapshot, the first proposal is approved at once, the recovery is measured
// by code and the postmortem is written. A case costs the commander's plan (1 call), each specialist's
// turns (at most 2 each), the ranking (1), the postmortem (1), and one repair for any of them: 9 for a
// clean run, 15 at the cap; the set's eight cases cost about 72. The grade reads the structured results
// only (src/modules/lb06/golden/grade.ts). Run it when prompts or routes change, not on every commit.
// Needs the gateway running with provider keys, and the settings in services/node-systems/.env.
//
//   just eval-lb06                      every case
//   just eval-lb06 --samples            only the cases marked as curated samples
//   just eval-lb06 --case bad-deploy-cart --case cache-stampede
//   just eval-lb06 --pause 20           wait 20 seconds between cases (default 8)
//
// The exit code is 1 unless every case passed.
import { parseArgs } from 'node:util'

import { createRun, Gateway, newRunId, RedisSpanWriter, runScope, Tracer } from '@lb/common'

import { evalsDirectory } from '../core/data-files.ts'
import { loadEnv } from '../core/env.ts'
import { createLogger } from '../core/logging.ts'
import { openRedis } from '../core/redis.ts'
import { readGoldenSet } from '../modules/lb06/golden/cases.ts'
import { casePassed, failuresByRule, runPassed } from '../modules/lb06/golden/grade.ts'
import type { CaseGrade } from '../modules/lb06/golden/grade.ts'
import { evaluate } from '../modules/lb06/golden/run.ts'
import { agentServices } from '../modules/lb06/index.ts'

/** Waits for a number of seconds. */
function wait(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1_000))
}

/** Prints one case's grade: pass or FAIL, and each rule it broke. */
function printGrade(grade: CaseGrade): void {
  console.log(`${casePassed(grade) ? 'pass' : 'FAIL'}  ${grade.caseId}  (${grade.modelCalls} call${grade.modelCalls === 1 ? '' : 's'}, ${grade.evidenceDiscarded} evidence reference${grade.evidenceDiscarded === 1 ? '' : 's'} discarded)`)
  for (const failure of grade.failures) console.log(`      ${failure}`)
}

const { values } = parseArgs({
  options: {
    samples: { type: 'boolean', default: false },
    case: { type: 'string', multiple: true, default: [] },
    pause: { type: 'string', default: '8' },
  },
  strict: true,
})
const pauseSeconds = Number(values.pause)
if (!Number.isFinite(pauseSeconds) || pauseSeconds < 0 || pauseSeconds > 600) throw new RangeError('--pause is a number of seconds from 0 to 600.')

const env = loadEnv(process.env, 'api')
const log = createLogger(env.LB_NODE_LOG_LEVEL)
const golden = readGoldenSet(`${evalsDirectory()}/lb06/golden.yaml`)

const chosen = new Set(values.case)
if (values.samples) for (const entry of golden) if (entry.sample) chosen.add(entry.id)
const unknown = [...chosen].filter(id => !golden.some(entry => entry.id === id))
if (unknown.length > 0) throw new RangeError(`No golden case has the ID ${unknown.join(', ')}.`)

const redis = openRedis(env.LB_REDIS_URL, log)
const gateway = Gateway.fromEnv({ ...process.env, LB_SERVICE_NAME: env.LB_SERVICE_NAME })
const services = agentServices(gateway)

try {
  // Each case is a run of its own, over synthetic data, so no visitor's allowance is touched.
  const grades = await evaluate(
    { models: services.models, tracer: new Tracer(new RedisSpanWriter(redis, env.LB_REDIS_PREFIX, log)), scope: work => runScope(createRun({ system: 'lb-06', runId: newRunId(), dataClass: 'synthetic' }), work) },
    golden,
    {
      caseIds: chosen.size > 0 ? chosen : undefined,
      afterCase: async (grade) => {
        printGrade(grade)
        if (pauseSeconds > 0) await wait(pauseSeconds)
      },
    },
  )
  const passed = grades.filter(casePassed).length
  console.log(`\n${passed} of ${grades.length} cases passed; ${grades.reduce((sum, grade) => sum + grade.modelCalls, 0)} model calls in all`)
  const byRule = failuresByRule(grades)
  if (Object.keys(byRule).length > 0) console.log(`failures by rule: ${Object.entries(byRule).map(([rule, count]) => `${rule} ${count}`).join(', ')}`)
  process.exitCode = runPassed(grades) ? 0 : 1
}
finally {
  redis.disconnect()
}
