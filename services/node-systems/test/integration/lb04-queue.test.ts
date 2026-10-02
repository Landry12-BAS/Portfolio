// Tests for LB-04's real queue: BullMQ on a real Redis, with real workers. They check what the hand-driven
// tests can't: that a review job carries only a contract's id, that a retry waits as long as the gateway
// asked (and otherwise doubles its wait), that a review that keeps failing ends once and is not run
// again, that a worker killed in the middle of a review is recovered by the queue without a late
// attempt undoing the result, that the sweep runs on its own, and that a job lost from Redis is
// replaced.
import { randomBytes } from 'node:crypto'

import { GatewayCallError } from '@lb/common'
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'

import type { JsonModel } from '../../src/modules/lb04/analysis/model.ts'
import { BullScheduler, bullPrefix, REVIEW_QUEUE, startMaintenance, startReviewWorker } from '../../src/modules/lb04/engine/queue.ts'
import type { RunningWorker } from '../../src/modules/lb04/engine/queue.ts'
import { startContract } from '../../src/modules/lb04/engine/service.ts'
import { readContractView, readReportView } from '../../src/modules/lb04/engine/store.ts'
import { ScriptedModel } from '../support/fake-model.ts'
import { createLb04Harness, referenceReview, VISITOR_A } from '../support/lb04-engine.ts'
import type { Lb04Harness } from '../support/lb04-engine.ts'
import { waitFor } from '../support/wait.ts'

const redisUrl = inject('redisUrl')
const prefix = `lbtest-${randomBytes(4).toString('hex')}:`

let harness: Lb04Harness
let redis: Redis
let scheduler: BullScheduler
let worker: RunningWorker
let inspector: Queue

beforeAll(async () => {
  harness = await createLb04Harness(inject('databaseUrl'))
  redis = new Redis(redisUrl, { maxRetriesPerRequest: null })
  scheduler = new BullScheduler(redis, prefix, harness.deps.config)
  harness.deps.scheduler = scheduler
  worker = startReviewWorker(harness.deps, redis, prefix)
  inspector = new Queue(REVIEW_QUEUE, { connection: redis, prefix: bullPrefix(prefix) })
})

afterAll(async () => {
  await worker.close()
  await inspector.close()
  await scheduler.close()
  // Remove every key this file's queues made, so a shared Redis is left as it was found.
  const keys = await redis.keys(`${prefix}*`)
  if (keys.length > 0) await redis.del(...keys)
  redis.disconnect()
  await harness.close()
})

beforeEach(async () => {
  harness.clock.set('2026-10-02T09:00:00.000Z')
  harness.spans.spans.length = 0
  await harness.query('DELETE FROM lb04.contracts')
  await harness.query('DELETE FROM lb04.usage_counters')
})

/** A guard that flags nothing. */
const QUIET_GUARD = { check: async () => ({ flagged: false, score: 0.01 }) }

/** Starts a review of a sample on the real queue, with models of the test's own making. */
async function startWith(models: ReturnType<typeof referenceReview>['scripts']['models']): Promise<string> {
  harness.deps.review = { models, guard: QUIET_GUARD }
  return (await startContract(harness.deps, VISITOR_A, { from: 'sample', sampleId: 'wholesale-supply' })).id
}

/** Waits until a contract has the state, and returns its view. */
async function until(id: string, state: string) {
  return waitFor(`contract ${id.slice(0, 8)} to be ${state}`, async () => {
    const view = await readContractView(harness.deps.db, VISITOR_A, id, harness.clock.now())
    return view?.state === state ? view : undefined
  })
}

/** A model that notes when each question reaches it, and answers with another model. */
function timed(inner: JsonModel, times: number[]): JsonModel {
  return {
    ask: async (messages) => {
      times.push(Date.now())
      return inner.ask(messages)
    },
  }
}

