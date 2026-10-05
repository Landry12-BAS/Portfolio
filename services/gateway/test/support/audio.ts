// Helpers for the speech-to-text tests: WAV files of an exact length, and multipart bodies
// the way an OpenAI client writes them.
import { BYTES_PER_SECOND } from '../../src/audio/wav.ts'

/** Writes a WAV header for `dataBytes` bytes of audio, with any field of the format overridden. */
export function wavHeader(dataBytes: number, format: { code?: number, channels?: number, rate?: number, bits?: number } = {}): Buffer {
  const code = format.code ?? 1
  const channels = format.channels ?? 1
  const rate = format.rate ?? 16_000
  const bits = format.bits ?? 16
  const blockAlign = channels * bits / 8
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(code, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return header
}

/** Makes a valid recording of `seconds` of a quiet tone: 16-bit PCM, mono, 16 kHz. */
export function wav(seconds: number): Buffer {
  const dataBytes = Math.round(seconds * BYTES_PER_SECOND)
  const audio = Buffer.alloc(dataBytes)
  for (let sample = 0; sample < dataBytes / 2; sample += 1) audio.writeInt16LE(Math.round(1000 * Math.sin(sample / 20)), sample * 2)
  return Buffer.concat([wavHeader(dataBytes), audio])
}

/** A part of a form: a text field, or a file with its name and type. */
export type Part = { name: string, value: string } | { name: string, file: Buffer, filename?: string, type?: string }

/** Writes a multipart body, and the content type that names its boundary. */
export async function multipart(parts: readonly Part[]): Promise<{ payload: Buffer, contentType: string }> {
  const form = new FormData()
  for (const part of parts) {
    if ('file' in part) form.append(part.name, new Blob([part.file], { type: part.type ?? 'audio/wav' }), part.filename ?? 'recording.wav')
    else form.append(part.name, part.value)
  }
  const request = new Request('http://form.test/', { method: 'POST', body: form })
  return { payload: Buffer.from(await request.arrayBuffer()), contentType: request.headers.get('content-type') ?? '' }
}

/** The parts of an ordinary request for `lb-stt`: the model, and the recording. */
export function transcriptionParts(file: Buffer, extra: readonly Part[] = [], model = 'lb-stt'): Part[] {
  return [{ name: 'model', value: model }, { name: 'response_format', value: 'verbose_json' }, ...extra, { name: 'file', file }]
}
