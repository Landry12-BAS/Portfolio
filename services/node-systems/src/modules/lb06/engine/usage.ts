// A visitor's daily allowance of incidents: one row per visitor, per UTC day, raised by one atomic
// statement that refuses to pass the limit, so two requests arriving together can't both take the
// one place. A counter outlives the incident it counted; an incident the service could not start
// (no room, no queue) gives its place back, once, in the transaction that withdraws it.
import { LB06_LIMITS } from '@lb/contracts'
import { and, eq, gt, lt, sql } from 'drizzle-orm'

import { AppError } from '../../../core/errors.ts'
import type { Executor } from '../db/connection.ts'
import { usageCounters } from '../db/schema.ts'

const MILLIS_PER_DAY = 86_400_000
const KIND = 'incident'

/** Returns the UTC day a moment falls on, as `YYYY-MM-DD`. */
export function dayOf(moment: Date): string {
  return moment.toISOString().slice(0, 10)
}

/** Returns when the day that `moment` falls on ends: the next 00:00 UTC, when allowances reset. */
export function nextReset(moment: Date): Date {
  return new Date(Date.parse(`${dayOf(moment)}T00:00:00.000Z`) + MILLIS_PER_DAY)
}

/** The error for a visitor who has had today's incident: 429, with when it starts again, as a time (`resets_at`) and as a wait (`Retry-After`). */
export function dailyLimit(moment: Date): AppError {
  const reset = nextReset(moment)
  return new AppError(429, 'daily_limit', `You have started ${LB06_LIMITS.incidentsPerVisitorPerDay} incident today, which is the limit. It starts again at 00:00 UTC.`, {
    resetsAt: reset.toISOString(),
    retryAfterSeconds: Math.ceil((reset.getTime() - moment.getTime()) / 1_000),
  })
}

/** Takes the visitor's place for today, and tells whether there was one. Call it inside the transaction that does the work. */
export async function reserve(db: Executor, sessionKey: string, moment: Date): Promise<boolean> {
  const taken = await db.insert(usageCounters)
    .values({ sessionKey, day: dayOf(moment), kind: KIND, used: 1 })
    .onConflictDoUpdate({
      target: [usageCounters.sessionKey, usageCounters.day, usageCounters.kind],
      set: { used: sql`${usageCounters.used} + 1` },
      // The statement that refuses to pass the limit: at the limit, it changes nothing and returns nothing.
      setWhere: lt(usageCounters.used, LB06_LIMITS.incidentsPerVisitorPerDay),
    })
    .returning({ used: usageCounters.used })
  return taken.length > 0
}

/** Gives back a place taken with `reserve`, on the day it was taken, for an incident that never ran. The counter never goes below zero. */
export async function release(db: Executor, sessionKey: string, takenOn: Date): Promise<void> {
  await db.update(usageCounters)
    .set({ used: sql`${usageCounters.used} - 1` })
    .where(and(eq(usageCounters.sessionKey, sessionKey), eq(usageCounters.day, dayOf(takenOn)), eq(usageCounters.kind, KIND), gt(usageCounters.used, 0)))
}

/** Reads how many incidents the visitor has started today. */
export async function usedToday(db: Executor, sessionKey: string, moment: Date): Promise<number> {
  const rows = await db.select({ used: usageCounters.used })
    .from(usageCounters)
    .where(and(eq(usageCounters.sessionKey, sessionKey), eq(usageCounters.day, dayOf(moment)), eq(usageCounters.kind, KIND)))
  return rows[0]?.used ?? 0
}

/** Removes the counters of days before yesterday, which nothing reads any more. Returns how many it removed. */
export async function removeOldCounters(db: Executor, moment: Date): Promise<number> {
  const cutoff = dayOf(new Date(moment.getTime() - MILLIS_PER_DAY))
  const removed = await db.delete(usageCounters).where(lt(usageCounters.day, cutoff)).returning({ day: usageCounters.day })
  return removed.length
}
