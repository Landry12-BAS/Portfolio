// Recording a curated sample: run it on a back end, read the run's trace from the gateway, and make
// the recording the board's replay player plays (packages/contracts/src/replay/recording.ts). What
// a system's sample does is the system's own runner; what a recording is, how it is labelled and
// where it is kept is the same for all. The label is never the recorder's to choose: a recording
// made on the test mock says `mock`, and only one made on a real back end says `live`, so nothing
// made on a mock can be shown to a visitor of the real site.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { recordingSchema, summariseTrace } from '@lb/contracts'
import type { Exchange, Recording } from '@lb/contracts'

import type { Backend } from './backend.ts'
import { runLb01Sample } from './lb01.ts'
import { runLb02Sample } from './lb02.ts'
import { runLb05Sample } from './lb05.ts'

/** What a system's runner hands back: the language of the sample, what the board asked and was told, and the run's ID. */
export interface RecordedRun {
  language: 'en' | 'cs'
  exchanges: Exchange[]
  runId: string
  // True for a run that has no root span because it goes on in turns (a conversation): its trace is complete, not finished.
  rootless?: boolean
}

/** Runs one sample of a system on a back end. */
export type SampleRunner = (backend: Backend, sample: string) => Promise<RecordedRun>

// One runner for each system that has a board. A system's board engineer adds theirs here (apps/web/README.md).
const RUNNERS: Readonly<Record<string, SampleRunner>> = {
  'lb-01': runLb01Sample,
  'lb-02': runLb02Sample,
  'lb-05': runLb05Sample,
}

// How long to wait for the gateway to have the whole trace once the run is over.
const TRACE_PATIENCE_MS = 30_000

/** Lists the systems the recorder can run. */
export function recordableSystems(): string[] {
  return Object.keys(RUNNERS)
}

/** Runs a sample on a back end and returns its recording, labelled by what the back end says it is. */
export async function recordSample(backend: Backend, system: string, sample: string): Promise<Recording> {
  const runner = Object.hasOwn(RUNNERS, system) ? RUNNERS[system] : undefined
  if (!runner) throw new Error(`There is no recorder for ${system} yet. Systems that have one: ${recordableSystems().join(', ')}.`)
  const origin = await backend.isMock() ? 'mock' : 'live'
  const run = await runner(backend, sample)
  const spans = await backend.readTrace(run.runId, TRACE_PATIENCE_MS, { rootless: run.rootless })
  const summary = summariseTrace(spans)
  return recordingSchema.parse({
    v: 1,
    system,
    sample,
    origin,
    recordedAt: new Date(backend.clock.now()).toISOString(),
    language: run.language,
    exchanges: run.exchanges,
    trace: { runId: run.runId, spans },
    stats: { modelCalls: summary.modelCalls, steps: summary.steps, durationMs: summary.durationMs },
  })
}

/** Where a recording is kept under a folder: `<system>/<sample>.json`. */
export function recordingFile(folder: string, recording: Recording): string {
  return join(folder, recording.system, `${recording.sample}.json`)
}

/** Writes a recording as readable JSON, creating its folder, and returns where it went. */
export function writeRecording(folder: string, recording: Recording): string {
  const file = recordingFile(folder, recording)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`)
  return file
}
