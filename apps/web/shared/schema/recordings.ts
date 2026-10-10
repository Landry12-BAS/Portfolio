// What the site's server says about the recordings of a system's curated samples: which samples
// have one a visitor may be shown. The recording itself is `recordingSchema` in @lb/contracts.
import { z } from 'zod'

/** The samples of one system that have a recording, such as `{ system: 'lb-01', samples: ['torn-bag'] }`. */
export const recordingListSchema = z.strictObject({
  system: z.string().regex(/^lb-\d{2}$/),
  samples: z.array(z.string().regex(/^[a-z0-9-]{1,60}$/)).max(100),
})

/** The samples of one system that have a recording. */
export type RecordingList = z.infer<typeof recordingListSchema>
