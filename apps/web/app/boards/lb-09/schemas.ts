// What LB-09's API says, checked before the board uses any of it. The transcript and the items are the
// output of a transcriber and a model, so each field is bounded and typed here (docs/STACK.md: Zod at
// every boundary), and an answer that does not fit is treated as the system failing, never shown.
// Each schema is also checked against the type generated from the back end's OpenAPI document, so
// a field the back end adds or renames shows up as a type error here instead of a blank on the page.
import type { DjangoComponents } from '@lb/api-clients'
import { z } from 'zod'

/** The datasheet's limits, as the service enforces them (services/django-systems/lb09/limits.py). */
export const MAX_RECORDING_SECONDS = 60
export const RECORDINGS_PER_DAY = 5
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024

/** Where a meeting stands. */
export const STATUSES = ['received', 'processing', 'done', 'failed'] as const
/** The stages the worker reaches, in order, and the two it ends in. */
export const STAGES = ['received', 'decoding', 'transcribing', 'labelling', 'extracting', 'aligning', 'done', 'failed'] as const
/** The stages a meeting works through, in the order the page lists them. */
export const WORK_STAGES = ['decoding', 'transcribing', 'labelling', 'extracting', 'aligning'] as const
/** Why a meeting failed, as the service codes it (lb09/models.py, Meeting.Failure). */
export const FAILURES = ['undecodable', 'too_long', 'too_short', 'decode_limit', 'no_speech', 'transcriber', 'model', 'audio_gone', 'stale', 'pipeline_error'] as const
/** The two transcribers. */
export const MODES = ['fast', 'private'] as const

// A meeting's public ID: URL-safe characters, 16 to 24 of them.
const MEETING_ID = z.string().regex(/^[\w-]{16,24}$/)
// A moment in ISO 8601, with a `Z` or an offset: the server writes UTC.
const MOMENT = z.iso.datetime({ offset: true })
// Seconds from the start of a recording, which is at most a minute and a little.
const SECONDS = z.number().min(0).max(120)

/** One of the two modes. */
export const modeSchema = z.enum(MODES)
/** A stage of the worker. */
export const stageSchema = z.enum(STAGES)
/** A failure code. */
export const failureSchema = z.enum(FAILURES)

/** A meeting: where it stands, what was measured, which model ran, and the counters the page shows. */
export const meetingSchema = z.object({
  id: MEETING_ID,
  sample: z.string().max(80).nullable(),
  mode: modeSchema,
  status: z.enum(STATUSES),
  stage: stageSchema,
  failure: failureSchema.nullable(),
  run_id: z.string().max(64),
  language: z.string().max(2).nullable(),
  heard_language: z.string().max(40),
  transcriber: z.string().max(120),
  duration_seconds: SECONDS,
  source_bytes: z.int().nonnegative(),
  model_calls: z.int().nonnegative().max(10),
  dropped_items: z.int().nonnegative().max(100),
  labels_inferred_from_text: z.literal(true),
  created_at: MOMENT,
  updated_at: MOMENT,
  expires_at: MOMENT,
})

/** The visitor's meetings, newest first. */
export const meetingListSchema = z.array(meetingSchema).max(20)

/** What is left of the visitor's day, and the limits every recording is held to. */
export const limitsSchema = z.object({
  recordings_per_day: z.int().positive().max(100),
  used_today: z.int().nonnegative().max(100),
  left_today: z.int().nonnegative().max(100),
  resets_at: MOMENT,
  max_recording_seconds: z.number().positive().max(600),
  max_upload_bytes: z.int().positive(),
})

/** A curated sample as the API lists it. */
export const sampleSchema = z.object({
  key: z.string().max(80),
  title: z.string().max(60),
  about: z.string().max(300),
  file: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\.mp3$/),
  seconds: SECONDS,
  speakers: z.int().positive().max(6),
})

/** The curated samples. */
export const sampleListSchema = z.array(sampleSchema).max(20)

/** One stretch of speech, with the speaker the words suggest. */
export const segmentSchema = z.object({
  position: z.int().nonnegative().max(500),
  start: SECONDS,
  end: SECONDS,
  text: z.string().max(1_000),
  speaker: z.int().nonnegative().max(20),
  label: z.string().max(40),
})

/** A finished meeting's transcript. */
export const transcriptSchema = z.object({
  meeting: MEETING_ID,
  labels_note: z.string().max(200),
  segments: z.array(segmentSchema).max(500),
})

/** A decision or an action item, with its verbatim evidence and the seconds it was said in. */
export const itemSchema = z.object({
  position: z.int().nonnegative().max(100),
  kind: z.enum(['decision', 'action']),
  text: z.string().max(200),
  owner: z.string().max(60).nullable(),
  deadline: z.string().max(60).nullable(),
  evidence: z.string().max(400),
  start: SECONDS,
  end: SECONDS,
  first_segment: z.int().nonnegative().max(500),
  last_segment: z.int().nonnegative().max(500),
})

/** A finished meeting's items, and how many the checks dropped. */
export const itemsSchema = z.object({
  meeting: MEETING_ID,
  dropped: z.int().nonnegative().max(100),
  items: z.array(itemSchema).max(100),
})

/** What starting a meeting takes. */
export interface MeetingRequest {
  source: 'upload' | 'sample'
  mode: Mode
  audio?: string | null
  sample?: string | null
  language?: 'en' | 'cs' | null
}

/** One of the two modes. */
export type Mode = (typeof MODES)[number]
/** A stage of the worker. */
export type Stage = (typeof STAGES)[number]
/** A failure code. */
export type Failure = (typeof FAILURES)[number]
/** A meeting as the API describes it. */
export type Meeting = z.infer<typeof meetingSchema>
/** The visitor's day. */
export type Limits = z.infer<typeof limitsSchema>
/** A curated sample as the API lists it. */
export type Sample = z.infer<typeof sampleSchema>
/** One segment of a transcript. */
export type Segment = z.infer<typeof segmentSchema>
/** A finished meeting's transcript. */
export type Transcript = z.infer<typeof transcriptSchema>
/** One item. */
export type Item = z.infer<typeof itemSchema>
/** A finished meeting's items. */
export type Items = z.infer<typeof itemsSchema>

// The checks against the back end's own document: each one compiles only while what a schema
// produces has every field the document requires (and a compatible type for it). They exist for
// the type checker and cost nothing at run time.

/** The shapes the back end's OpenAPI document defines. */
type Schemas = DjangoComponents['schemas']
/** Fails to compile unless its argument is `true`. */
type Assert<T extends true> = T
/** The agreements between these schemas and the OpenAPI document, one for each shape the board reads or sends. */
export type OpenApiChecks = [
  Assert<Meeting extends Schemas['MeetingOut'] ? true : false>,
  Assert<Limits extends Schemas['LimitsOut'] ? true : false>,
  Assert<Sample extends Schemas['SampleOut'] ? true : false>,
  Assert<Transcript extends Schemas['TranscriptOut'] ? true : false>,
  Assert<Segment extends Schemas['SegmentOut'] ? true : false>,
  Assert<Items extends Schemas['ItemsOut'] ? true : false>,
  Assert<Item extends Schemas['ItemOut'] ? true : false>,
  Assert<MeetingRequest extends Schemas['MeetingIn'] ? true : false>,
]

/** Tells whether a meeting has ended, well or badly. */
export function isOver(meeting: Pick<Meeting, 'status'>): boolean {
  return meeting.status === 'done' || meeting.status === 'failed'
}
