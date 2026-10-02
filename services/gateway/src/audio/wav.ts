// A strict reader for the one audio format the speech-to-text route takes: a WAV file of
// 16-bit PCM, mono, at 16 kHz, which is what the systems normalise every recording to.
//
// The gateway has no audio decoder, so it can measure a recording only when its length
// is a plain function of its bytes. For this format it is: every second is exactly
// 32,000 bytes. The reader therefore believes the bytes and not the header: the file must
// be exactly what its header says it is (the RIFF size, the data chunk and the end of
// the file all agree), and the duration it reports is the data chunk's size divided by
// the byte rate. A caller cannot claim a short recording and send a long one.

/** Samples a second of the audio the gateway accepts. */
export const SAMPLE_RATE = 16_000
/** Bytes a second of that audio takes: 16-bit samples, one channel. */
export const BYTES_PER_SECOND = 32_000
/** The bytes before the audio in the plainest WAV file: the RIFF header, the `fmt ` chunk and the `data` chunk's header. */
export const WAV_HEADER_BYTES = 44

// A header that lists more chunks than this is not a recording from a recorder.
const MAX_CHUNKS = 8
// The `fmt ` chunk of plain PCM is exactly this long.
const FMT_BYTES = 16

/** Why a file is not the WAV the gateway takes. The message is safe to show the caller: it quotes no byte of the file. */
export class WavError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WavError'
  }
}

/** What a valid recording holds: the bytes of audio, and the seconds those bytes make. */
export interface WavInfo {
  dataBytes: number
  seconds: number
}

/** Reads four bytes at an offset as ASCII, for chunk names. */
function tag(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
}

/** Checks the `fmt ` chunk's fields: plain PCM, one channel, 16 kHz, 16 bits. */
function checkFormat(view: DataView, offset: number): void {
  const format = view.getUint16(offset, true)
  const channels = view.getUint16(offset + 2, true)
  const rate = view.getUint32(offset + 4, true)
  const byteRate = view.getUint32(offset + 8, true)
  const blockAlign = view.getUint16(offset + 12, true)
  const bits = view.getUint16(offset + 14, true)
  if (format !== 1 || channels !== 1 || rate !== SAMPLE_RATE || byteRate !== BYTES_PER_SECOND || blockAlign !== 2 || bits !== 16) {
    throw new WavError('The audio must be 16-bit PCM, mono, at 16 kHz.')
  }
}

/**
 * Reads a WAV file and returns the audio it holds, or throws a `WavError` saying what is
 * wrong. Any chunk may sit between `fmt ` and `data` (a recorder's `LIST`, say), but the
 * `data` chunk must be the last and must end exactly where the file does.
 */
export function readWav(bytes: Uint8Array): WavInfo {
  if (bytes.byteLength < WAV_HEADER_BYTES) throw new WavError('The file is too short to be a WAV recording.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (tag(view, 0) !== 'RIFF' || tag(view, 8) !== 'WAVE') throw new WavError('The audio must be a WAV file.')
  if (view.getUint32(4, true) !== bytes.byteLength - 8) throw new WavError('The WAV header does not match the size of the file.')

  let offset = 12
  let formatSeen = false
  for (let chunks = 0; chunks < MAX_CHUNKS && offset + 8 <= bytes.byteLength; chunks += 1) {
    const name = tag(view, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (name === 'fmt ') {
      if (size !== FMT_BYTES || body + size > bytes.byteLength) throw new WavError('The audio must be 16-bit PCM, mono, at 16 kHz.')
      checkFormat(view, body)
      formatSeen = true
    }
    else if (name === 'data') {
      if (!formatSeen) throw new WavError('The WAV file has audio before it says what the audio is.')
      if (body + size !== bytes.byteLength) throw new WavError('The WAV header does not match the size of the file.')
      if (size === 0 || size % 2 !== 0) throw new WavError('The WAV file holds no whole sample of audio.')
      return { dataBytes: size, seconds: size / BYTES_PER_SECOND }
    }
    // A chunk is padded to an even length, and must lie inside the file.
    offset = body + size + (size % 2)
    if (offset > bytes.byteLength) throw new WavError('The WAV header does not match the size of the file.')
  }
  throw new WavError('The WAV file has no audio.')
}
