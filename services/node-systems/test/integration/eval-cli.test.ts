// Tests for `just eval-lb08`, the one command that needs live providers, run here with a
// fake one: the real command, as a real process, talking to the real gateway app in front
// of a scripted provider. They prove the wiring that a live run depends on (the settings it
// reads, how it signs and labels its calls, how it grades, what it prints, what it exits
// with). What they cannot prove is how well a real model does: that is the live run, which
// no key in this environment allows, and which this repository records only when it is run.
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'

import { startContractGateway } from '../../../../packages/common/test/support/contract-gateway.ts'
import type { ContractGateway } from '../../../../packages/common/test/support/contract-gateway.ts'
import { completion } from '../../../../packages/common/test/support/fake-provider.ts'
import { loadGolden } from '../support/data.ts'

const script = fileURLToPath(new URL('../../src/cli/eval-lb08.ts', import.meta.url))
const golden = loadGolden()

let gw: ContractGateway

beforeAll(async () => {
  gw = await startContractGateway(inject('redisUrl'), new URL('../support/routing.lb08.yaml', import.meta.url))
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
function runEval(...args: string[]): Promise<Finished> {
  const environment = {
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
    execFile(process.execPath, [script, ...args], { env: environment, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ code, stdout, stderr })
    })
  })
}

/** Finds a golden case by its id. */
function caseNamed(id: string) {
  const found = golden.find(entry => entry.id === id)
  if (!found) throw new Error(`No golden case called ${id}.`)
  return found
}

/** Queues what the fake provider answers next, as the text of a chat completion. */
function provide(value: unknown): void {
  gw.provider.enqueue({ body: completion(JSON.stringify(value)) })
}

describe('the eval command, against a scripted provider', () => {
  it('grades a request that must be refused as a pass when what the model wrote is refused by validation, at two calls', async () => {
    const entry = caseNamed('sms-to-owner')
    if (entry.kind !== 'reject') throw new Error('Expected a reject case.')
    provide(entry.attempt)
    provide(entry.attempt)

    const finished = await runEval('--case', 'sms-to-owner', '--pause', '0')

    expect(finished.stderr).toBe('')
    expect(finished.code).toBe(0)
    expect(finished.stdout).toContain('pass  sms-to-owner  (2 calls)')
    expect(finished.stdout).toContain('1 of 1 cases passed (100.0%), 2 gateway calls.')
    expect(gw.provider.requests).toHaveLength(2)
    const sent = gw.provider.requests[0]?.body as { messages: { role: string, content: string }[] }
    expect(sent.messages[1]?.content).toBe(`<process>\n${entry.description}\n</process>`)
  })

  it('grades a model that does what an injection says as a failure, names the rule it broke, and exits with 1', async () => {
    const entry = caseNamed('inject-ignore-rules')
    if (entry.kind !== 'resist') throw new Error('Expected a resist case.')
    provide(entry.complies)

    const finished = await runEval('--case', 'inject-ignore-rules', '--pause', '0')

    expect(finished.code).toBe(1)
    expect(finished.stdout).toContain('FAIL  inject-ignore-rules  (1 call)')
    expect(finished.stdout).toContain('forbidConnectors: the workflow uses webhook')
    expect(finished.stdout).toContain('0 of 1 cases passed (0.0%), 1 gateway calls.')
    expect(finished.stdout).toContain('forbidConnectors: 1 failure')
  })

  it('runs only the curated samples with --samples, and passes a model that builds each one', async () => {
    const samples = golden.filter(entry => entry.kind === 'build' && entry.sample)
    for (const entry of samples) provide(entry.reference)

    const finished = await runEval('--samples', '--pause', '0')

    expect(finished.code).toBe(0)
    expect(samples).toHaveLength(4)
    for (const entry of samples) expect(finished.stdout).toContain(`pass  ${entry.id}  (1 call)`)
    expect(finished.stdout).toContain('4 of 4 cases passed (100.0%), 4 gateway calls.')
    expect(gw.provider.requests).toHaveLength(4)
  })

  it('counts a provider that is down as a failure of that case, not as a crash', async () => {
    gw.provider.enqueue({ status: 500, body: { error: { message: 'down' } } })

    const finished = await runEval('--case', 'wholesale-order-over-500', '--pause', '0')

    expect(finished.code).toBe(1)
    expect(finished.stdout).toContain('FAIL  wholesale-order-over-500')
    expect(finished.stdout).toContain('unavailable: AI_APICallError')
  })

  it('labels its calls as synthetic runs of lb-08, so no visitor\'s allowance is touched', async () => {
    const entry = caseNamed('sms-to-owner')
    if (entry.kind !== 'reject') throw new Error('Expected a reject case.')
    provide(entry.attempt)
    provide(entry.attempt)

    await runEval('--case', 'sms-to-owner', '--pause', '0')

    const streams = await gw.redis.keys(`${gw.prefix}run:*:spans`)
    expect(streams.length).toBeGreaterThan(0)
    const entries = (await Promise.all(streams.map(stream => gw.redis.xrange(stream, '-', '+')))).flat()
    const spans = entries.map(([, fields]) => JSON.parse(fields[1] ?? '{}') as { system: string, name: string, attrs: Record<string, unknown> })
    expect(spans.every(span => span.system === 'lb-08')).toBe(true)
    expect(spans.find(span => span.name === 'lb-tools')?.attrs).toMatchObject({ dataClass: 'synthetic' })
  })

  it.each([
    [['--case', 'no-such-case'], 'No golden case has the ID no-such-case'],
    [['--pause=-1'], '--pause is a number of seconds from 0 to 600'],
    [['--pause', '-1'], 'Option \'--pause\' argument is ambiguous'],
    [['--pause', 'soon'], '--pause is a number of seconds from 0 to 600'],
    [['--nonsense'], 'Unknown option'],
  ])('refuses %j before it calls anything, and says why', async (args, message) => {
    const finished = await runEval(...args)

    expect(finished.code).not.toBe(0)
    expect(finished.stderr).toContain(message)
    expect(gw.provider.requests).toEqual([])
  })

  it('refuses to start without the gateway settings', async () => {
    const finished = await new Promise<Finished>((resolve) => {
      execFile(process.execPath, [script, '--case', 'sms-to-owner'], { env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1', LB_DATABASE_URL: 'postgres://lb:x@127.0.0.1:1/lb', LB_REDIS_URL: inject('redisUrl') }, timeout: 60_000 }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr })
      })
    })

    expect(finished.code).not.toBe(0)
    expect(finished.stderr).toContain('LB_GATEWAY_URL: required to start the API')
  })
})
