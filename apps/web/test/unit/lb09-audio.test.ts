// Tests of what LB-09's board knows about audio before it sends any: the containers it tells by their
// first bytes (as the service tells them), the recording format it asks the browser for, base64 of a
// recording, and a blob read into a recording or refused.
import { describe, expect, it } from 'vitest'

import { pickMimeType, PREFERRED_MIME_TYPES, readRecording, sniffContainer, toBase64 } from '~/boards/lb-09/audio'

/** Bytes from a list of numbers, padded with zeros to a length. */
function bytes(head: number[], length = 16): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(length))
  out.set(head)
  return out
}

/** The bytes of a string. */
function text(value: string): number[] {
  return [...value].map(char => char.charCodeAt(0))
}

describe('telling a container by its first bytes', () => {
  it('knows WebM, Ogg, MP4, WAV and MP3', () => {
    expect(sniffContainer(bytes([0x1A, 0x45, 0xDF, 0xA3]))).toBe('webm')
    expect(sniffContainer(bytes(text('OggS')))).toBe('ogg')
    expect(sniffContainer(bytes([0, 0, 0, 0x18, ...text('ftypisom')]))).toBe('mp4')
    expect(sniffContainer(bytes([...text('RIFF'), 0, 0, 0, 0, ...text('WAVE')]))).toBe('wav')
    expect(sniffContainer(bytes(text('ID3')))).toBe('mp3')
    expect(sniffContainer(bytes([0xFF, 0xFB]))).toBe('mp3')
  })

  it('refuses anything else, including an empty recording and a text file', () => {
    expect(sniffContainer(new Uint8Array(0))).toBeUndefined()
    expect(sniffContainer(bytes(text('hello world')))).toBeUndefined()
    expect(sniffContainer(bytes([0x25, 0x50, 0x44, 0x46]))).toBeUndefined()
  })
})

describe('the recording format', () => {
  it('asks for Opus in WebM first, then what the browser has, and nothing the service would refuse', () => {
    expect(PREFERRED_MIME_TYPES[0]).toBe('audio/webm;codecs=opus')
    expect(pickMimeType(mime => mime === 'audio/mp4')).toBe('audio/mp4')
    expect(pickMimeType(() => true)).toBe('audio/webm;codecs=opus')
    expect(pickMimeType(() => false)).toBeUndefined()
  })
})

describe('reading a recording', () => {
  it('writes bytes as standard base64, even past one slice', () => {
    const many = new Uint8Array(70_000).map((_, index) => index % 251)
    const encoded = toBase64(many)
    expect(encoded).toMatch(/^[A-Z0-9+/]+=*$/i)
    expect(Uint8Array.from(atob(encoded), char => char.charCodeAt(0))).toEqual(many)
  })

  it('reads a blob into its bytes and container, or refuses one the service would refuse', async () => {
    const webm = await readRecording(new Blob([bytes([0x1A, 0x45, 0xDF, 0xA3])], { type: 'audio/webm' }))
    expect(webm?.container).toBe('webm')
    expect(webm?.mimeType).toBe('audio/webm')
    expect(webm?.bytes).toHaveLength(16)
    expect(await readRecording(new Blob(['not audio'], { type: 'text/plain' }))).toBeUndefined()
  })
})
