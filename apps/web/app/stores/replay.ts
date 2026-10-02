// The replay player's state: which samples of a system have a recording, the recording being
// shown, and whether it is still playing. A replay is always labelled as one, and it never touches
// the back end: the board hands this store a function that applies each recorded answer, and the
// store spreads them, and the recorded spans, over a few seconds (board-kit/replay.ts).
import { recordingSchema } from '@lb/contracts'
import type { Exchange, Recording } from '@lb/contracts'
import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'

import { recordingListSchema } from '#shared/schema/recordings'

import { getJson } from '~/board-kit/api'
import { planReplay, playReplay, spansInOrder } from '~/board-kit/replay'
import type { ReplayRun } from '~/board-kit/replay'
import { useScopeStore } from '~/stores/scope'

/** Whether the visitor's system asks for less motion, which also means no pacing of a replay. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** The recordings of the curated samples and the one being replayed. */
export const useReplayStore = defineStore('replay', () => {
  const scope = useScopeStore()

  // For each system, the samples that have a recording: undefined until the list has been read.
  const recorded = shallowRef<Record<string, readonly string[]>>({})
  const recording = shallowRef<Recording>()
  const playing = ref(false)
  let run: ReplayRun | undefined

  /** Reads which samples of a system have a recording. A failed read counts as none: the board offers the live run. */
  async function loadList(system: string): Promise<void> {
    try {
      const list = await getJson(`/api/recordings/${encodeURIComponent(system)}`, recordingListSchema)
      recorded.value = { ...recorded.value, [system]: list.samples }
    }
    catch {
      recorded.value = { ...recorded.value, [system]: [] }
    }
  }

  /** Tells whether a sample has a recording to replay. Unknown until `loadList` has run. */
  function hasRecording(system: string, sample: string): boolean {
    return recorded.value[system]?.includes(sample) === true
  }

  /** Reads one sample's recording from the site. */
  function read(system: string, sample: string): Promise<Recording> {
    return getJson(`/api/recordings/${encodeURIComponent(system)}/${encodeURIComponent(sample)}`, recordingSchema)
  }

  /** Stops a replay in progress. */
  function stop(): void {
    run?.stop()
    run = undefined
    playing.value = false
  }

  /** Forgets the recording, for a board that is about to run something else. */
  function clear(): void {
    stop()
    recording.value = undefined
  }

  /**
   * Plays a recording: hands the board each recorded exchange at its moment, and shows the
   * recorded spans in the Scope as they appear.
   */
  function start(toPlay: Recording, applyExchange: (index: number, exchange: Exchange) => void): void {
    stop()
    scope.clear()
    recording.value = toPlay
    playing.value = true
    run = playReplay(planReplay(toPlay, prefersReducedMotion()), {
      applyExchange: (index) => {
        const exchange = toPlay.exchanges[index]
        if (exchange) applyExchange(index, exchange)
      },
      showSpans: (count, finished) => {
        scope.showRecorded(toPlay.trace.runId, spansInOrder(toPlay).slice(0, count), finished)
        if (finished) playing.value = false
      },
    })
  }

  return { recorded, recording, playing, loadList, hasRecording, read, start, stop, clear }
})
