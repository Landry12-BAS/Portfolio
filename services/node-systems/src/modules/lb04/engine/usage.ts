// A visitor's daily allowances: contracts reviewed, and files sent (the extractor is not a toy, so
// a file that is refused still counts as sent).
//
// A counter is one row per visitor, per UTC day and per kind, and it is only ever raised by one atomic
// statement that refuses to pass the limit, so two requests arriving together can't both take the
// last place. Counters outlive the contracts they counted: deleting a contract doesn't give a place
// back. A contract that fails (the file is refused, the model can't be reached) does: its place is
// released, once, by the one transition that fails it. Counters reset at 00:00 UTC, and the sweep
// removes old rows.
import { LB04_LIMITS } from '@lb/contracts'
import type { Lb04LimitsView } from '@lb/contracts'
import { and, eq, gt, lt, sql } from 'drizzle-orm'

import { AppError } from '../../../core/errors.ts'
import type { Executor } from '../db/connection.ts'
import { usageCounters } from '../db/schema.ts'

/** The two things a visitor's day is counted in. */
export type UsageKind = 'contract' | 'upload'

const MILLIS_PER_DAY = 86_400_000

/** Returns the UTC day a moment falls on, as `YYYY-MM-DD`. */
export function dayOf(moment: Date): string {
  return moment.toISOString().slice(0, 10)
}

/** Returns when the day that `moment` falls on ends: the next 00:00 UTC, when allowances reset. */
export function nextReset(moment: Date): Date {
  return new Date(Date.parse(`${dayOf(moment)}T00:00:00.000Z`) + MILLIS_PER_DAY)
}

/** Returns the daily limit for one kind of use. */
export function limitFor(kind: UsageKind): number {
  return kind === 'contract' ? LB04_LIMITS.contractsPerVisitorPerDay : LB04_LIMITS.uploadsPerVisitorPerDay
}

/** The error for a visitor who has used a day's allowance: 429, with when it starts again. */
export function dailyLimit(kind: UsageKind, moment: Date): AppError {
  const resetsAt = nextReset(moment).toISOString()
  if (kind === 'contract') return new AppError(429, 'daily_limit', `You have had ${LB04_LIMITS.contractsPerVisitorPerDay} contracts reviewed today, which is the limit. It starts again at 00:00 UTC.`, { resetsAt })
  return new AppError(429, 'upload_limit', `You have sent ${LB04_LIMITS.uploadsPerVisitorPerDay} files today, which is the limit. It starts again at 00:00 UTC.`, { resetsAt })
}

/**
 * Takes one place from the visitor's allowance for today, and tells whether there was one.
 * Call it inside the transaction that does the work, so work that fails gives its place back.
 */
export async function reserve(db: Executor, sessionKey: string, kind: UsageKind, moment: Date): Promise<boolean> {
  const taken = await db.insert(usageCounters)
    .values({ sessionKey, day: dayOf(moment), kind, used: 1 })
    .onConflictDoUpdate({
      target: [usageCounters.sessionKey, usageCounters.day, usageCounters.kind],
      set: { used: sql`${usageCounters.used} + 1` },
      // The statement that refuses to pass the limit: at the limit, it changes nothing and returns nothing.
      setWhere: lt(usageCounters.used, limitFor(kind)),
    })
    .returning({ used: usageCounters.used })
  return taken.length > 0
}

/**
 * Gives back a place taken with `reserve`, on the day it was taken, for work that failed through no
 * fault of the visitor's. A place that was never taken is not given back: the counter never goes below zero.
 */
export async function release(db: Executor, sessionKey: string, kind: UsageKind, takenOn: Date): Promise<void> {
  await db.update(usageCounters)
    .set({ used: sql`${usageCounters.used} - 1` })
    .where(and(eq(usageCounters.sessionKey, sessionKey), eq(usageCounters.day, dayOf(takenOn)), eq(usageCounters.kind, kind), gt(usageCounters.used, 0)))
}

/** Reads how much of today's allowance a visitor has used, for each kind. */
async function usedToday(db: Executor, sessionKey: string, moment: Date): Promise<Record<UsageKind, number>> {
  const rows = await db.select({ kind: usageCounters.kind, used: usageCounters.used })
    .from(usageCounters)
    .where(and(eq(usageCounters.sessionKey, sessionKey), eq(usageCounters.day, dayOf(moment))))
  const used: Record<UsageKind, number> = { contract: 0, upload: 0 }
  for (const row of rows) {
    if (row.kind === 'contract' || row.kind === 'upload') used[row.kind] = row.used
  }
  return used
}

/** Builds what the site shows of a visitor's day and of the system's limits: the contracts left, what the limits are, and when the allowance resets. */
export async function limitsOf(db: Executor, sessionKey: string, moment: Date): Promise<Lb04LimitsView> {
  const used = await usedToday(db, sessionKey, moment)
  const limit = limitFor('contract')
  return {
    contracts: { limit, used: used.contract, remaining: Math.max(0, limit - used.contract) },
    maxPages: LB04_LIMITS.maxPages,
    maxFileBytes: LB04_LIMITS.maxFileBytes,
    keptMinutes: LB04_LIMITS.keptMinutes,
    redlinesPerContract: LB04_LIMITS.redlinesPerContract,
    resetsAt: nextReset(moment).toISOString(),
  }
}

/** Removes the counters of days before yesterday, which nothing reads any more. Returns how many it removed. */
export async function removeOldCounters(db: Executor, moment: Date): Promise<number> {
  const cutoff = dayOf(new Date(moment.getTime() - MILLIS_PER_DAY))
  const removed = await db.delete(usageCounters).where(lt(usageCounters.day, cutoff)).returning({ day: usageCounters.day })
  return removed.length
}
