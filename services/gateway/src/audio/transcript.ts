// Reads a provider's transcription answer and turns it into the gateway's one shape. A
// provider's answer is untrusted: it is checked against a schema, its times are held to
// the recording's own length (which the gateway measured from the bytes), and an answer
// that cannot be made sense of fails the attempt, so the next model on the chain tries.
import type { Model } from '../routing/load.ts'
import { openaiTranscriptionSchema, workersTranscriptionSchema } from '../schemas/transcription.ts'
import type { Transcript, TranscriptSegment } from '../schemas/transcription.ts'

/** The most text a whole transcript may hold, which a minute of speech never reaches. */
const MAX_TRANSCRIPT_TEXT = 40_000

/** A segment as a provider sent it, once its shape has been checked. */
interface RawSegment {
  start: number
  end: number
  text: string
  avg_logprob?: number | undefined
  no_speech_prob?: number | undefined
}

/** What every provider's answer holds, whichever way it is wrapped. */
interface Reading {
  language: string
  segments: RawSegment[]
}

/** Reads the answer in the shape the model's API gives: Workers AI's envelope, or the OpenAI-style one. */
function reading(json: unknown, model: Model): Reading | undefined {
  if (model.api === 'run') {
    const parsed = workersTranscriptionSchema.safeParse(json)
    if (!parsed.success) return undefined
    const { result } = parsed.data
    return { language: result.transcription_info?.language ?? 'unknown', segments: result.segments }
  }
  const parsed = openaiTranscriptionSchema.safeParse(json)
  if (!parsed.success) return undefined
  return { language: parsed.data.language ?? 'unknown', segments: parsed.data.segments }
}

/** Rounds a time to the millisecond, which is as exact as a provider's own. */
function millis(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

/**
 * Cleans a provider's segments: a segment that ends before it starts is a corrupt answer
 * (undefined), one that starts after the recording ends is dropped, one that ends after it
 * is cut to its end, and an empty one is dropped. What is left is in order of its start.
 */
function cleanSegments(raw: readonly RawSegment[], seconds: number): TranscriptSegment[] | undefined {
  const kept: Omit<TranscriptSegment, 'id'>[] = []
  for (const segment of raw) {
    if (segment.end < segment.start) return undefined
    const text = segment.text.trim()
    if (text === '' || segment.start > seconds) continue
    kept.push({
      start: millis(segment.start),
      end: millis(Math.min(segment.end, seconds)),
      text,
      ...(segment.avg_logprob === undefined ? {} : { avg_logprob: segment.avg_logprob }),
      ...(segment.no_speech_prob === undefined ? {} : { no_speech_prob: segment.no_speech_prob }),
    })
  }
  kept.sort((a, b) => a.start - b.start)
  return kept.map((segment, id) => ({ id, ...segment }))
}

/**
 * Turns a provider's answer into a transcript of a recording that is `seconds` long, or
 * returns undefined when the answer is not one the gateway can stand behind.
 */
export function readTranscript(json: unknown, model: Model, seconds: number): Transcript | undefined {
  const answer = reading(json, model)
  if (!answer) return undefined
  const segments = cleanSegments(answer.segments, seconds)
  if (!segments) return undefined
  const text = segments.map(segment => segment.text).join(' ')
  if (text.length > MAX_TRANSCRIPT_TEXT) return undefined
  return { task: 'transcribe', language: answer.language, duration: seconds, text, segments }
}