describe('the real queue', () => {
  it('reviews a contract end to end on a worker, with a job that carries the contract\'s id and nothing else', async () => {
    const { scripts } = referenceReview('wholesale-supply')
    const id = await startWith(scripts.models)

    const view = await until(id, 'done')

    expect(view.pages).toBe(11)
    const job = await inspector.getJob(id)
    expect(job?.data).toEqual({ contractId: id })
    expect(job?.name).toBe('review')
    expect(await job?.getState()).toBe('completed')
    expect((await readReportView(harness.deps.db, VISITOR_A, id, harness.clock.now())).calls).toBe(3)
  })

  it('makes one job for one contract however many times it is added', async () => {
    // Jobs are counted by state, which the service's own Redis user may do (it has no right to list a queue's jobs).
    const jobsInQueue = async (): Promise<number> => Object.values(await inspector.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed')).reduce((total, count) => total + count, 0)
    const before = await jobsInQueue()
    const id = await startWith(referenceReview('wholesale-supply').scripts.models)

    await scheduler.enqueue(id)
    await scheduler.enqueue(id)
    await until(id, 'done')

    expect(await jobsInQueue() - before).toBe(1)
    expect(await inspector.getJob(id)).toBeDefined()
  })

  it('waits as long as the gateway asked before the next attempt, when that is longer than its own backoff', async () => {
    const { scripts } = referenceReview('wholesale-supply')
    const times: number[] = []
    const flaky = new ScriptedModel((messages, call) => {
      if (call === 1) throw new GatewayCallError('upstream_failed', 502, 1)
      return scripts.long.ask(messages)
    })
    const id = await startWith({ ...scripts.models, long: timed(flaky, times) })

    await until(id, 'done')

    expect(times).toHaveLength(2)
    // The gateway said 1 second; the service's own first backoff is 40 ms.
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(950)
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeLessThan(4_000)
  })

  it('doubles its own wait when the gateway asked for none: 40 ms, then 80 ms', async () => {
    const { scripts } = referenceReview('wholesale-supply')
    const times: number[] = []
    const flaky = new ScriptedModel((messages, call) => {
      if (call <= 2) throw new GatewayCallError('upstream_timeout', 504, undefined)
      return scripts.long.ask(messages)
    })
    const id = await startWith({ ...scripts.models, long: timed(flaky, times) })

    await until(id, 'done')

    expect(times).toHaveLength(3)
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(35)
    expect((times[2] ?? 0) - (times[1] ?? 0)).toBeGreaterThanOrEqual(75)
  })

  it('gives up after three attempts, ends the contract once as failed with the place given back, and its job completes with three attempts made', async () => {
    const { scripts } = referenceReview('wholesale-supply')
    const long = new ScriptedModel(() => {
      throw new GatewayCallError('upstream_failed', 502, undefined)
    })
    const id = await startWith({ ...scripts.models, long })

    const view = await until(id, 'failed')

    expect(view.failure?.code).toBe('analysis_unavailable')
    const job = await waitFor('the job to complete', async () => {
      const found = await inspector.getJob(id)
      return (await found?.getState()) === 'completed' ? found : undefined
    })
    expect(job.attemptsMade).toBe(3)
    expect(long.conversations).toHaveLength(3)
    const counter = await harness.query(`SELECT used FROM lb04.usage_counters WHERE session_key = $1 AND kind = 'contract'`, [VISITOR_A])
    expect(counter[0]?.used).toBe(0)
    expect(harness.spans.spans.filter(span => span.name === 'contract review')).toHaveLength(1)
  })

  it('does not retry a contract whose model has no quota left: one attempt, then failed as unavailable', async () => {
    const { scripts } = referenceReview('wholesale-supply')
    const long = new ScriptedModel(() => {
      throw new GatewayCallError('quota_exceeded', 429, undefined)
    })
    const id = await startWith({ ...scripts.models, long })

    const view = await until(id, 'failed')

    expect(view.failure?.code).toBe('analysis_unavailable')
    expect(long.conversations).toHaveLength(1)
  })

  it('recovers a review whose worker was killed in the middle of it, and a late attempt from the dead worker can not undo the result', async () => {
    const { scripts } = referenceReview('wholesale-supply')
    // A queue of its own, so the file's worker does not take the job: the first worker to ask the long model never gets an answer, and is killed.
    const doomedPrefix = `${prefix}doomed-`
    const doomedScheduler = new BullScheduler(redis, doomedPrefix, harness.deps.config)
    const doomedDeps = { ...harness.deps, scheduler: doomedScheduler }
    let release: (reply: Awaited<ReturnType<JsonModel['ask']>>) => void = () => {}
    const stuck = new Promise<Awaited<ReturnType<JsonModel['ask']>>>((resolve) => {
      release = resolve
    })
    let asked = 0
    const long: JsonModel = {
      ask: async (messages) => {
        asked += 1
        if (asked === 1) return stuck
        return scripts.long.ask(messages)
      },
    }
    doomedDeps.review = { models: { ...scripts.models, long }, guard: QUIET_GUARD }
    const first = startReviewWorker(doomedDeps, redis, doomedPrefix, { lockMillis: 700, stalledCheckMillis: 700 })
    const id = (await startContract(doomedDeps, VISITOR_A, { from: 'sample', sampleId: 'wholesale-supply' })).id
    await waitFor('the long model to be asked', async () => asked > 0)

    // The process dies: its lock on the job is no longer renewed. A second worker takes over once the lock runs out.
    await first.close(true)
    const second = startReviewWorker(doomedDeps, redis, doomedPrefix, { lockMillis: 700, stalledCheckMillis: 700 })
    const view = await until(id, 'done')

    expect(view.state).toBe('done')
    expect(asked).toBe(2)
    const before = await readReportView(harness.deps.db, VISITOR_A, id, harness.clock.now())
    // The dead worker's attempt wakes up late and carries on: it can't change what the finished review says, or write a second root span.
    release({ kind: 'json', value: { notes: [], missing: [] } })
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(await readReportView(harness.deps.db, VISITOR_A, id, harness.clock.now())).toEqual(before)
    expect(harness.spans.spans.filter(span => span.name === 'contract review')).toHaveLength(1)
    await second.close()
    await doomedScheduler.close()
  })
})

describe('putting a job back', () => {
  it('leaves a job alone that is still waiting, replaces one that finished while its contract did not, and makes one where there is none', async () => {
    await worker.close()
    const id = await startWith(referenceReview('wholesale-supply').scripts.models)
    // No worker is running: the job waits.
    expect((await inspector.getJob(id).then(job => job?.getState()))).toBe('waiting')
    await scheduler.requeue(id)
    expect((await inspector.getJobCounts('waiting')).waiting).toBe(1)

    // A worker runs it to the end, and then the contract is put back to a state of work, as if its end had been lost.
    worker = startReviewWorker(harness.deps, redis, prefix)
    await until(id, 'done')
    const finished = await inspector.getJob(id)
    expect(await finished?.getState()).toBe('completed')
    await harness.query(`UPDATE lb04.contracts SET state = 'analysing' WHERE id = $1`, [id])
    await harness.query('DELETE FROM lb04.reports WHERE contract_id = $1', [id])
    await scheduler.requeue(id)

    await until(id, 'done')

    // And with no job at all, a requeue makes one.
    await (await inspector.getJob(id))?.remove()
    await harness.query(`UPDATE lb04.contracts SET state = 'analysing' WHERE id = $1`, [id])
    await harness.query('DELETE FROM lb04.reports WHERE contract_id = $1', [id])
    await scheduler.requeue(id)

    await until(id, 'done')
  })
})

describe('the sweep on its own', () => {
  it('deletes a contract once its hour is up, with no one asking, and lets a worker stop', async () => {
    const id = await startWith(referenceReview('wholesale-supply').scripts.models)
    await until(id, 'done')
    const maintenance = await startMaintenance(harness.deps, redis, prefix)
    try {
      harness.clock.advance(61 * 60_000)

      await waitFor('the sweep to delete the contract', async () => {
        const rows = await harness.query('SELECT count(*)::int AS left FROM lb04.contracts')
        return rows[0]?.left === 0
      })

      const kept = await harness.query('SELECT (SELECT count(*) FROM lb04.contract_files)::int AS files, (SELECT count(*) FROM lb04.contract_pages)::int AS pages, (SELECT count(*) FROM lb04.reports)::int AS reports')
      expect(kept[0]).toEqual({ files: 0, pages: 0, reports: 0 })
    }
    finally {
      await maintenance.close()
    }
  })

  it('is one repeating job however many times the worker starts: restarting adds no second sweep', async () => {
    const first = await startMaintenance(harness.deps, redis, prefix)
    const second = await startMaintenance(harness.deps, redis, prefix)
    try {
      const queue = new Queue('lb04-maintenance', { connection: redis, prefix: bullPrefix(prefix) })
      const count = await queue.getJobSchedulersCount()
      const sweep = await queue.getJobScheduler('sweep')
      await queue.close()

      expect(count).toBe(1)
      expect(sweep?.every).toBe(harness.deps.config.sweepEveryMs)
    }
    finally {
      await first.close()
      await second.close()
    }
  })
})
