// `just eval-lb07`: runs LB-07's golden set through the live agent and grades it by rules.
//
// Every case is planned by the model behind the gateway, run in the real sandbox's browser over the real
// shop, cross-checked in the second engine, reported by the model and verified red-then-green, exactly as
// a visitor's run is, then graded by the rules in src/modules/lb07/golden (the bugs that were on found by
// their truth, a clean shop clean, the verdict, nothing left the shop, at most eight calls), never by a
// model. A case costs at most seven gateway calls: about 77 for the set. Run it when prompts or routes
// change, not on every commit. Needs the gateway running with provider keys, the sandbox running
// (`just lb07-sandbox`), and the settings in services/node-systems/.env (LB_GATEWAY_URL,
// LB_SERVICE_KEY_FILE, LB07_RUNNER_URL, LB07_SHOP_TOKEN_KEY).
//
//   just eval-lb07                       every case
//   just eval-lb07 --samples             only the cases the board offers as samples
//   just eval-lb07 --case clean-shop --case everything-on
//   just eval-lb07 --pause 20            wait 20 seconds between cases (default 8)
//
// The exit code is 1 unless every case passed.
import { parseArgs } from 'node:util'

import { Gateway, RedisSpanWriter, Tracer } from '@lb/common'

import { evalsDirectory, seedDirectory } from '../core/data-files.ts'
import { loadEnv } from '../core/env.ts'
import { createLogger } from '../core/logging.ts'
import { openRedis } from '../core/redis.ts'
import { DEFAULT_CONFIG } from '../modules/lb07/config.ts'
import { readBugCatalogue } from '../modules/lb07/data/bugs.ts'
import { agentServices, sandboxServices } from '../modules/lb07/engine/services.ts'
import { readGoldenSet } from '../modules/lb07/golden/cases.ts'
import { casePassed, failuresByRule } from '../modules/lb07/golden/grade.ts'
import type { CaseGrade } from '../modules/lb07/golden/grade.ts'
import { evaluate } from '../modules/lb07/golden/run.ts'

/** Waits for a number of seconds. */
function wait(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1_000))
}

/** Prints one case's grade. */
function printGrade(grade: CaseGrade): void {
  console.log(`${casePassed(grade) ? 'pass' : 'FAIL'}  ${grade.caseId}  (${grade.modelCalls} call${grade.modelCalls === 1 ? '' : 's'}, ${grade.found} of ${grade.bugsOn} bugs found)`)
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

const env = loadEnv(process.env, 'worker')
if (!env.LB07_RUNNER_URL || !env.LB07_SHOP_TOKEN_KEY) throw new Error('LB07_RUNNER_URL and LB07_SHOP_TOKEN_KEY are required: the eval runs in the real sandbox.')
const log = createLogger(env.LB_NODE_LOG_LEVEL)
const catalogue = readBugCatalogue(seedDirectory({ LB_SEED_DIR: env.LB_SEED_DIR }))
const golden = readGoldenSet(`${evalsDirectory({ LB_EVALS_DIR: env.LB_EVALS_DIR })}/lb07/golden.yaml`, catalogue)

const chosen = new Set(values.case)
if (values.samples) for (const entry of golden) if (entry.sample) chosen.add(entry.id)
const unknown = [...chosen].filter(id => !golden.some(entry => entry.id === id))
if (unknown.length > 0) throw new RangeError(`No golden case has the id ${unknown.join(', ')}.`)

const redis = openRedis(env.LB_REDIS_URL, log)
const gateway = Gateway.fromEnv({ ...process.env, LB_SERVICE_NAME: env.LB_SERVICE_NAME })
const agent = agentServices(gateway)
const sandbox = sandboxServices({ runnerUrl: env.LB07_RUNNER_URL, tokenKeyHex: env.LB07_SHOP_TOKEN_KEY, shopOrigin: env.LB07_SHOP_ORIGIN })

try {
  const grades = await evaluate(golden, {
    catalogue,
    tracer: new Tracer(new RedisSpanWriter(redis, env.LB_REDIS_PREFIX, log)),
    log,
    runner: sandbox.runner,
    guard: agent.guard,
    shopOrigin: sandbox.shopOrigin,
    modelFor: () => agent.model,
    signToken: sandbox.signToken,
    runTimeMs: DEFAULT_CONFIG.runTimeMs,
  }, {
    caseIds: chosen.size > 0 ? chosen : undefined,
    afterCase: async (grade) => {
      printGrade(grade)
      await wait(pauseSeconds)
    },
  })
  const passed = grades.filter(casePassed).length
  console.log(`\n${passed} of ${grades.length} cases passed; ${grades.reduce((sum, grade) => sum + grade.modelCalls, 0)} model calls in all.`)
  for (const [rule, count] of failuresByRule(grades)) console.log(`  ${rule}: ${count} failure${count === 1 ? '' : 's'}`)
  process.exitCode = passed === grades.length ? 0 : 1
}
finally {
  redis.disconnect()
}
