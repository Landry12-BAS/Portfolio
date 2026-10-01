// `just eval-lb08`: runs LB-08's golden set through the live pipeline and grades it by rules.
//
// Every description is sent to the model through the gateway (one call, or two when the
// first answer is refused and gets its repair), and what comes back is graded by the rules in
// src/modules/lb08/golden: structure, choices, order, branches and forbidden text, never a
// model. It costs at most two gateway calls a case, so run it when prompts or routes change,
// not on every commit. Needs the gateway running with provider keys, and the settings in
// services/node-systems/.env (LB_GATEWAY_URL, LB_SERVICE_KEY_FILE).
//
//   just eval-lb08                     every case
//   just eval-lb08 --samples           only the curated samples
//   just eval-lb08 --case sms-to-owner --case two-triggers
//   just eval-lb08 --pause 20          wait 20 seconds between cases (default 8)
//
// The cases run one after another with a pause, because a free provider's tokens-per-minute
// limit is lower than a whole golden set. The exit code is 1 when any case fails.
import { parseArgs } from 'node:util'

import { createRun, Gateway, newRunId, RedisSpanWriter, runScope, Tracer } from '@lb/common'

import { evalsDirectory, seedDirectory } from '../core/data-files.ts'
import { loadEnv } from '../core/env.ts'
import { createLogger } from '../core/logging.ts'
import { openRedis } from '../core/redis.ts'
import { readSamples } from '../modules/lb08/data/samples.ts'
import { DESCRIBE_ALIAS, GatewayJsonModel } from '../modules/lb08/generate/model.ts'
import { createDescribeWorkflow } from '../modules/lb08/generate/pipeline.ts'
import { readGoldenSet } from '../modules/lb08/golden/cases.ts'
import { evaluate, failuresByCheck, passed, passRate, totalModelCalls } from '../modules/lb08/golden/evaluate.ts'
import type { CaseGrade } from '../modules/lb08/golden/evaluate.ts'

/** Waits for a number of seconds. */
function wait(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1_000))
}

/** Prints one case's grade: pass or FAIL, and each rule it broke. */
function printGrade(grade: CaseGrade): void {
  console.log(`${passed(grade) ? 'pass' : 'FAIL'}  ${grade.caseId}  (${grade.modelCalls} call${grade.modelCalls === 1 ? '' : 's'})`)
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
const samples = readSamples(seedDirectory({ LB_SEED_DIR: env.LB_SEED_DIR }))
const golden = readGoldenSet(`${evalsDirectory()}/lb08/golden.yaml`, samples)

const chosen = new Set(values.case)
if (values.samples) for (const entry of golden) if (entry.kind === 'build' && entry.sample) chosen.add(entry.id)
const unknown = [...chosen].filter(id => !golden.some(entry => entry.id === id))
if (unknown.length > 0) throw new RangeError(`No golden case has the ID ${unknown.join(', ')}.`)

const redis = openRedis(env.LB_REDIS_URL, log)
const gateway = Gateway.fromEnv({ ...process.env, LB_SERVICE_NAME: env.LB_SERVICE_NAME })
const describe = createDescribeWorkflow({ model: new GatewayJsonModel(gateway.chat(DESCRIBE_ALIAS)), tracer: new Tracer(new RedisSpanWriter(redis, env.LB_REDIS_PREFIX, log)) })

try {
  // Each description is a run of its own, over synthetic data, so no visitor's allowance is touched.
  const report = await evaluate(
    golden,
    description => runScope(createRun({ system: 'lb-08', runId: newRunId(), dataClass: 'synthetic' }), () => describe(description)),
    {
      ...(chosen.size > 0 ? { caseIds: chosen } : {}),
      afterCase: async (grade) => {
        printGrade(grade)
        await wait(pauseSeconds)
      },
    },
  )
  console.log(`${report.grades.filter(passed).length} of ${report.grades.length} cases passed (${(passRate(report) * 100).toFixed(1)}%), ${totalModelCalls(report)} gateway calls.`)
  for (const [check, count] of failuresByCheck(report)) console.log(`  ${check}: ${count} failure${count === 1 ? '' : 's'}`)
  if (report.grades.some(grade => !passed(grade))) process.exitCode = 1
}
finally {
  redis.disconnect()
}
