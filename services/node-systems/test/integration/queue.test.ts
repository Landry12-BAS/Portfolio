// Tests for LB-08's real queue: BullMQ on a real Redis, with real workers. They check the
// parts the hand-driven tests can't: that a job's attempts and exponential backoff are
// what the run log says they are, that a step that fails for good is not retried, that
// dead letters are parked and unparked, that a worker killed in the middle of a step is
// recovered by the queue and the step's side effect still happens once, and that the sweep
// runs on its own.
import { randomBytes } from 'node:crypto'

import { Queue, UnrecoverableError, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { BullScheduler, bullPrefix, startMaintenance, startStepWorker, STEP_QUEUE, stepJobId } from '../../src/modules/lb08/engine/queue.ts'
import type { RunningWorker } from '../../src/modules/lb08/engine/queue.ts'
import type { EngineDeps } from '../../src/modules/lb08/engine/deps.ts'
import { StepKilled } from '../../src/modules/lb08/engine/errors.ts'
import { listDeadLetters, listSent, readRunView, readWorkflowView } from '../../src/modules/lb08/engine/reads.ts'
import { replayRun, startRun } from '../../src/modules/lb08/engine/runs.ts'
import { createHarness, TEST_CONFIG, workflowFromSample } from '../support/engine.ts'
import type { Harness } from '../support/engine.ts'
import { waitFor } from '../support/wait.ts'

const redisUrl = inject('redisUrl')
const prefix = `lbtest-${randomBytes(4).toString('hex')}:`

let harness: Harness
let redis: Redis
let scheduler: BullScheduler
let deps: EngineDeps
let worker: RunningWorker
let inspector: Queue

beforeAll(async () => {
  harness = await createHarness(inject('databaseUrl'))
  redis = new Redis(redisUrl, { maxRetriesPerRequest: null })
  scheduler = new BullScheduler(redis, prefix, TEST_CONFIG)
  deps = { ...harness.deps, scheduler }
  worker = startStepWorker(deps, redis, prefix)
  inspector = new Queue(STEP_QUEUE, { connection: redis, prefix: bullPrefix(prefix) })
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

/** Makes a visitor session of its own. */
function newSession(): string {
  return `session-${randomBytes(8).toString('hex')}`
}

/** Starts a run of a sample on the real queue. */
async function startSample(session: string, sampleId: string, failures?: { nodeId: string, times: number }[]): Promise<{ workflowId: string, runId: string }> {
  const { workflowId, input } = await workflowFromSample(harness, session, sampleId)
  const runId = await startRun(deps, session, workflowId, { input, ...(failures ? { failures } : {}) })
  return { workflowId, runId }
}

/** Waits until a run has the status, and returns the run. */
async function until(session: string, runId: string, status: string) {
  return waitFor(`run ${runId.slice(0, 8)} to be ${status}`, async () => {
    const run = await readRunView(deps.db, session, runId)
    return run?.status === status ? run : undefined
  })
}

describe('the real queue', () => {
  it('runs the wholesale sample end to end on a worker, the actions side by side', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'wholesale-order')

    const run = await until(session, runId, 'succeeded')

    expect(run.steps.map(step => step.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded'])
    expect(await listSent(deps.db, session)).toHaveLength(2)
  })

  it('retries a failing step with the exponential backoff the run log promised', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'wholesale-order', [{ nodeId: 'alert_roastery', times: 2 }])

    const run = await until(session, runId, 'succeeded')

    const failures = run.events.filter(event => event.type === 'step.failed')
    expect(failures).toMatchObject([{ attempt: 1, retryInMs: 40 }, { attempt: 2, retryInMs: 80 }])
    const starts = run.events.filter(event => event.type === 'step.started' && event.nodeId === 'alert_roastery').map(event => Date.parse(event.at))
    expect(starts).toHaveLength(3)
    // BullMQ waits at least the base delay, then twice as long: the same formula the log quotes.
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(35)
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(75)
    expect(run.steps.find(step => step.nodeId === 'alert_roastery')?.attempts).toBe(3)
  })

  it('stops after three attempts, parks the dead letter, and takes it off the shelf when it is replayed', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'wholesale-order', [{ nodeId: 'alert_roastery', times: 3 }])

    const failed = await until(session, runId, 'failed')

    expect(failed.steps.find(step => step.nodeId === 'alert_roastery')).toMatchObject({ status: 'failed', attempts: 3 })
    expect(await scheduler.parked()).toContainEqual({ runId, nodeId: 'alert_roastery', attempts: 3, code: 'connector_unavailable' })
    expect(await listDeadLetters(deps.db, session)).toHaveLength(1)
    const job = await inspector.getJob(stepJobId(runId, 'alert_roastery'))
    expect(await job?.getState()).toBe('failed')
    expect(job?.attemptsMade).toBe(3)

    const replayId = await replayRun(deps, session, runId)
    const replay = await until(session, replayId, 'succeeded')

    expect(replay.events.filter(event => event.type === 'effect.duplicate_suppressed')).toMatchObject([{ nodeId: 'email_cafe', originalRunId: runId }])
    expect(await scheduler.parked()).not.toContainEqual(expect.objectContaining({ runId }))
    expect(await listSent(deps.db, session)).toHaveLength(2)
  })

  it('does not retry a step that can never work: BullMQ gives it one attempt and no more', async () => {
    const session = newSession()
    const { workflowId, input } = await workflowFromSample(harness, session, 'wholesale-order')
    const runId = await startRun(deps, session, workflowId, { input: { ...input, sku: 'no-such-coffee-1kg' } })

    await until(session, runId, 'failed')

    const job = await inspector.getJob(stepJobId(runId, 'check_stock'))
    expect(await job?.getState()).toBe('failed')
    expect(job?.attemptsMade).toBe(1)
    expect(await listDeadLetters(deps.db, session)).toEqual([])
  })

  it('retries a step whose worker was killed after it sent, and still sends it once', async () => {
    const session = newSession()
    let killed = 0
    harness.hooks.afterEffect = ({ nodeId }) => {
      if (nodeId === 'reorder_task' && killed === 0) {
        killed += 1
        throw new StepKilled()
      }
    }
    const { runId } = await startSample(session, 'low-stock-reorder')

    const run = await until(session, runId, 'succeeded')
    harness.hooks.afterEffect = undefined

    expect(killed).toBe(1)
    expect(run.steps.find(step => step.nodeId === 'reorder_task')?.attempts).toBe(2)
    const sent = await listSent(deps.db, session)
    expect(sent.filter(delivery => delivery.nodeId === 'reorder_task')).toHaveLength(1)
    expect(run.events.find(event => event.type === 'effect.duplicate_suppressed')).toMatchObject({ nodeId: 'reorder_task', originalRunId: runId })
  })

  it('adds a step\'s job once, however many times it is asked, and replaces one that failed without the step moving on', async () => {
    const quiet = `${prefix}quiet-`
    const lonely = new BullScheduler(redis, quiet, TEST_CONFIG)
    const options = { connection: redis, prefix: bullPrefix(quiet) }
    const look = new Queue(STEP_QUEUE, options)
    const runId = '33333333-3333-4333-8333-333333333333'

    await lonely.enqueue(runId, 'a')
    await lonely.enqueue(runId, 'a')
    await lonely.requeue(runId, 'a')
    expect(await look.getJobCounts('waiting')).toEqual({ waiting: 1 })

    // A worker that fails the job for good leaves it in the failed set, where a plain add would be ignored.
    const failing = new Worker(STEP_QUEUE, async () => {
      throw new UnrecoverableError('boom')
    }, options)
    await waitFor('the job to fail', async () => (await look.getJobCounts('failed')).failed === 1)
    await failing.close()
    await lonely.enqueue(runId, 'a')
    expect(await look.getJobCounts('waiting', 'failed')).toEqual({ waiting: 0, failed: 1 })

    await lonely.requeue(runId, 'a')
    expect(await look.getJobCounts('waiting', 'failed')).toEqual({ waiting: 1, failed: 0 })

    await look.close()
    await lonely.close()
  })

  it('keeps no ids with a colon, which BullMQ refuses, and names a job by its run and step', () => {
    expect(stepJobId('33333333-3333-4333-8333-333333333333', 'check_stock')).toBe('33333333-3333-4333-8333-333333333333__check_stock')
    expect(stepJobId('x', 'y')).not.toContain(':')
    expect(bullPrefix('lb:')).toBe('lb:bull')
  })
})

