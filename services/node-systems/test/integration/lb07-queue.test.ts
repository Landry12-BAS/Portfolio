// LB-07's real BullMQ queue: a run queued by the API's path is picked up by the worker, run with a scripted
// runner and model, and ended; a run whose first attempt could not reach the browser is retried after the
// backoff and ends done; the maintenance worker sweeps.
import { randomBytes } from 'node:crypto'

import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { BullScheduler, startMaintenance, startRunWorker } from '../../src/modules/lb07/engine/queue.ts'
import type { RunningWorker } from '../../src/modules/lb07/engine/queue.ts'
import { startRun } from '../../src/modules/lb07/engine/service.ts'
import { readRunView } from '../../src/modules/lb07/engine/store.ts'
import type { GoldenCase } from '../../src/modules/lb07/golden/cases.ts'
import { RunnerError } from '../../src/modules/lb07/runner/client.ts'
import { loadGolden } from '../support/lb07.ts'
import { createLb07Harness, referenceModel } from '../support/lb07-engine.ts'
import type { Lb07Harness } from '../support/lb07-engine.ts'
import { bugScript } from '../support/lb07-fake-runner.ts'
import { waitFor } from '../support/wait.ts'

let harness: Lb07Harness
let redis: Redis
let scheduler: BullScheduler
let workers: RunningWorker[] = []
const prefix = `lbtest-${randomBytes(4).toString('hex')}:`
const coupon = loadGolden().find(entry => entry.id === 'coupon-double-discount') as GoldenCase

beforeAll(async () => {
  harness = await createLb07Harness(inject('databaseUrl'), { config: { backoffMs: 50 } })
  harness.deps.now = () => new Date()
  redis = new Redis(inject('redisUrl'), { maxRetriesPerRequest: null })
  scheduler = new BullScheduler(redis, prefix, harness.deps.config)
  harness.deps.scheduler = scheduler
  harness.runner.script = bugScript(coupon.bugs)
  harness.models.current = referenceModel(coupon)
  workers = [startRunWorker(harness.deps, redis, prefix, { lockMillis: 2_000, stalledCheckMillis: 500 }), await startMaintenance(harness.deps, redis, prefix)]
})

afterAll(async () => {
  await Promise.all(workers.map(worker => worker.close()))
  await scheduler.close()
  const keys = await redis.keys(`${prefix}*`)
  if (keys.length > 0) await redis.del(...keys)
  redis.disconnect()
  await harness.close()
})

describe('the real queue', () => {
  it('runs a queued run to its end, one at a time', async () => {
    const session = `session-${randomBytes(8).toString('hex')}`
    const run = await startRun(harness.deps, session, { from: 'sample', sampleId: coupon.id })
    await waitFor('the run to end', async () => (await readRunView(harness.deps.db, session, run.id, new Date()))?.state === 'done', 15_000)
    const view = await readRunView(harness.deps.db, session, run.id, new Date())
    expect(view).toMatchObject({ state: 'done', findings: 1 })
  })

  it('retries a run whose attempt failed (a browser that crashed), after the backoff, and ends it done', async () => {
    const session = `session-${randomBytes(8).toString('hex')}`
    harness.runner.openFailures.push(new RunnerError('crashed', 'the browser crashed'))
    const run = await startRun(harness.deps, session, { from: 'sample', sampleId: coupon.id })
    await waitFor('the run to end', async () => (await readRunView(harness.deps.db, session, run.id, new Date()))?.state === 'done', 15_000)
    const counts = await scheduler.counts()
    expect(counts.failed).toBe(0)
  })
})
