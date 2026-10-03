// LB-04's sweep on a real Postgres: nothing a visitor sent outlives its hour (the file, the text, the
// report and the redlines go with the contract), a contract whose worker died is found and queued again,
// and the visitor's allowance, which is not the contract's own, stays. The sweep runs on a clock the test
// moves, so an hour passes in a moment.
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'

import { reviewJob } from '../../src/modules/lb04/engine/job.ts'
import { startContract } from '../../src/modules/lb04/engine/service.ts'
import { readContractView, readFileView, readPagesView, readReportView } from '../../src/modules/lb04/engine/store.ts'
import { sweep } from '../../src/modules/lb04/engine/sweep.ts'
import { ScriptedModel } from '../support/fake-model.ts'
import { createLb04Harness, drive, referenceReview, VISITOR_A, VISITOR_B } from '../support/lb04-engine.ts'
import type { Lb04Harness } from '../support/lb04-engine.ts'

let harness: Lb04Harness

beforeAll(async () => {
  // The production wait: a review is looked for after five minutes without a sign of life.
  harness = await createLb04Harness(inject('databaseUrl'), { config: { staleAfterMs: 5 * 60_000 } })
})

afterAll(async () => {
  await harness.close()
})

beforeEach(async () => {
  harness.clock.set('2026-10-02T09:00:00.000Z')
  await harness.query('DELETE FROM lb04.contracts')
  await harness.query('DELETE FROM lb04.usage_counters')
  harness.scheduler.jobs.length = 0
  harness.scheduler.added.length = 0
  harness.scheduler.requeued.length = 0
  harness.retries.length = 0
})

/** A guard that fails the test when it is asked: used where the guard's verdict was already saved. */
async function forbiddenGuard(): Promise<never> {
  throw new Error('The guard must not be asked again.')
}

/** Starts and finishes a review of a sample, with a redline asked for, so every table that belongs to a contract holds a row. */
async function finishedContract(session: string, sampleId = 'wholesale-supply'): Promise<string> {
  harness.deps.review = referenceReview(sampleId).review
  const view = await startContract(harness.deps, session, { from: 'sample', sampleId })
  await drive(harness)
  await harness.query(`INSERT INTO lb04.redlines (contract_id, finding_id, redline) VALUES ($1, 'f1', '{}')`, [view.id])
  return view.id
}

/** How many rows each table that belongs to a contract holds. */
async function rowsKept(): Promise<Record<string, number>> {
  const rows = await harness.query(`
    SELECT (SELECT count(*) FROM lb04.contracts)::int AS contracts,
           (SELECT count(*) FROM lb04.contract_files)::int AS files,
           (SELECT count(*) FROM lb04.contract_pages)::int AS pages,
           (SELECT count(*) FROM lb04.reports)::int AS reports,
           (SELECT count(*) FROM lb04.redlines)::int AS redlines,
           (SELECT count(*) FROM lb04.usage_counters)::int AS counters`)
  return rows[0] as Record<string, number>
}

