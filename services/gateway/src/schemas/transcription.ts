// The speech-to-text request's fields, and what the two kinds of provider answer. The
// gateway turns either answer into one shape, so a caller never has to know which
// provider served it.
import { z } from 'zod'

/** The most segments one recording can have: the longest allowed one holds about a minute of speech. */
export const MAX_SEGMENTS = 600
// Caps on text, so a provider that runs away cannot fill the gateway's memory or the caller's.
const MAX_SEGMENT_TEXT = 2_000
const MAX_TRANSCRIPT_TEXT = 40_000

/**
 * The fields of a transcription request, besides the file. Anything else a client sends,
 * such as `prompt` or `timestamp_granularities[]`, is dropped: the gateway always asks
 * for segments at temperature 0 and gives the model no text to continue.
 */
export const transcriptionFieldsSchema = z.object({
  model: z.string().min(1).max(64),
  // The segments' times are what callers need, so this is the only format on offer.
  response_format: z.literal('verbose_json').default('verbose_json'),
  // ISO 639-1 (or 639-3) code, such as `en` or `cs`; left out, the model detects it.
  language: z.string().regex(/^[a-z]{2,3}$/, 'a lowercase language code such as en or cs').optional(),
})

/** A validated transcription request, without its file. */
export type TranscriptionFields = z.infer<typeof transcriptionFieldsSchema>

// One segment as a provider reports it. The two optional numbers help a caller drop the
// text Whisper invents over silence.
const segmentSchema = z.looseObject({
  start: z.number().min(0),
  end: z.number().min(0),
  text: z.string().max(MAX_SEGMENT_TEXT),
  avg_logprob: z.number().optional(),
  no_speech_prob: z.number().min(0).max(1).optional(),
})

/** The OpenAI-style `verbose_json` answer, which Groq gives. */
export const openaiTranscriptionSchema = z.looseObject({
  text: z.string().max(MAX_TRANSCRIPT_TEXT),
  language: z.string().max(40).optional(),
  segments: z.array(segmentSchema).max(MAX_SEGMENTS),
})

/** Workers AI's answer on its own endpoint, inside Cloudflare's success envelope. */
export const workersTranscriptionSchema = z.looseObject({
  success: z.literal(true),
  result: z.looseObject({
    text: z.string().max(MAX_TRANSCRIPT_TEXT),
    segments: z.array(segmentSchema).max(MAX_SEGMENTS),
    transcription_info: z.looseObject({ language: z.string().max(40).optional() }).optional(),
  }),
})

/** One stretch of speech, as the gateway reports it. Times are seconds from the start of the recording. */
export interface TranscriptSegment {
  id: number
  start: number
  end: number
  text: string
  avg_logprob?: number
  no_speech_prob?: number
}

/** What a caller gets back: the same shape whichever provider served the call. */
export interface Transcript {
  task: 'transcribe'
  language: string
  // Measured by the gateway from the recording's bytes, never taken from the provider.
  duration: number
  text: string
  segments: TranscriptSegment[]
}
