// A visitor's daily allowance of runs: two a day, counted by one row per visitor, per UTC day and per
// kind, raised only by one atomic statement that refuses to pass the limit, so two requests arriving
// together cannot both take the last place. A run that the system could not start (no model, no
// browser, a plan refused before anything ran) gives its place back, once, by the one transition that
// fails it. Counters reset at 00:00 UTC, and the sweep removes old rows.
import { LB07_LIMITS } from '@lb/contracts'
import type { Lb07LimitsView } from '@lb/contracts'
import { and, eq, gt, lt, sql } from 'drizzle-orm'

import { AppError } from '../../../core/errors.ts'
import type { Executor } from '../db/connection.ts'
import { usageCounters } from '../db/schema.ts'

const MILLIS_PER_DAY = 86_400_000
const KIND = 'run'

/** Returns the UTC day a moment falls on, as `YYYY-MM-DD`. */
export function dayOf(moment: Date): string {
  return moment.toISOString().slice(0, 10)
}

/** Returns when the day that `moment` falls on ends: the next 00:00 UTC, when allowances reset. */
export function nextReset(moment: Date): Date {
  return new Date(Date.parse(`${dayOf(moment)}T00:00:00.000Z`) + MILLIS_PER_DAY)
}

/** The error for a visitor who has used the day's runs: 429, with when it starts again, as a time (`resets_at`) and as a wait (`Retry-After`). */
export function dailyLimit(moment: Date): AppError {
  const reset = nextReset(moment)
  return new AppError(429, 'daily_limit', `You have started ${LB07_LIMITS.runsPerVisitorPerDay} test runs today, which is the limit. It starts again at 00:00 UTC.`, {
    resetsAt: reset.toISOString(),
    retryAfterSeconds: Math.ceil((reset.getTime() - moment.getTime()) / 1_000),
  })
}

/** Takes one place from the visitor's allowance for today, inside the transaction that does the work, and tells whether there was one. */
export async function reserve(db: Executor, sessionKey: string, moment: Date): Promise<boolean> {
  const taken = await db.insert(usageCounters)
    .values({ sessionKey, day: dayOf(moment), kind: KIND, used: 1 })
    .onConflictDoUpdate({
      target: [usageCounters.sessionKey, usageCounters.day, usageCounters.kind],
      set: { used: sql`${usageCounters.used} + 1` },
      // The statement that refuses to pass the limit: at the limit, it changes nothing and returns nothing.
      setWhere: lt(usageCounters.used, LB07_LIMITS.runsPerVisitorPerDay),
    })
    .returning({ used: usageCounters.used })
  return taken.length > 0
}

/** Gives back a place taken with `reserve`, on the day it was taken, for a run the system could not start. The counter never goes below zero. */
export async function release(db: Executor, sessionKey: string, takenOn: Date): Promise<void> {
  await db.update(usageCounters)
    .set({ used: sql`${usageCounters.used} - 1` })
    .where(and(eq(usageCounters.sessionKey, sessionKey), eq(usageCounters.day, dayOf(takenOn)), eq(usageCounters.kind, KIND), gt(usageCounters.used, 0)))
}

/** Reads how many runs a visitor has started today. */
async function usedToday(db: Executor, sessionKey: string, moment: Date): Promise<number> {
  const [row] = await db.select({ used: usageCounters.used }).from(usageCounters).where(and(eq(usageCounters.sessionKey, sessionKey), eq(usageCounters.day, dayOf(moment)), eq(usageCounters.kind, KIND))).limit(1)
  return row?.used ?? 0
}

/** Builds what the site shows of a visitor's day and of the system's limits. */
export async function limitsOf(db: Executor, sessionKey: string, moment: Date): Promise<Lb07LimitsView> {
  const used = await usedToday(db, sessionKey, moment)
  const limit = LB07_LIMITS.runsPerVisitorPerDay
  return {
    runs: { limit, used, remaining: Math.max(0, limit - used) },
    maxGoalLength: LB07_LIMITS.maxGoalLength,
    runTimeSeconds: LB07_LIMITS.runTimeMs / 1_000,
    keptMinutes: LB07_LIMITS.keptMinutes,
    maxBugs: LB07_LIMITS.maxBugsPerRun,
    maxQueued: LB07_LIMITS.maxQueued,
    resetsAt: nextReset(moment).toISOString(),
  }
}

/** Removes the counters of days before yesterday, which nothing reads any more. Returns how many it removed. */
export async function removeOldCounters(db: Executor, moment: Date): Promise<number> {
  const cutoff = dayOf(new Date(moment.getTime() - MILLIS_PER_DAY))
  const removed = await db.delete(usageCounters).where(lt(usageCounters.day, cutoff)).returning({ day: usageCounters.day })
  return removed.length
}