describe('what outlives an hour', () => {
  it('is nothing: the contract, its file, its text, its report and its redlines are deleted together, and the allowance stays', async () => {
    await finishedContract(VISITOR_A)
    expect(await rowsKept()).toEqual({ contracts: 1, files: 1, pages: 11, reports: 1, redlines: 1, counters: 1 })
    harness.clock.advance(61 * 60_000)

    const report = await sweep(harness.deps)

    expect(report.deleted).toBe(1)
    expect(await rowsKept()).toEqual({ contracts: 0, files: 0, pages: 0, reports: 0, redlines: 0, counters: 1 })
  })

  it('keeps a contract for its hour and not a minute more, and a contract is not found once its hour is up even before the sweep has run', async () => {
    const id = await finishedContract(VISITOR_A)

    harness.clock.advance(59 * 60_000)
    expect(await sweep(harness.deps)).toMatchObject({ deleted: 0 })
    expect(await readContractView(harness.deps.db, VISITOR_A, id, harness.clock.now())).toMatchObject({ state: 'done' })

    harness.clock.advance(2 * 60_000)
    expect(await readContractView(harness.deps.db, VISITOR_A, id, harness.clock.now())).toBeUndefined()
    await expect(readPagesView(harness.deps.db, VISITOR_A, id, harness.clock.now())).rejects.toMatchObject({ status: 404 })
    await expect(readFileView(harness.deps.db, VISITOR_A, id, harness.clock.now())).rejects.toMatchObject({ status: 404 })
    await expect(readReportView(harness.deps.db, VISITOR_A, id, harness.clock.now())).rejects.toMatchObject({ status: 404 })
    // Not yet swept: the row is still there, and the sweep takes it.
    expect((await rowsKept()).contracts).toBe(1)
    expect(await sweep(harness.deps)).toMatchObject({ deleted: 1 })
  })

  it('takes only what is expired: a contract made later, by someone else, stays', async () => {
    await finishedContract(VISITOR_A)
    harness.clock.advance(40 * 60_000)
    const later = await finishedContract(VISITOR_B, 'clean-supply')
    harness.clock.advance(25 * 60_000)

    const report = await sweep(harness.deps)

    expect(report.deleted).toBe(1)
    const left = await harness.query('SELECT id FROM lb04.contracts')
    expect(left).toEqual([{ id: later }])
  })

  it('is safe to run from several workers at the same moment: the contract is deleted once, with no error', async () => {
    await finishedContract(VISITOR_A)
    harness.clock.advance(61 * 60_000)

    const reports = await Promise.all([sweep(harness.deps), sweep(harness.deps), sweep(harness.deps)])

    expect(reports.reduce((total, report) => total + report.deleted, 0)).toBe(1)
    expect((await rowsKept()).contracts).toBe(0)
  })

  it('also removes the counters of days nothing reads any more', async () => {
    await harness.query(`INSERT INTO lb04.usage_counters (session_key, day, kind, used) VALUES ($1, '2026-09-20', 'contract', 3)`, [VISITOR_A])

    const report = await sweep(harness.deps)

    expect(report.counters).toBe(1)
  })
})

