// A workflow run's trace through the real gateway: the engine writes its spans to the gateway's
// own Redis streams, and the Scope's route reads them back as the site's server (`web`) does.
//
// The site stops reading a trace when the gateway says it is finished, which it says once the run's
// root span is in it. A run that writes no root is never finished, so this is the test that says the
// site can tell when a workflow run is over: the trace is open while the run goes on, finished the
// moment it ends, and what the gateway sends is the shape the site's schema reads.
import { randomBytes } from 'node:crypto'

import { RedisSpanWriter } from '@lb/common'
import { tracePageSchema } from '@lb/contracts'
import type { TracePage } from '@lb/contracts'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { startContractGateway } from '../../../../packages/common/test/support/contract-gateway.ts'
import type { ContractGateway } from '../../../../packages/common/test/support/contract-gateway.ts'
import { startRun } from '../../src/modules/lb08/engine/runs.ts'
import { runStep } from '../../src/modules/lb08/engine/steps.ts'
import { rootSpanIdOf } from '../../src/modules/lb08/engine/trace.ts'
import { createHarness, drive, TEST_CONFIG, workflowFromSample } from '../support/engine.ts'
import type { Harness } from '../support/engine.ts'

let gw: ContractGateway
let harness: Harness

beforeAll(async () => {
  gw = await startContractGateway(inject('redisUrl'), new URL('../support/routing.lb08.yaml', import.meta.url))
  harness = await createHarness(inject('databaseUrl'), TEST_CONFIG, new RedisSpanWriter(gw.redis, gw.prefix))
})

afterAll(async () => {
  await harness.close()
  await gw.close()
})

/** Makes a visitor session of its own, so no test spends another's allowance. */
function newSession(): string {
  return `session-${randomBytes(8).toString('hex')}`
}

/** Starts a run of a sample with the failures asked for, and returns its id. */
async function start(sampleId: string, failures: { nodeId: string, times: number }[] = []): Promise<string> {
  const session = newSession()
  const { workflowId, input } = await workflowFromSample(harness, session, sampleId)
  return startRun(harness.deps, session, workflowId, { input, ...(failures.length > 0 ? { failures } : {}) })
}

/** Reads a run's trace the way the site's server does, and checks it is a page the site's schema reads. */
async function readTrace(runId: string, query = ''): Promise<TracePage> {
  const response = await gw.readTrace(runId, query)
  expect(response.status).toBe(200)
  return tracePageSchema.parse(await response.json())
}

describe('a workflow run\'s trace, read as the site\'s server reads it', () => {
  it('is not there before the first step runs, open while the run goes on, and finished the moment it ends', async () => {
    const runId = await start('wholesale-order')
    expect((await gw.readTrace(runId)).status).toBe(404)

    const first = harness.scheduler.jobs.shift()
    if (!first) throw new Error('The run queued no step.')
    await runStep(harness.deps, first.runId, first.nodeId)
    const during = await readTrace(runId)
    await drive(harness)
    const after = await readTrace(runId)

    expect(during.finished).toBe(false)
    expect(during.spans.map(span => span.name)).toEqual(['step.check_stock'])
    expect(after.finished).toBe(true)
  })

  it('holds the steps nested under the run\'s root, which comes last and says how the run went', async () => {
    const runId = await start('wholesale-order')
    await drive(harness)

    const page = await readTrace(runId)

    const root = page.spans.at(-1)
    expect(root).toMatchObject({ kind: 'system.run', name: 'workflow run', status: 'ok', spanId: rootSpanIdOf(runId), attrs: { outcome: 'succeeded', steps: 5, attempts: 3, replay: false } })
    expect(root?.parentId).toBeUndefined()
    const steps = page.spans.filter(span => span.kind === 'system.step')
    expect(steps.map(span => span.name).sort()).toEqual(['step.alert_roastery', 'step.check_stock', 'step.email_cafe'])
    expect(steps.every(step => step.parentId === root?.spanId)).toBe(true)
    // What the visitor's payload held (the customer, the order, the address) is nowhere in it.
    expect(JSON.stringify(page)).not.toMatch(/Lumen|WO-2041|orders@/)
  })

  it('is finished when the run fails, with a root that says so and a span for each attempt that failed', async () => {
    const runId = await start('wholesale-order', [{ nodeId: 'alert_roastery', times: 3 }])
    await drive(harness)

    const page = await readTrace(runId)

    expect(page.finished).toBe(true)
    expect(page.spans.at(-1)).toMatchObject({ kind: 'system.run', status: 'error', attrs: { outcome: 'failed' } })
    expect(page.spans.filter(span => span.name === 'step.alert_roastery').map(span => span.status)).toEqual(['error', 'error', 'error'])
  })

  it('hands a site that polls nothing new once the run is over, and still says it is finished', async () => {
    const runId = await start('wholesale-order')
    await drive(harness)
    const page = await readTrace(runId)

    const later = await readTrace(runId, `after=${page.cursor}`)

    expect(later).toMatchObject({ spans: [], finished: true, cursor: page.cursor })
  })
})
