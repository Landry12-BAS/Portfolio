// LB-04's daily allowances on a real Postgres: three contracts and ten files a visitor a day, taken by one
// atomic statement so that requests arriving together can't both take the last place, given back once
// (and only once) by a contract that fails or could not be queued, and never given back by a delete.
// Races are what a fake database would get wrong, so every race here runs against the real one.
import { LB04_LIMITS } from '@lb/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'

import { dayOf, limitsOf, release, removeOldCounters, reserve } from '../../src/modules/lb04/engine/usage.ts'
import { startContract } from '../../src/modules/lb04/engine/service.ts'
import { deleteContractOf, failContract } from '../../src/modules/lb04/engine/store.ts'
import { createLb04Harness, referenceReview, VISITOR_A, VISITOR_B } from '../support/lb04-engine.ts'
import type { Lb04Harness } from '../support/lb04-engine.ts'
import { makePdf } from '../support/lb04-pdfs.ts'

let harness: Lb04Harness

beforeAll(async () => {
  harness = await createLb04Harness(inject('databaseUrl'), { review: referenceReview('wholesale-supply').review })
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
})

/** How much of today's allowance a visitor has used, by kind, read straight from the table. */
async function used(session: string, kind: 'contract' | 'upload'): Promise<number> {
  const rows = await harness.query('SELECT used FROM lb04.usage_counters WHERE session_key = $1 AND kind = $2', [session, kind])
  return Number(rows[0]?.used ?? 0)
}

/** Starts a review of a sample as a visitor. */
function startSample(session: string, sampleId = 'wholesale-supply') {
  return startContract(harness.deps, session, { from: 'sample', sampleId })
}

/** Starts a review of a small PDF the visitor sends. */
async function startUpload(session: string, filename = 'terms.pdf') {
  const bytes = await makePdf(1)
  return startContract(harness.deps, session, { from: 'upload', filename, contentBase64: Buffer.from(bytes).toString('base64') })
}

describe('the allowance of contracts', () => {
  it('is taken by one atomic statement: of ten requests at once, exactly three get a place', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => harness.database.db.transaction(tx => reserve(tx, VISITOR_A, 'contract', harness.clock.now()))))

    expect(results.filter(Boolean)).toHaveLength(LB04_LIMITS.contractsPerVisitorPerDay)
    expect(await used(VISITOR_A, 'contract')).toBe(LB04_LIMITS.contractsPerVisitorPerDay)
  })

  it('is counted for each visitor on their own', async () => {
    await Promise.all([VISITOR_A, VISITOR_B].flatMap(session => Array.from({ length: 5 }, () => reserve(harness.database.db, session, 'contract', harness.clock.now()))))

    expect(await used(VISITOR_A, 'contract')).toBe(3)
    expect(await used(VISITOR_B, 'contract')).toBe(3)
  })

  it('starts again at 00:00 UTC: the same visitor has three more places the next day', async () => {
    for (let taken = 0; taken < 3; taken += 1) await reserve(harness.database.db, VISITOR_A, 'contract', harness.clock.now())
    expect(await reserve(harness.database.db, VISITOR_A, 'contract', harness.clock.now())).toBe(false)

    harness.clock.set('2026-10-03T00:00:00.000Z')

    expect(await reserve(harness.database.db, VISITOR_A, 'contract', harness.clock.now())).toBe(true)
  })

  it('never goes below zero when a place is given back that was not taken, and gives one back to the day it was taken on', async () => {
    await release(harness.database.db, VISITOR_A, 'contract', harness.clock.now())
    expect(await used(VISITOR_A, 'contract')).toBe(0)

    await reserve(harness.database.db, VISITOR_A, 'contract', harness.clock.now())
    await release(harness.database.db, VISITOR_A, 'contract', harness.clock.now())
    await release(harness.database.db, VISITOR_A, 'contract', harness.clock.now())

    expect(await used(VISITOR_A, 'contract')).toBe(0)
  })
})