describe('a worker that dies', () => {
  it('is replaced by the queue: its step runs again on another worker, and its effect is not repeated', async () => {
    const session = newSession()
    const { workflowId, input } = await workflowFromSample(harness, session, 'low-stock-reorder')
    const doomedPrefix = `${prefix}doomed-`
    const doomedScheduler = new BullScheduler(redis, doomedPrefix, TEST_CONFIG)
    const doomedDeps: EngineDeps = { ...harness.deps, scheduler: doomedScheduler }
    // The first worker freezes after sending, as if the process had been stopped there, and is then abandoned.
    let frozen: () => void = () => {}
    const stuck = new Promise<void>((resolve) => {
      frozen = resolve
    })
    let reachedSend = false
    harness.hooks.afterEffect = async ({ nodeId }) => {
      if (nodeId === 'tell_purchasing' && !reachedSend) {
        reachedSend = true
        await stuck
      }
    }
    const first = startStepWorker(doomedDeps, redis, doomedPrefix, { lockMillis: 700, stalledCheckMillis: 700 })
    const runId = await startRun(doomedDeps, session, workflowId, { input })
    await waitFor('the first worker to send', async () => reachedSend)

    // The process dies: its lock on the job is no longer renewed. A second worker takes over once the lock runs out.
    await first.close(true)
    const second = startStepWorker(doomedDeps, redis, doomedPrefix, { lockMillis: 700, stalledCheckMillis: 700 })
    const run = await until(session, runId, 'succeeded')
    harness.hooks.afterEffect = undefined
    frozen()
    await second.close()

    const step = run.steps.find(candidate => candidate.nodeId === 'tell_purchasing')
    expect(step?.attempts).toBe(2)
    expect((await listSent(deps.db, session)).filter(delivery => delivery.nodeId === 'tell_purchasing')).toHaveLength(1)
    expect(run.events.find(event => event.type === 'effect.duplicate_suppressed')).toMatchObject({ nodeId: 'tell_purchasing', originalRunId: runId })
    await doomedScheduler.close()
  })
})

describe('the sweep on a timer', () => {
  it('runs by itself, deleting what has expired', async () => {
    const session = newSession()
    const { workflowId } = await workflowFromSample(harness, session, 'low-stock-reorder')
    const sweepPrefix = `${prefix}sweep-`
    const sweepDeps: EngineDeps = { ...harness.deps, scheduler: new BullScheduler(redis, sweepPrefix, TEST_CONFIG) }
    harness.advance(25 * 3_600_000)

    const maintenance = await startMaintenance(sweepDeps, redis, sweepPrefix)
    await waitFor('the sweep to delete the expired workflow', async () => (await readWorkflowView(deps.db, session, workflowId)) === undefined)
    harness.advance(-25 * 3_600_000)

    await maintenance.close()
  })
})
