// Reading the recordings of the curated samples that a demo replays instead of spending quota
// (docs/PLAYBOOK.md, principle 5). A recording is read from where the site keeps them, checked
// with its schema, and shown only if it was made on the live back end and is the recording it
// says it is: a file that is another sample's, or a mock's, or malformed, is as good as missing.
// The one exception is the end-to-end test build, which also shows recordings made on the test
// mock, so the journeys can drive the replay player. That build is a separate bundle (its flag
// is replaced at build time), and a recording that says it came from the mock says so on the
// board, so no visitor of the real site can be shown one.
import { isShowable, recordingSchema } from '@lb/contracts'
import type { Recording } from '@lb/contracts'

import type { SiteServices } from './services.ts'

/** The names a system and a sample may have: the same shapes the recording's schema allows. */
export const SYSTEM_NAME = /^lb-\d{2}$/
export const SAMPLE_NAME = /^[a-z0-9-]{1,60}$/

/** Tells whether a recording may be shown here: one from the live back end, or, in the end-to-end test build only, one from the test mock. */
function mayShow(recording: Recording): boolean {
  return isShowable(recording) || (__LB_TEST_BUILD__ && recording.origin === 'mock')
}

/** Reads one recording and returns it when it is valid, is where it says it is, and may be shown to a visitor. */
export async function showableRecording(site: SiteServices, system: string, sample: string): Promise<Recording | undefined> {
  const parsed = recordingSchema.safeParse(await site.recordings.read(system, sample))
  if (!parsed.success) return undefined
  const recording = parsed.data
  return recording.system === system && recording.sample === sample && mayShow(recording) ? recording : undefined
}

/** Lists the samples of a system that have a recording a visitor may be shown, in name order. */
export async function showableSamples(site: SiteServices, system: string): Promise<string[]> {
  const names = (await site.recordings.list(system)).filter(name => SAMPLE_NAME.test(name)).sort()
  const shown: string[] = []
  for (const name of names) {
    if (await showableRecording(site, system, name)) shown.push(name)
  }
  return shown
}
