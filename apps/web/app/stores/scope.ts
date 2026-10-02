// The Scope's data: the spans of the run a board is showing, read by polling the site's trace
// route while the run is live (spans arrive as steps finish, the run's root span last), or handed
// over whole by the replay player. The timeline component draws from this store and nothing else.
// A read of a trace is open to anyone who has the run's ID, so it needs no session.
import { tracePageSchema } from '@lb/contracts'
import type { Span } from '@lb/contracts'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

import { getJson } from '~/board-kit/api'
import { GIVE_UP_AFTER_MS, FIRST_READ_DELAY_MS, SETTLE_AFTER_MS, mergeSpans, readDelay } from '~/board-kit/follow'
import { isApiProblem } from '~/board-kit/problem'
import { buildTimeline } from '~/board-kit/timeline'

/**
 * Where the Scope's reading stands: nothing to show, following a run, finished (the run's root span
 * arrived), stalled (the trace stopped arriving), missing (no trace exists for the run, or it has
 * expired) or failed (the site could not be reached).
 */
export type ScopePhase = 'idle' | 'following' | 'finished' | 'stalled' | 'missing' | 'failed'

/** How the Scope follows one run. */
export interface FollowOptions {
  // How long a "not found" is taken to mean "not yet": a run's first span appears a moment after it starts.
  notFoundGraceMs?: number
}

// Reads that fail for another reason are tried again this many times in a row before the Scope gives up.
const FAILURES_ALLOWED = 3

/** The trace of the run a board is showing. */
export const useScopeStore = defineStore('scope', () => {
  const runId = ref<string>()
  const spans = shallowRef<readonly Span[]>([])
  const phase = ref<ScopePhase>('idle')
  // Whether the spans are a recording being replayed, not a run being read.
  const replayed = ref(false)

  const timeline = computed(() => buildTimeline(spans.value))

  // Which reading is current: a newer one makes every older one stop touching the store.
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  // The moment past which the current reading gives up if the run has not ended.
  let deadline = 0

  /** Stops any reading in progress. */
  function stop(): void {
    generation += 1
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  /** Empties the Scope, for a board that is about to start another run. */
  function clear(): void {
    stop()
    runId.value = undefined
    spans.value = []
    phase.value = 'idle'
    replayed.value = false
  }

  /** Waits, then reads again, unless this reading has been replaced. */
  function readAgainIn(delayMs: number, reading: number, read: () => Promise<void>): void {
    timer = setTimeout(() => {
      timer = undefined
      if (reading === generation) void read()
    }, delayMs)
  }

  /** What to do when a read found the trace: keep it, and either finish or wait for more. */
  function took(page: { spans: Span[], cursor: string, more: boolean, finished: boolean }, quietReads: number): { done: boolean, quietReads: number, delay: number, cursor: string } {
    const merged = mergeSpans(spans.value, page.spans)
    spans.value = merged.spans
    const quiet = merged.added > 0 ? 0 : quietReads + 1
    if (page.finished) {
      phase.value = 'finished'
      return { done: true, quietReads: quiet, delay: 0, cursor: page.cursor }
    }
    return { done: false, quietReads: quiet, delay: readDelay({ more: page.more, added: merged.added, quietReads: quiet }), cursor: page.cursor }
  }

  /** Starts following a live run: reads its trace now and keeps reading until its root span arrives. */
  function follow(id: string, options: FollowOptions = {}): void {
    clear()
    runId.value = id
    phase.value = 'following'
    const reading = generation
    const startedAt = Date.now()
    deadline = startedAt + GIVE_UP_AFTER_MS
    const notFoundGraceMs = options.notFoundGraceMs ?? 0

    const read = async (cursor: string | undefined, quietReads: number, failures: number): Promise<void> => {
      const again = (delay: number, nextCursor: string | undefined, quiet: number, failed: number): void =>
        readAgainIn(delay, reading, () => read(nextCursor, quiet, failed))
      try {
        const query = cursor === undefined ? '' : `?after=${encodeURIComponent(cursor)}`
        const page = await getJson(`/api/runs/${encodeURIComponent(id)}/spans${query}`, tracePageSchema)
        if (reading !== generation) return
        const next = took(page, quietReads)
        if (next.done) return
        if (Date.now() > deadline) {
          phase.value = 'stalled'
          return
        }
        again(next.delay, next.cursor, next.quietReads, 0)
      }
      catch (error) {
        if (reading !== generation) return
        const notYet = isApiProblem(error) && error.kind === 'notFound' && Date.now() - startedAt < notFoundGraceMs
        if (notYet) return again(FIRST_READ_DELAY_MS * 2, cursor, quietReads + 1, failures)
        if (isApiProblem(error) && error.kind === 'notFound') {
          phase.value = spans.value.length > 0 ? 'stalled' : 'missing'
          return
        }
        if (failures + 1 >= FAILURES_ALLOWED) {
          phase.value = 'failed'
          return
        }
        again(readDelay({ more: false, added: 0, quietReads: quietReads + 1 }), cursor, quietReads + 1, failures + 1)
      }
    }
    readAgainIn(FIRST_READ_DELAY_MS, reading, () => read(undefined, 0, 0))
  }

  /** Tells the Scope the run is over, so it stops waiting for the root span after a few more seconds. */
  function settle(): void {
    deadline = Math.min(deadline, Date.now() + SETTLE_AFTER_MS)
  }

  /** Shows a recording's spans, as far as the replay has got. */
  function showRecorded(id: string, recorded: readonly Span[], finished: boolean): void {
    stop()
    runId.value = id
    spans.value = recorded
    replayed.value = true
    phase.value = finished ? 'finished' : 'following'
  }

  return { runId, spans, phase, replayed, timeline, follow, settle, showRecorded, stop, clear }
})