describe('a contract whose worker died', () => {
  /** Puts a contract into a state a review is in, with the time its last sign of life was. */
  async function stuck(id: string, state: string, minutesAgo: number): Promise<void> {
    const updated = new Date(harness.clock.now().getTime() - minutesAgo * 60_000)
    await harness.query(`UPDATE lb04.contracts SET state = $2, updated_at = $3 WHERE id = $1`, [id, state, updated])
  }

  it('is queued again once it has shown no sign of life for the stale time, and only then', async () => {
    harness.deps.review = referenceReview('wholesale-supply').review
    const view = await startContract(harness.deps, VISITOR_A, { from: 'sample', sampleId: 'wholesale-supply' })
    harness.scheduler.jobs.length = 0

    await stuck(view.id, 'analysing', 2)
    expect(await sweep(harness.deps)).toMatchObject({ requeued: 0 })

    await stuck(view.id, 'analysing', 6)
    expect(await sweep(harness.deps)).toMatchObject({ requeued: 1 })
    expect(harness.scheduler.requeued).toEqual([view.id])
  })

  it.each(['queued', 'extracting', 'analysing', 'verifying'])('is found whichever step it stopped in: %s', async (state) => {
    harness.deps.review = referenceReview('wholesale-supply').review
    const view = await startContract(harness.deps, VISITOR_A, { from: 'sample', sampleId: 'wholesale-supply' })
    await stuck(view.id, state, 10)

    expect(await sweep(harness.deps)).toMatchObject({ requeued: 1 })
  })

  it('is left alone when it has ended: a finished or a failed contract is nobody\'s to resume', async () => {
    await finishedContract(VISITOR_A)
    harness.deps.review = referenceReview('wholesale-supply').review
    const failed = (await startContract(harness.deps, VISITOR_B, { from: 'sample', sampleId: 'wholesale-supply' })).id
    await harness.query(`UPDATE lb04.contracts SET state = 'failed', failure_code = 'internal' WHERE id = $1`, [failed])
    await harness.query(`UPDATE lb04.contracts SET updated_at = $1`, [new Date(harness.clock.now().getTime() - 30 * 60_000)])
    harness.scheduler.jobs.length = 0

    expect(await sweep(harness.deps)).toMatchObject({ requeued: 0 })
  })

  it('is finished by the sweep and a worker without asking again for what the first attempt paid for', async () => {
    const { scripts } = referenceReview('wholesale-supply')
    // The rating model dies with a bug the engine can't classify: the attempt is lost, and the job with it.
    const crashing = new ScriptedModel(() => {
      throw new Error('the worker was killed')
    })
    harness.deps.review = { models: { ...scripts.models, reason: crashing }, guard: { check: async () => ({ flagged: false, score: 0.01 }) } }
    const view = await startContract(harness.deps, VISITOR_A, { from: 'sample', sampleId: 'wholesale-supply' })
    await expect(reviewJob(harness.deps, view.id, { number: 1, last: false })).rejects.toMatchObject({ name: 'ReviewRetry' })
    // The queue lost the job (a restart of Redis, a worker that died holding it): nothing is waiting.
    harness.scheduler.jobs.length = 0
    const saved = await harness.query('SELECT state, model_calls FROM lb04.contracts WHERE id = $1', [view.id])
    expect(saved[0]).toMatchObject({ state: 'verifying', model_calls: 2 })

    harness.clock.advance(6 * 60_000)
    expect(await sweep(harness.deps)).toMatchObject({ requeued: 1 })
    harness.deps.review = { models: scripts.models, guard: { check: forbiddenGuard } }
    await drive(harness)

    expect(await readContractView(harness.deps.db, VISITOR_A, view.id, harness.clock.now())).toMatchObject({ state: 'done' })
    // The long model was asked once in all: the notes the first attempt saved were used.
    expect(scripts.long.conversations).toHaveLength(1)
    expect(scripts.reason.conversations).toHaveLength(1)
    expect((await readReportView(harness.deps.db, VISITOR_A, view.id, harness.clock.now())).calls).toBe(3)
  })

  it('is not queued again when its hour is up: it is deleted instead', async () => {
    harness.deps.review = referenceReview('wholesale-supply').review
    await startContract(harness.deps, VISITOR_A, { from: 'sample', sampleId: 'wholesale-supply' })
    harness.scheduler.jobs.length = 0
    harness.clock.advance(61 * 60_000)

    const report = await sweep(harness.deps)

    expect(report).toMatchObject({ deleted: 1, requeued: 0 })
  })

  it('does not stop at a contract that can\'t be queued: it is logged, the others are queued, and the next sweep tries again', async () => {
    harness.deps.review = referenceReview('wholesale-supply').review
    const first = (await startContract(harness.deps, VISITOR_A, { from: 'sample', sampleId: 'wholesale-supply' })).id
    const second = (await startContract(harness.deps, VISITOR_B, { from: 'sample', sampleId: 'wholesale-supply' })).id
    harness.scheduler.jobs.length = 0
    await harness.query('UPDATE lb04.contracts SET updated_at = $1', [new Date(harness.clock.now().getTime() - 10 * 60_000)])
    const real = harness.scheduler.requeue.bind(harness.scheduler)
    let refused = 0
    harness.scheduler.requeue = async (id: string) => {
      if (id === first) {
        refused += 1
        throw new Error('redis is down')
      }
      await real(id)
    }

    const report = await sweep(harness.deps)

    expect(report.requeued).toBe(1)
    expect(refused).toBe(1)
    expect(harness.scheduler.requeued).toEqual([second])
  })
})
