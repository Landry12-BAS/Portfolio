// Unit tests for the WAV reader that measures a recording: it believes the bytes and not
// the header, and refuses anything that is not exactly the audio the gateway takes.
import { describe, expect, it } from 'vitest'

import { BYTES_PER_SECOND, readWav, WavError } from '../../src/audio/wav.ts'
import { wav, wavHeader } from '../support/audio.ts'

/** Returns what reading the bytes throws, or undefined when they are a valid recording. */
function problemWith(bytes: Uint8Array): string | undefined {
  try {
    readWav(bytes)
  }
  catch (error) {
    if (error instanceof WavError) return error.message
    throw error
  }
  return undefined
}

describe('measuring a recording', () => {
  it('reads the seconds from the bytes of audio', () => {
    expect(readWav(wav(1))).toEqual({ dataBytes: BYTES_PER_SECOND, seconds: 1 })
    expect(readWav(wav(2.5)).seconds).toBe(2.5)
    expect(readWav(wav(60)).seconds).toBe(60)
  })

  it('accepts another chunk between the format and the audio, as recorders write one', () => {
    const audio = wav(1).subarray(44)
    const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')])
    const header = wavHeader(audio.length)
    // The format chunk, then the extra chunk, then the audio's own chunk header and bytes.
    const body = Buffer.concat([header.subarray(12, 36), list, header.subarray(36), audio])
    const file = Buffer.concat([header.subarray(0, 12), body])
    file.writeUInt32LE(file.length - 8, 4)

    expect(readWav(file).seconds).toBe(1)
  })
})

describe('refusing what is not that recording', () => {
  it('refuses a file too short to hold a header, and one that is not WAV', () => {
    expect(problemWith(Buffer.alloc(10))).toContain('too short')
    const notWave = wav(1)
    notWave.write('RIFX', 0, 'ascii')
    expect(problemWith(notWave)).toContain('must be a WAV file')
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100)])
    expect(problemWith(mp3)).toContain('must be a WAV file')
  })

  it('refuses any other format of audio, however it is spelled', () => {
    const wrong = [
      wavHeader(32_000, { code: 3 }),
      wavHeader(64_000, { channels: 2 }),
      wavHeader(32_000, { rate: 8_000 }),
      wavHeader(16_000, { bits: 8 }),
    ]
    for (const header of wrong) {
      expect(problemWith(Buffer.concat([header, Buffer.alloc(header.readUInt32LE(40))]))).toContain('16-bit PCM, mono, at 16 kHz')
    }
  })

  it('refuses a header that claims more or less audio than the file holds', () => {
    const file = wav(1)
    file.writeUInt32LE(BYTES_PER_SECOND * 100, 40)
    expect(problemWith(file)).toContain('does not match the size of the file')

    const shorter = wav(1)
    shorter.writeUInt32LE(BYTES_PER_SECOND / 2, 40)
    expect(problemWith(shorter)).toContain('does not match the size of the file')

    const riff = wav(1)
    riff.writeUInt32LE(7, 4)
    expect(problemWith(riff)).toContain('does not match the size of the file')
  })

  it('refuses bytes after the audio, which would otherwise be sent on unmeasured', () => {
    const file = Buffer.concat([wav(1), Buffer.alloc(64_000)])
    file.writeUInt32LE(file.length - 8, 4)

    expect(problemWith(file)).toContain('does not match the size of the file')
  })

  it('refuses a file with no audio, or half a sample of it', () => {
    expect(problemWith(wavHeader(0))).toContain('no whole sample')
    const odd = Buffer.concat([wavHeader(3), Buffer.alloc(3)])
    expect(problemWith(odd)).toContain('no whole sample')
  })

  it('refuses audio that comes before the format', () => {
    const file = wav(1)
    file.write('junk', 12, 'ascii')

    expect(problemWith(file)).toContain('audio before it says what the audio is')
  })

  it('stops reading chunks after a few, so a header cannot make the reader walk far', () => {
    const chunks = Array.from({ length: 12 }, () => Buffer.concat([Buffer.from('JUNK'), Buffer.from([0, 0, 0, 0])]))
    const header = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), ...chunks])
    header.writeUInt32LE(header.length - 8, 4)
    const file = Buffer.concat([header, Buffer.alloc(40)])
    file.writeUInt32LE(file.length - 8, 4)

    expect(problemWith(file)).toContain('no audio')
  })
})
