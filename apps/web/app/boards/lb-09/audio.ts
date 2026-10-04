// What the board knows about audio before it sends any: which containers a browser's recorder writes
// and the service takes (told by their first bytes, as the service tells them), how a recording is
// turned into the base64 the API takes, and which recording format to ask the browser for. The
// service checks all of it again; this spares a visitor an upload it would refuse.

/** The containers the service decodes, told by their first bytes (services/django-systems/lb09/audio.py). */
export type Container = 'webm' | 'ogg' | 'mp4' | 'wav' | 'mp3'

/** The recording formats asked of the browser, best first: Opus in WebM (Chrome, Firefox), Opus in Ogg (Firefox), AAC in MP4 (Safari). */
export const PREFERRED_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'] as const

/** Tells a recording's container from its first bytes, or undefined for anything the service would refuse. */
export function sniffContainer(bytes: Uint8Array): Container | undefined {
  const starts = (...head: number[]) => head.every((byte, index) => bytes[index] === byte)
  const text = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  if (starts(0x1A, 0x45, 0xDF, 0xA3)) return 'webm'
  if (text(0, 4) === 'OggS') return 'ogg'
  if (bytes.length >= 12 && text(4, 8) === 'ftyp') return 'mp4'
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WAVE') return 'wav'
  if (text(0, 3) === 'ID3' || (bytes[0] === 0xFF && [0xFB, 0xFA, 0xF3, 0xF2].includes(bytes[1] ?? 0))) return 'mp3'
  return undefined
}

/** Picks the first recording format the browser supports, or undefined when it supports none the service takes. */
export function pickMimeType(isSupported: (mime: string) => boolean): string | undefined {
  return PREFERRED_MIME_TYPES.find(mime => isSupported(mime))
}

/** Writes bytes as standard base64, in slices so a megabyte does not blow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const slice = 0x8000
  for (let at = 0; at < bytes.length; at += slice) binary += String.fromCharCode(...bytes.subarray(at, at + slice))
  return btoa(binary)
}

/** A recording as the board holds it before sending: its bytes, its container, and a URL the player can play it from. */
export interface Recording {
  bytes: Uint8Array
  container: Container
  mimeType: string
}

/** Reads a recorded blob and tells its container; undefined when the service would refuse it. */
export async function readRecording(blob: Blob): Promise<Recording | undefined> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const container = sniffContainer(bytes)
  if (!container) return undefined
  return { bytes, container, mimeType: blob.type }
}
