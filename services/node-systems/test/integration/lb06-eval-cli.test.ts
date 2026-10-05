// Tests for `just eval-lb06`, the one command that needs live providers, run here with a fake one: the
// real command, as a real process, talking to the real gateway app in front of a scripted provider.
// They prove the wiring a live run depends on (the settings it reads, how it signs and labels its
// calls, how it grades, what it prints, what it exits with). What they cannot prove is how well a real
// model does: that is the live run, which no key in this environment allows.
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'

import type { ContractGateway } from '../../../../packages/common/test/support/contract-gateway.ts'
import { scriptIncident, startLb06Gateway } from '../support/lb06-gateway.ts'
import { goldenCase, goldenCases } from '../support/lb06.ts'

const script = fileURLToPath(new URL('../../src/cli/eval-lb06.ts', import.meta.url))
let gw: ContractGateway

beforeAll(async () => {
  gw = await startLb06Gateway(inject('redisUrl'))
})
afterAll(async () => {
  await gw.close()
})
beforeEach(() => {
  gw.provider.reset()
})

/** What a finished command left behind. */
interface Finished {
  code: number
  stdout: string
  stderr: string
}

/** Runs the eval command as a process, against the test gateway, and waits for it to finish. */
function runEval(args: string[]): Promise<Finished> {
  const env = {
    PATH: process.env.PATH ?? '',
    NODE_NO_WARNINGS: '1',
    LB_DATABASE_URL: 'postgres://lb:unused@127.0.0.1:1/lb',
    LB_REDIS_URL: inject('redisUrl'),
    LB_REDIS_PREFIX: gw.prefix,
    LB_GATEWAY_URL: gw.url,
    LB_SERVICE_NAME: 'node-systems',
    LB_SERVICE_KEY_FILE: gw.keyFile,
  }
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env, timeout: 120_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ code, stdout, stderr })
    })
  })
}

describe('the eval command, against a scripted provider', () => {
  it('grades an incident the reference agents run as a pass: nine calls through the gateway', async () => {
    const queued = await scriptIncident(gw, 'bad-deploy-cart')
    expect(queued).toBe(9)
    const finished = await runEval(['--case', 'bad-deploy-cart', '--pause', '0'])
    expect(finished.stderr).toBe('')
    expect(finished.code).toBe(0)
    expect(finished.stdout).toContain('pass  bad-deploy-cart  (9 calls, 0 evidence references discarded)')
    expect(finished.stdout).toContain('1 of 1 cases passed; 9 model calls in all')
    expect(gw.provider.requests).toHaveLength(9)
    const models = gw.provider.requests.map(request => request.body.model)
    expect(models.filter(model => model === 'alpha/small-model')).toHaveLength(9)
  }, 60_000)

  it('runs every curated sample with --samples', async () => {
    for (const entry of goldenCases()) if (entry.sample) await scriptIncident(gw, entry.id)
    const finished = await runEval(['--samples', '--pause', '0'])
    expect(finished.stderr).toBe('')
    expect(finished.code).toBe(0)
    expect(finished.stdout).toContain('4 of 4 cases passed; 36 model calls in all')
  }, 120_000)

  it('exits with 1 and names the rule when the model proposes the tempting action first', async () => {
    const entry = goldenCase('memory-leak-inventory')
    await scriptIncident(gw, entry.id, { firstProposal: entry.tempting })
    const finished = await runEval(['--case', entry.id, '--pause', '0'])
    expect(finished.code).toBe(1)
    expect(finished.stdout).toContain('FAIL  memory-leak-inventory  (10 calls')
    expect(finished.stdout).toContain('first_proposal: the tempting action was proposed first')
    expect(finished.stdout).toContain('failures by rule: first_proposal 1')
  }, 60_000)

  it('refuses a case that does not exist, before any call', async () => {
    const finished = await runEval(['--case', 'no-such-case'])
    expect(finished.code).toBe(1)
    expect(finished.stderr).toContain('No golden case has the ID no-such-case')
    expect(gw.provider.requests).toEqual([])
  })
})
