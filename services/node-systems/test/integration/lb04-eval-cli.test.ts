// Tests for `just eval-lb04`, the one command that needs live providers, run here with a fake one: the
// real command, as a real process, talking to the real gateway app in front of a scripted provider. They
// prove the wiring a live run depends on (the settings it reads, how it signs and labels its calls, how
// it grades, what it prints, what it exits with). What they cannot prove is how well a real model does:
// that is the live run, which no key in this environment allows, and which this repository records only
// when it is run.
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'

import type { ContractGateway } from '../../../../packages/common/test/support/contract-gateway.ts'
import { completion } from '../../../../packages/common/test/support/fake-provider.ts'
import { guardSegments, scriptReview, startLb04Gateway } from '../support/lb04-gateway.ts'
import { loadGoldenSet } from '../support/lb04.ts'

const script = fileURLToPath(new URL('../../src/cli/eval-lb04.ts', import.meta.url))

let gw: ContractGateway

beforeAll(async () => {
  gw = await startLb04Gateway(inject('redisUrl'))
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
function runEval(args: string[], environment: Record<string, string> | undefined = undefined): Promise<Finished> {
  const env = environment ?? {
    PATH: process.env.PATH ?? '',
    NODE_NO_WARNINGS: '1',
    // Settings the command validates but a gateway-only run never uses: any well-formed values.
    LB_DATABASE_URL: 'postgres://lb:unused@127.0.0.1:1/lb',
    LB_REDIS_URL: inject('redisUrl'),
    LB_REDIS_PREFIX: gw.prefix,
    LB_GATEWAY_URL: gw.url,
    LB_SERVICE_NAME: 'node-systems',
    LB_SERVICE_KEY_FILE: gw.keyFile,
  }
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env, timeout: 90_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ code, stdout, stderr })
    })
  })
}

/** Queues the redline answer a case's first planted finding gets. */
function provideRedline(): void {
  gw.provider.enqueue({ body: completion(JSON.stringify({ replacement: 'The parties agree wording that meets the playbook.' })) })
}

