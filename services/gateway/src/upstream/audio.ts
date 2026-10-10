// How a recording is sent to a provider's speech-to-text model. Groq takes the OpenAI
// multipart request; Workers AI takes JSON with the audio in base64, on its own endpoint.
// Both are asked for segments with times, at temperature 0, and neither is given a prompt
// to continue.
import type { Model } from '../routing/load.ts'

/** A recording to transcribe: the WAV file, and the language when the caller knows it. */
export interface Recording {
  wav: Uint8Array
  language: string | undefined
}

/** Builds the OpenAI-style multipart request for one model. The boundary and the content type are fetch's to set. */
export function transcriptionForm(model: Model, recording: Recording): FormData {
  const form = new FormData()
  form.append('file', new Blob([recording.wav], { type: 'audio/wav' }), 'recording.wav')
  form.append('model', model.id)
  form.append('response_format', 'verbose_json')
  form.append('temperature', '0')
  if (recording.language !== undefined) form.append('language', recording.language)
  return form
}

/** Builds the JSON request Workers AI's `/ai/run` takes for a Whisper model: the audio in base64. */
export function transcriptionRunBody(recording: Recording): Record<string, unknown> {
  return {
    audio: Buffer.from(recording.wav).toString('base64'),
    task: 'transcribe',
    ...(recording.language === undefined ? {} : { language: recording.language }),
  }
}
