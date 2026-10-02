// Reading the recordings of the curated samples that a demo replays instead of spending quota
// (docs/PLAYBOOK.md, principle 5). A recording is read from where the site keeps them, checked
// with its schema, and shown only if it was made on the live back end and is the recording it
// says it is: a file that is another sample's, or a mock's, or malformed, is as good as missing.
import { isShowable, recordingSchema } from '@lb/contracts'
import type { Recording } from '@lb/contracts'

import type { SiteServices } from './services.ts'

/** The names a system and a sample may have: the same shapes the recording's schema allows. */
export const SYSTEM_NAME = /^lb-\d{2}$/
export const SAMPLE_NAME = /^[a-z0-9-]{1,60}$/

/** Reads one recording and returns it when it is valid, is where it says it is, and may be shown to a visitor. */
export async function showableRecording(site: SiteServices, system: string, sample: string): Promise<Recording | undefined> {
  const parsed = recordingSchema.safeParse(await site.recordings.read(system, sample))
  if (!parsed.success) return undefined
  const recording = parsed.data
  return recording.system === system && recording.sample === sample && isShowable(recording) ? recording : undefined
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
