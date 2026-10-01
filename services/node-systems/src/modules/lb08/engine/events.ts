// The log of a run: every state change is one event with a sequence number, so the log is
// the whole story of the run. It can be read live (the run page asks for what's new since
// the last number it saw), read afterwards, and played back step by step.
//
// Events are collected while a transaction works and written together just before it
// commits, numbered by the run's own counter. The caller already holds the run's row
// lock, so two transactions can't number events at once, and a sequence has no gaps:
// an event exists exactly when the change it describes was committed.
import type { NewRunEvent, RunEvent } from '@lb/contracts'
import { and, asc, eq, gt, sql } from 'drizzle-orm'

import type { Executor } from '../db/connection.ts'
import { runEvents, runs } from '../db/schema.ts'

// The most events one request may ask for. A run holds well under this: sixteen steps of a
// few events each.
const PAGE_SIZE = 500

/** Collects the events of one transaction and writes them, in order, when asked. */
export class RunLog {
  readonly #runId: string
  readonly #clock: () => Date
  readonly #pending: { event: NewRunEvent, at: Date }[] = []

  /** Starts an empty collection for a run. `clock` gives each event its time. */
  constructor(runId: string, clock: () => Date) {
    this.#runId = runId
    this.#clock = clock
  }

  /** Adds an event, stamped with the time it was recorded. */
  add(event: NewRunEvent): void {
    this.#pending.push({ event, at: this.#clock() })
  }

  /** Writes the collected events to the run's log, numbered after the last one, and empties the collection. */
  async flush(db: Executor): Promise<void> {
    const count = this.#pending.length
    if (count === 0) return
    const [counter] = await db.update(runs)
      .set({ eventSeq: sql`${runs.eventSeq} + ${count}` })
      .where(eq(runs.id, this.#runId))
      .returning({ last: runs.eventSeq })
    if (!counter) throw new Error('The run to log to does not exist.')
    const first = counter.last - count + 1
    await db.insert(runEvents).values(this.#pending.map(({ event, at }, index) => {
      const { type, ...data } = event
      return { runId: this.#runId, seq: first + index, at, type, nodeId: 'nodeId' in event ? event.nodeId : null, data }
    }))
    this.#pending.length = 0
  }
}

/** The shape of a stored event row. */
interface EventRow {
  seq: number
  at: Date
  type: string
  data: Record<string, unknown>
}

/** Rebuilds an event from its row: the stored fields, with its run, number, time and type put back. */
export function eventFromRow(runId: string, row: EventRow): RunEvent {
  return { ...row.data, seq: row.seq, at: row.at.toISOString(), runId, type: row.type } as RunEvent
}

/** Reads a run's events after sequence number `after` (0 for all of them), oldest first, up to a page. */
export async function readEvents(db: Executor, runId: string, after = 0): Promise<RunEvent[]> {
  const rows = await db.select({ seq: runEvents.seq, at: runEvents.at, type: runEvents.type, data: runEvents.data })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, after)))
    .orderBy(asc(runEvents.seq))
    .limit(PAGE_SIZE)
  return rows.map(row => eventFromRow(runId, row))
}