describe('starting reviews', () => {
  it('gives a visitor three samples a day and then answers 429 with the time the day ends, storing and queueing nothing more', async () => {
    for (let started = 0; started < 3; started += 1) await startSample(VISITOR_A)

    await expect(startSample(VISITOR_A)).rejects.toMatchObject({ status: 429, code: 'daily_limit', details: { resetsAt: '2026-10-03T00:00:00.000Z' } })

    const stored = await harness.query('SELECT count(*)::int AS found FROM lb04.contracts')
    expect(stored[0]?.found).toBe(3)
    expect(harness.scheduler.jobs).toHaveLength(3)
  })

  it('lets exactly three of six requests that arrive together be queued, and refuses the other three', async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => startSample(VISITOR_A)))

    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(3)
    const refused = outcomes.filter(outcome => outcome.status === 'rejected')
    expect(refused).toHaveLength(3)
    for (const outcome of refused) expect(outcome.reason).toMatchObject({ status: 429, code: 'daily_limit' })
    expect(harness.scheduler.jobs).toHaveLength(3)
    expect(await used(VISITOR_A, 'contract')).toBe(3)
  })

  it('counts a sample as a contract and not as a file sent, and an upload as both', async () => {
    await startSample(VISITOR_A)
    expect(await used(VISITOR_A, 'contract')).toBe(1)
    expect(await used(VISITOR_A, 'upload')).toBe(0)

    await startUpload(VISITOR_A)

    expect(await used(VISITOR_A, 'contract')).toBe(2)
    expect(await used(VISITOR_A, 'upload')).toBe(1)
  })

  it('takes nothing from a request that could not succeed: a file that is not a PDF, one that is too large and a sample that does not exist', async () => {
    const notAPdf = Buffer.from('this is not a pdf at all, it is plain text').toString('base64')
    const tooLarge = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(LB04_LIMITS.maxFileBytes)]).toString('base64')

    await expect(startContract(harness.deps, VISITOR_A, { from: 'upload', filename: 'a.pdf', contentBase64: notAPdf })).rejects.toMatchObject({ status: 415, code: 'not_a_pdf' })
    await expect(startContract(harness.deps, VISITOR_A, { from: 'upload', filename: 'a.pdf', contentBase64: tooLarge })).rejects.toMatchObject({ status: 413, code: 'file_too_large' })
    await expect(startSample(VISITOR_A, 'no-such-sample')).rejects.toMatchObject({ status: 404, code: 'unknown_sample' })

    expect(await used(VISITOR_A, 'contract')).toBe(0)
    expect(await used(VISITOR_A, 'upload')).toBe(0)
  })

  it('refuses a request when the service has no gateway, and takes nothing', async () => {
    const without = { ...harness.deps, review: undefined }

    await expect(startContract(without, VISITOR_A, { from: 'sample', sampleId: 'wholesale-supply' })).rejects.toMatchObject({ status: 503, code: 'analysis_unavailable' })

    expect(await used(VISITOR_A, 'contract')).toBe(0)
  })

  it('gives the places back, and leaves no contract behind, when the review could not be queued', async () => {
    harness.scheduler.failNextEnqueue(new Error('redis is down'))

    await expect(startUpload(VISITOR_A)).rejects.toMatchObject({ status: 503, code: 'queue_unavailable' })

    expect(await used(VISITOR_A, 'contract')).toBe(0)
    expect(await used(VISITOR_A, 'upload')).toBe(0)
    const stored = await harness.query('SELECT (SELECT count(*) FROM lb04.contracts)::int AS contracts, (SELECT count(*) FROM lb04.contract_files)::int AS files')
    expect(stored[0]).toEqual({ contracts: 0, files: 0 })
  })
})