describe('the eval command, against a scripted provider', () => {
  it('grades a contract a correct reviewer reads as a pass, with the guard, the reading, the rating and one redline: four calls', async () => {
    await scriptReview(gw, 'wholesale-supply')
    provideRedline()

    const finished = await runEval(['--case', 'wholesale-supply', '--pause', '0'])

    expect(finished.stderr).toBe('')
    expect(finished.code).toBe(0)
    expect(finished.stdout).toContain('pass  wholesale-supply  (4 calls, 4 of 4 planted)')
    expect(finished.stdout).toContain('1 of 1 cases passed, recall 100.0% (the gate is 80%), 4 gateway calls.')
    const segments = await guardSegments('wholesale-supply')
    expect(gw.provider.requests).toHaveLength(segments + 3)
  })

  it('passes a file the system must refuse without asking any model, at no calls', async () => {
    const finished = await runEval(['--case', 'master-supply-31', '--case', 'scanned-supply', '--pause', '0'])

    expect(finished.code).toBe(0)
    expect(finished.stdout).toContain('pass  master-supply-31  (0 calls, 0 of 0 planted)')
    expect(finished.stdout).toContain('pass  scanned-supply  (0 calls, 0 of 0 planted)')
    expect(finished.stdout).toContain('2 of 2 cases passed, recall 100.0% (the gate is 80%), 0 gateway calls.')
    expect(gw.provider.requests).toEqual([])
  })

  it('runs every curated sample with --samples, and passes a model that reads each as the reference reviewer does', async () => {
    // The cases run in the order of the golden set, and the provider answers in the order it is told.
    for (const entry of loadGoldenSet().cases) {
      if (entry.kind !== 'report') continue
      await scriptReview(gw, entry.contract, entry.screen === 'flagged' ? '0.97' : '0.0004')
      if (entry.planted.length > 0) provideRedline()
    }

    const finished = await runEval(['--samples', '--pause', '0'])

    expect(finished.stderr).toBe('')
    expect(finished.stdout).toContain('6 of 6 cases passed, recall 100.0%')
    expect(finished.code).toBe(0)
    for (const entry of loadGoldenSet().cases) expect(finished.stdout).toContain(`pass  ${entry.id}  (`)
  })

  it('exits with 1 when the model misses what is planted: the recall gate fails the run, and the rule is named', async () => {
    const segments = await guardSegments('wholesale-supply')
    for (let segment = 0; segment < segments; segment += 1) gw.provider.answerNext('0.0004')
    // A reviewer that reads the contract and finds nothing wrong with it.
    gw.provider.answerNext(JSON.stringify({ notes: [], missing: [] }))

    const finished = await runEval(['--case', 'wholesale-supply', '--no-redlines', '--pause', '0'])

    expect(finished.code).toBe(1)
    expect(finished.stdout).toContain('recall:')
    expect(finished.stdout).toContain('recall 0.0% (the gate is 80%)')
    expect(finished.stdout).toMatch(/recall: \d+ failures?/)
  })

  it('counts a provider that is down as a failure of that case, not as a crash, and exits with 1', async () => {
    const segments = await guardSegments('wholesale-supply')
    for (let segment = 0; segment < segments; segment += 1) gw.provider.answerNext('0.0004')
    gw.provider.enqueue({ status: 500, body: { error: { message: 'down' } } })

    const finished = await runEval(['--case', 'wholesale-supply', '--no-redlines', '--pause', '0'])

    expect(finished.code).toBe(1)
    expect(finished.stdout).toContain('FAIL  wholesale-supply')
    expect(finished.stdout).toContain('unavailable: AI_APICallError')
  })

  it('leaves out the redline with --no-redlines, so a reviewed case costs three calls', async () => {
    await scriptReview(gw, 'wholesale-supply')

    const finished = await runEval(['--case', 'wholesale-supply', '--no-redlines', '--pause', '0'])

    expect(finished.code).toBe(0)
    expect(finished.stdout).toContain('pass  wholesale-supply  (3 calls, 4 of 4 planted)')
  })

  it('labels its calls as synthetic runs of lb-04, so no visitor\'s allowance is touched', async () => {
    await scriptReview(gw, 'clean-supply')

    await runEval(['--case', 'clean-supply', '--pause', '0'])

    const streams = await gw.redis.keys(`${gw.prefix}run:*:spans`)
    expect(streams.length).toBeGreaterThan(0)
    const entries = (await Promise.all(streams.map(stream => gw.redis.xrange(stream, '-', '+')))).flat()
    const spans = entries.map(([, fields]) => JSON.parse(fields[1] ?? '{}') as { system: string, name: string, attrs: Record<string, unknown> })
    expect(spans.every(span => span.system === 'lb-04')).toBe(true)
    expect(spans.find(span => span.name === 'lb-long')?.attrs).toMatchObject({ dataClass: 'synthetic' })
    // No session: a run with no visitor is counted against the system and not against anyone's day.
    const sessions = await gw.redis.keys(`${gw.prefix}gw:meter:session:*`)
    expect(sessions).toEqual([])
  })

  it.each([
    [['--case', 'no-such-case'], 'No golden case has the ID no-such-case'],
    [['--pause=-1'], '--pause is a number of seconds from 0 to 600'],
    [['--pause', 'soon'], '--pause is a number of seconds from 0 to 600'],
    [['--nonsense'], 'Unknown option'],
  ])('refuses %j before it calls anything, and says why', async (args, message) => {
    const finished = await runEval(args)

    expect(finished.code).not.toBe(0)
    expect(finished.stderr).toContain(message)
    expect(gw.provider.requests).toEqual([])
  })

  it('refuses to start without the gateway settings', async () => {
    const finished = await runEval(['--case', 'clean-supply'], { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1', LB_DATABASE_URL: 'postgres://lb:x@127.0.0.1:1/lb', LB_REDIS_URL: inject('redisUrl') })

    expect(finished.code).not.toBe(0)
    expect(finished.stderr).toContain('LB_GATEWAY_URL: required to start the API')
  })
})
