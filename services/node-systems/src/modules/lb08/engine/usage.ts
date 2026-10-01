// A visitor's daily allowances: workflow runs and workflow descriptions (the model calls).
//
// A counter is one row per visitor, per UTC day and per kind, and it is only ever raised by
// one atomic statement that refuses to pass the limit, so two requests arriving together
// can't both take the last place. Counters outlive the workflows they counted: deleting a
// workflow doesn't give a run back. They reset at 00:00 UTC, and the sweep removes old rows.
import { RUN_LIMITS } from '@lb/contracts'
import type { LimitsView } from '@lb/contracts'
import { and, eq, gt, lt, sql } from 'drizzle-orm'

import type { Executor } from '../db/connection.ts'
import { usageCounters } from '../db/schema.ts'

/** The two things a visitor's day is counted in. */
export type UsageKind = 'run' | 'generation'

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
  return kind === 'run' ? RUN_LIMITS.runsPerVisitorPerDay : RUN_LIMITS.generationsPerVisitorPerDay
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
 * Gives back a place taken with `reserve`, for work that failed through no fault of the
 * visitor's (the model could not be reached). A place that was never taken is not given
 * back: the counter never goes below zero.
 */
export async function release(db: Executor, sessionKey: string, kind: UsageKind, moment: Date): Promise<void> {
  await db.update(usageCounters)
    .set({ used: sql`${usageCounters.used} - 1` })
    .where(and(eq(usageCounters.sessionKey, sessionKey), eq(usageCounters.day, dayOf(moment)), eq(usageCounters.kind, kind), gt(usageCounters.used, 0)))
}

/** Reads how much of today's allowance a visitor has used, for each kind. */
async function usedToday(db: Executor, sessionKey: string, moment: Date): Promise<Record<UsageKind, number>> {
  const rows = await db.select({ kind: usageCounters.kind, used: usageCounters.used })
    .from(usageCounters)
    .where(and(eq(usageCounters.sessionKey, sessionKey), eq(usageCounters.day, dayOf(moment))))
  const used: Record<UsageKind, number> = { run: 0, generation: 0 }
  for (const row of rows) {
    if (row.kind === 'run' || row.kind === 'generation') used[row.kind] = row.used
  }
  return used
}

/** Builds what the site shows of a visitor's allowances: the limit, what is used and what is left, and when they reset. */
export async function limitsOf(db: Executor, sessionKey: string, moment: Date): Promise<LimitsView> {
  const used = await usedToday(db, sessionKey, moment)
  const allowance = (kind: UsageKind): LimitsView['runs'] => ({ limit: limitFor(kind), used: used[kind], remaining: Math.max(0, limitFor(kind) - used[kind]) })
  return { runs: allowance('run'), generations: allowance('generation'), resetsAt: nextReset(moment).toISOString() }
}

/** Removes the counters of days before yesterday, which nothing reads any more. Returns how many it removed. */
export async function removeOldCounters(db: Executor, moment: Date): Promise<number> {
  const cutoff = dayOf(new Date(moment.getTime() - MILLIS_PER_DAY))
  const removed = await db.delete(usageCounters).where(lt(usageCounters.day, cutoff)).returning({ day: usageCounters.day })
  return removed.length
}