describe('the allowance of files', () => {
  it('is ten a day, and a file that was refused still counts: only the contract\'s place comes back', async () => {
    const days = harness.clock.now()
    for (let sent = 0; sent < LB04_LIMITS.uploadsPerVisitorPerDay; sent += 1) {
      const view = await startUpload(VISITOR_A, `file-${sent}.pdf`)
      // The extraction refuses it, as it would a scan: the contract fails and gives its place back.
      expect(await failContract(harness.deps.db, view.id, 'no_text_layer', days)).toBe(true)
    }
    expect(await used(VISITOR_A, 'contract')).toBe(0)
    expect(await used(VISITOR_A, 'upload')).toBe(10)

    await expect(startUpload(VISITOR_A)).rejects.toMatchObject({ status: 429, code: 'upload_limit', details: { resetsAt: '2026-10-03T00:00:00.000Z' } })

    // A sample is not a file the visitor sent, so it still has its place.
    await expect(startSample(VISITOR_A)).resolves.toMatchObject({ state: 'queued' })
  })
})

describe('giving a place back', () => {
  it('happens once when a contract fails, however many times the failure is recorded, even at the same moment', async () => {
    const view = await startSample(VISITOR_A)
    expect(await used(VISITOR_A, 'contract')).toBe(1)

    const results = await Promise.all(Array.from({ length: 5 }, () => failContract(harness.deps.db, view.id, 'analysis_unavailable', harness.clock.now())))

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await used(VISITOR_A, 'contract')).toBe(0)
  })

  it('gives back to the day the contract was made on, even when the failure comes after midnight', async () => {
    harness.clock.set('2026-10-02T23:50:00.000Z')
    const view = await startSample(VISITOR_A)
    harness.clock.set('2026-10-03T00:10:00.000Z')

    await failContract(harness.deps.db, view.id, 'analysis_unavailable', harness.clock.now())

    const rows = await harness.query('SELECT day::text AS day, used FROM lb04.usage_counters WHERE session_key = $1', [VISITOR_A])
    expect(rows).toEqual([{ day: '2026-10-02', used: 0 }])
  })

  it('does not happen when the visitor deletes a contract: the place is spent', async () => {
    const view = await startSample(VISITOR_A)

    expect(await deleteContractOf(harness.deps.db, VISITOR_A, view.id)).toBe(true)

    expect(await used(VISITOR_A, 'contract')).toBe(1)
  })

  it('does not happen for a contract that has finished: a failure recorded for a done contract changes nothing', async () => {
    const view = await startSample(VISITOR_A)
    await harness.query(`UPDATE lb04.contracts SET state = 'done' WHERE id = $1`, [view.id])

    expect(await failContract(harness.deps.db, view.id, 'internal', harness.clock.now())).toBe(false)

    expect(await used(VISITOR_A, 'contract')).toBe(1)
  })
})

describe('what a visitor sees of their day', () => {
  it('says what is left, the limits, and when the allowance starts again', async () => {
    await startSample(VISITOR_A)
    await startSample(VISITOR_A)

    const limits = await limitsOf(harness.deps.db, VISITOR_A, harness.clock.now())

    expect(limits).toMatchObject({
      contracts: { limit: 3, used: 2, remaining: 1 },
      maxPages: 30,
      keptMinutes: 60,
      redlinesPerContract: 3,
      resetsAt: '2026-10-03T00:00:00.000Z',
    })
    expect(await limitsOf(harness.deps.db, VISITOR_B, harness.clock.now())).toMatchObject({ contracts: { used: 0, remaining: 3 } })
  })

  it('forgets the counters of days nobody reads any more, and keeps today\'s and yesterday\'s', async () => {
    for (const day of ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']) {
      await harness.query(`INSERT INTO lb04.usage_counters (session_key, day, kind, used) VALUES ($1, $2, 'contract', 1)`, [VISITOR_A, day])
    }

    const removed = await removeOldCounters(harness.deps.db, harness.clock.now())

    expect(removed).toBe(2)
    const left = await harness.query('SELECT day::text AS day FROM lb04.usage_counters ORDER BY day')
    expect(left.map(row => row.day)).toEqual(['2026-10-01', '2026-10-02'])
    expect(dayOf(harness.clock.now())).toBe('2026-10-02')
  })
})
